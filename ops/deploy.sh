#!/usr/bin/env bash
# deploy.sh: the ONLY way code reaches production (there was no CI/CD; this
# script was the gate, and .github/workflows/ci.yml now runs ahead of it).
#
# Order of operations:
#   1. repo flock: concurrent deploys are serialized, the loser exits 4
#   2. checkout + pull, capture HEAD, assert a clean tree at HEAD
#   3. install, prisma generate, re-assert the tree (tools must not dirty it)
#   4. build into .next.staging.<ts>; typecheck; assert BUILD_ID == HEAD
#      -> any failure here leaves the LIVE .next untouched
#   5. atomic swap: .next -> .next.previous.<ts>, staging -> .next
#   6. install systemd release guards; publish releases/<sha> for cron jobs
#   7. restart; verify served buildId + PID ownership; critical smoke suite
#   8. on failure after restart: write a warning file, email the operator,
#      and DO NOT auto-rollback (a rollback is a deploy of a known-good sha
#      through this same script, never a bare .next swap)
#
# Exit codes: 2 pre-restart failure (live untouched), 3 post-restart
# verification failure, 4 lock/checkout, 5 install/generate, 6 guards/publish/restart.
#
# Dry run: DEPLOY_DRY_RUN=1 replaces every side-effecting command with `true`.
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/srv/studio-os/app}"
BRANCH="${1:-${DEPLOY_BRANCH:-main}}"
SERVICE_NAME="${SERVICE_NAME:-studio-os}"
ENV_FILE="${DEPLOY_ENV_FILE:-$APP_ROOT/.env}"
STATE_DIR="${DEPLOY_STATE_DIR:-$APP_ROOT/logs/deploy}"
BUILD_LOG="$STATE_DIR/build.log"
WARNING_FILE="$STATE_DIR/post-restart-failed"
FAILURE_REPORT_FILE="$STATE_DIR/failure-report.txt"
DRY_RUN="${DEPLOY_DRY_RUN:-0}"
NEXT_LIVE=".next"
NEXT_STAGING_PREFIX=".next.staging"
NEXT_PREVIOUS_PREFIX=".next.previous"
PREVIOUS_KEEP="${DEPLOY_PREVIOUS_KEEP:-3}"
IDENTITY_URLS="${IDENTITY_URLS:-http://127.0.0.1:${APP_PORT:-3000}/login https://crm.example.com/login}"
LAST_PREVIOUS_BUILD_DIR=""

if [[ "$DRY_RUN" == "1" ]]; then
  INSTALL_CMD="true"; PRISMA_CMD="true"; BUILD_CMD="true"; TSC_CMD="true"
  RESTART_CMD="true"; INSTALL_GUARDS_CMD="true"; PUBLISH_RELEASE_CMD="true"
  SMOKE_CMD="true"; POST_RESTART_SLEEP=0
else
  INSTALL_CMD="${DEPLOY_INSTALL_COMMAND:-npm ci}"
  PRISMA_CMD="${DEPLOY_PRISMA_COMMAND:-npx prisma generate}"
  BUILD_CMD="${DEPLOY_BUILD_COMMAND:-npm run build}"
  TSC_CMD="${DEPLOY_TSC_COMMAND:-npx tsc --noEmit}"
  RESTART_CMD="${DEPLOY_RESTART_COMMAND:-sudo systemctl restart $SERVICE_NAME}"
  INSTALL_GUARDS_CMD="${DEPLOY_INSTALL_GUARDS_COMMAND:-sudo bash ops/install-release-guards.sh}"
  PUBLISH_RELEASE_CMD="${DEPLOY_PUBLISH_RELEASE_COMMAND:-bash ops/publish-release.sh}"
  SMOKE_CMD="${DEPLOY_SMOKE_COMMAND:-npx playwright test tests/smoke/critical}"
  POST_RESTART_SLEEP="${DEPLOY_POST_RESTART_SLEEP:-5}"
fi

cd "$APP_ROOT"
mkdir -p "$STATE_DIR"
exec 9>"$(git rev-parse --git-path studio-os-deploy.lock)"
flock -n 9 || { echo "Another deployment holds the repository lock." >&2; exit 4; }

if [[ -f "$WARNING_FILE" ]]; then
  echo "WARNING: the previous deploy restarted and then failed verification. Inspect $WARNING_FILE before re-running."
fi

run_cmd() { echo "==> $1"; bash -lc "$2"; }

notify() {
  # Best effort: never fails the deploy. Recipient and key come from env.
  local subject="$1" body="$2"
  if [[ "$DRY_RUN" == "1" || -z "${DEPLOY_NOTIFY_TO:-}" ]]; then
    echo "[notify] $subject"; return 0
  fi
  local key
  key="$(grep -E '^EMAIL_API_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'" || true)"
  [[ -n "$key" ]] || { echo "[notify] EMAIL_API_KEY missing; not sent"; return 0; }
  python3 -c 'import json,sys; print(json.dumps({"from":sys.argv[1],"to":[sys.argv[2]],"subject":sys.argv[3],"text":sys.argv[4]}))' \
    "${DEPLOY_NOTIFY_FROM:-Deploys <deploys@example.com>}" "$DEPLOY_NOTIFY_TO" "$subject" "$body" \
    | curl --silent --max-time 15 -X POST "${EMAIL_API_URL:-https://api.resend.com/emails}" \
        -H "Authorization: Bearer $key" -H "Content-Type: application/json" -d @- >/dev/null || true
}

rollback_instructions() {
  [[ -n "$LAST_PREVIOUS_BUILD_DIR" ]] || return 0
  cat <<EOF
Rollback artifact retained: $LAST_PREVIOUS_BUILD_DIR
Roll back by deploying a known-good commit through ops/deploy.sh. Do not just
rename .next.previous: the systemd release guards will (correctly) refuse a
build whose BUILD_ID does not match the checked-out commit.
EOF
}

fail_step() {
  local code="$1" step="$2" diagnostic="$3"
  {
    echo "Deploy aborted at step: $step"
    echo "Branch: $BRANCH"
    echo "HEAD: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "Diagnostic: $diagnostic"
    if [[ "$code" == "3" ]]; then
      echo
      echo "The service WAS restarted; only post-restart verification failed."
      echo "No automatic rollback. Fix forward or deploy a known-good sha."
      rollback_instructions
    fi
  } > "$FAILURE_REPORT_FILE"
  notify "Deploy aborted at $step" "$(cat "$FAILURE_REPORT_FILE")"
  exit "$code"
}

verify_identity() {
  local mode="$1" build_dir="${2:-$NEXT_LIVE}"
  if [[ "$DRY_RUN" == "1" ]]; then echo "DRY RUN: skip $mode identity"; return 0; fi
  if [[ "$mode" == "served" ]]; then
    local urls=(); read -r -a urls <<< "$IDENTITY_URLS"
    node ops/assert-build-identity.mjs served "$HEAD_COMMIT" "$build_dir" "${urls[@]}"
  else
    node ops/assert-build-identity.mjs "$mode" "$HEAD_COMMIT" "$build_dir"
  fi
}

atomic_build_swap() {
  local ts staging previous
  if [[ "$DRY_RUN" == "1" ]]; then echo "DRY RUN: skipping build + atomic swap"; return 0; fi
  ts="$(date +%Y%m%d-%H%M%S)"
  staging="$NEXT_STAGING_PREFIX.$ts"
  previous="$NEXT_PREVIOUS_PREFIX.$ts"
  rm -rf -- "$staging"

  echo "==> Building into $staging (live $NEXT_LIVE untouched)"
  if ! NEXT_DIST_DIR="$staging" bash -lc "set -o pipefail; $BUILD_CMD 2>&1 | tee '$BUILD_LOG'"; then
    rm -rf -- "$staging"; fail_step 2 "build" "Build failed; live build untouched. Log: $BUILD_LOG"
  fi
  if [[ "$DRY_RUN" != "1" && ! -f "$staging/BUILD_ID" ]]; then
    rm -rf -- "$staging"; fail_step 2 "build verification" "Staged build has no BUILD_ID."
  fi
  run_cmd "Typecheck" "$TSC_CMD" || { rm -rf -- "$staging"; fail_step 2 "typecheck" "TypeScript check failed; live build untouched."; }
  verify_identity build "$staging" || fail_step 2 "build identity" "Staged build differs from the captured commit."

  [[ -e "$previous" ]] && fail_step 2 "atomic swap" "Rollback dir already exists: $previous"
  if [[ -e "$NEXT_LIVE" ]]; then mv -- "$NEXT_LIVE" "$previous"; LAST_PREVIOUS_BUILD_DIR="$APP_ROOT/$previous"; fi
  if [[ -e "$staging" ]] && ! mv -- "$staging" "$NEXT_LIVE"; then
    [[ -e "$previous" && ! -e "$NEXT_LIVE" ]] && mv -- "$previous" "$NEXT_LIVE"
    fail_step 2 "atomic swap" "Could not move staged build into place; previous build restored."
  fi
  echo "==> Swap complete"

  # Keep the newest $PREVIOUS_KEEP rollback artifacts.
  find . -maxdepth 1 -type d -name "$NEXT_PREVIOUS_PREFIX.*" -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | awk -v keep="$PREVIOUS_KEEP" 'NR > keep { print $2 }' | xargs -r rm -rf --
}

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY RUN: would deploy branch $BRANCH"
else
  run_cmd "Checkout $BRANCH" "git checkout '$BRANCH'" || fail_step 4 "git checkout" "Could not checkout $BRANCH."
  run_cmd "Pull origin $BRANCH" "git pull --ff-only origin '$BRANCH'" || fail_step 4 "git pull" "Could not fast-forward $BRANCH."
fi

HEAD_COMMIT="$(git rev-parse HEAD)"
verify_identity source || fail_step 2 "source identity" "Deploy requires a clean tree at the captured commit."

run_cmd "Install dependencies" "$INSTALL_CMD" || fail_step 5 "install" "Dependency install failed."
run_cmd "Generate Prisma client" "$PRISMA_CMD" || fail_step 5 "prisma generate" "Prisma generate failed."
verify_identity source || fail_step 2 "source identity" "Install/generate modified tracked files."

atomic_build_swap

run_cmd "Install systemd release guards" "$INSTALL_GUARDS_CMD" || fail_step 6 "release guards" "Could not install pre/post start verification."
# Cron jobs run from releases/current; switch them together with the web tier.
run_cmd "Publish job release $HEAD_COMMIT" "$PUBLISH_RELEASE_CMD '$HEAD_COMMIT'" || fail_step 6 "publish release" "Jobs still run the previous release; nothing restarted."
run_cmd "Restart $SERVICE_NAME" "$RESTART_CMD" || fail_step 6 "restart" "systemctl restart failed (ExecStartPre/Post guards may have refused)."
sleep "$POST_RESTART_SLEEP"

if ! verify_identity served; then
  { echo "DEPLOYED-BUT-VERIFICATION-FAILED: served identity at $(date -Is)"; rollback_instructions; } > "$WARNING_FILE"
  fail_step 3 "served identity" "Source, disk build and served build must all equal $HEAD_COMMIT."
fi
if ! run_cmd "Critical smoke suite" "$SMOKE_CMD"; then
  { echo "DEPLOYED-BUT-VERIFICATION-FAILED: smoke at $(date -Is)"; rollback_instructions; } > "$WARNING_FILE"
  fail_step 3 "post-deploy smoke" "Critical smoke failed after restart."
fi

rm -f "$WARNING_FILE"
notify "Deploy complete" "Deployed and verified $HEAD_COMMIT"
echo "Deploy complete: served build, disk build and source all at $HEAD_COMMIT"
