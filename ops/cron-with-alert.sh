#!/usr/bin/env bash
# cron-with-alert.sh: wrap a cron command, email on non-zero exit.
#
# Usage:
#   cron-with-alert.sh <jobname> <shell-command-string>
#
# Contract (do not weaken without review):
#   - Runs the command via `bash -c`. Output streams through UNCHANGED, so the
#     crontab line's own `>> log 2>&1` still captures everything.
#   - On non-zero exit, tries to send an alert through the transactional
#     email HTTP API. The alert is BEST EFFORT: if anything in the alert path
#     fails (env missing, key absent, network down, 4xx/5xx) it is logged to
#     stderr and swallowed.
#   - ALWAYS exits with the wrapped command's exit code, never the alerter's.
#   - Per-job cooldown: at most one email per job per CRON_ALERT_COOLDOWN_SECS
#     (a broken */5 job would otherwise send 288 emails a day). A successful
#     run clears the stamp, so the first failure after recovery alerts at once.
#   - Consecutive-failure gate: CRON_ALERT_MIN_CONSECUTIVE=N alerts only once
#     the job has failed N runs in a row (e.g. 2 for a flaky upstream feed).
#
# Env:
#   CRON_ALERT_ENV_FILE        file containing EMAIL_API_KEY=... (default: $APP_ROOT/.env)
#   CRON_ALERT_TO              recipient (required to send; otherwise logged only)
#   CRON_ALERT_FROM            sender (default "Ops Alerts <alerts@example.com>")
#   CRON_ALERT_API_URL         email API endpoint (default Resend-compatible)
#   CRON_ALERT_COOLDOWN_SECS   default 3600
#   CRON_ALERT_STATE_DIR       cooldown/streak stamps (default $APP_ROOT/logs/cron-alert-state)
#   CRON_ALERT_MIN_CONSECUTIVE default 1
#   CRON_ALERT_SUBJECT_PREFIX  default "[studio-os CRON FAILED]"

set -uo pipefail

JOB_NAME="${1:-unknown}"
JOB_CMD="${2:-}"
if [[ -z "$JOB_CMD" ]]; then
  echo "[cron-with-alert] ERROR: no command supplied (jobname=$JOB_NAME)" >&2
  exit 2
fi

APP_ROOT="${APP_ROOT:-/srv/studio-os/app}"
ENV_FILE="${CRON_ALERT_ENV_FILE:-$APP_ROOT/.env}"
ALERT_TO="${CRON_ALERT_TO:-}"
ALERT_FROM="${CRON_ALERT_FROM:-Ops Alerts <alerts@example.com>}"
ALERT_API_URL="${CRON_ALERT_API_URL:-https://api.resend.com/emails}"
COOLDOWN_SECS="${CRON_ALERT_COOLDOWN_SECS:-3600}"
STATE_DIR="${CRON_ALERT_STATE_DIR:-$APP_ROOT/logs/cron-alert-state}"
STAMP_FILE="$STATE_DIR/$(printf '%s' "$JOB_NAME" | tr -c 'a-zA-Z0-9._-' '_').last-alert"
STREAK_FILE="${STAMP_FILE%.last-alert}.fail-streak"
MIN_CONSECUTIVE="${CRON_ALERT_MIN_CONSECUTIVE:-1}"
[[ "$MIN_CONSECUTIVE" =~ ^[1-9][0-9]*$ ]] || MIN_CONSECUTIVE=1
SUBJECT_PREFIX="${CRON_ALERT_SUBJECT_PREFIX:-[studio-os CRON FAILED]}"

START_TS="$(date -Iseconds)"
TMP_OUT="$(mktemp -t cron-with-alert.XXXXXX)"
trap 'rm -f "$TMP_OUT"' EXIT

# tee keeps streaming to the caller; PIPESTATUS[0] is the wrapped exit code.
bash -c "$JOB_CMD" 2>&1 | tee "$TMP_OUT"
CMD_EXIT="${PIPESTATUS[0]}"

if [[ "$CMD_EXIT" -eq 0 ]]; then
  rm -f "$STAMP_FILE" "$STREAK_FILE" 2>/dev/null
  exit 0
fi

STREAK="$(cat "$STREAK_FILE" 2>/dev/null || echo 0)"
[[ "$STREAK" =~ ^[0-9]+$ ]] || STREAK=0
STREAK=$((STREAK + 1))
mkdir -p "$STATE_DIR" 2>/dev/null
echo "$STREAK" > "$STREAK_FILE" 2>/dev/null
if (( STREAK < MIN_CONSECUTIVE )); then
  echo "[cron-with-alert] alert deferred: consecutive failure $STREAK of $MIN_CONSECUTIVE job=$JOB_NAME exit=$CMD_EXIT" >&2
  exit "$CMD_EXIT"
fi

{
  NOW_EPOCH="$(date +%s)"
  LAST_EPOCH="$(cat "$STAMP_FILE" 2>/dev/null || echo 0)"
  [[ "$LAST_EPOCH" =~ ^[0-9]+$ ]] || LAST_EPOCH=0
  if (( NOW_EPOCH - LAST_EPOCH < COOLDOWN_SECS )); then
    echo "[cron-with-alert] alert suppressed (cooldown) job=$JOB_NAME exit=$CMD_EXIT" >&2
    exit "$CMD_EXIT"
  fi
  if [[ -z "$ALERT_TO" ]]; then
    echo "[cron-with-alert] alert skipped: CRON_ALERT_TO not set job=$JOB_NAME exit=$CMD_EXIT" >&2
  elif [[ ! -r "$ENV_FILE" ]]; then
    echo "[cron-with-alert] alert skipped: env file not readable job=$JOB_NAME exit=$CMD_EXIT" >&2
  else
    API_KEY="$(grep -E '^EMAIL_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"'" || true)"
    if [[ -z "${API_KEY:-}" ]]; then
      echo "[cron-with-alert] alert skipped: EMAIL_API_KEY not found job=$JOB_NAME exit=$CMD_EXIT" >&2
    else
      SUBJECT="$SUBJECT_PREFIX $JOB_NAME exited $CMD_EXIT"
      BODY="Cron job failed.

Job:       $JOB_NAME
Host:      $(hostname)
Started:   $START_TS
Ended:     $(date -Iseconds)
Exit code: $CMD_EXIT
Consecutive failures: $STREAK

Last 30 lines of output:
------------------------------------------------------------
$(tail -n 30 "$TMP_OUT" 2>/dev/null || echo '(no output captured)')
------------------------------------------------------------"
      PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"from":sys.argv[1],"to":sys.argv[2],"subject":sys.argv[3],"text":sys.argv[4]}))' \
        "$ALERT_FROM" "$ALERT_TO" "$SUBJECT" "$BODY" 2>/dev/null)"
      if [[ -z "$PAYLOAD" ]]; then
        echo "[cron-with-alert] alert skipped: payload encode failed job=$JOB_NAME" >&2
      elif curl --silent --show-error --fail --max-time 15 -X POST "$ALERT_API_URL" \
          -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1; then
        echo "[cron-with-alert] alert sent: $JOB_NAME exit=$CMD_EXIT" >&2
        echo "$NOW_EPOCH" > "$STAMP_FILE" 2>/dev/null
      else
        echo "[cron-with-alert] alert email failed job=$JOB_NAME exit=$CMD_EXIT" >&2
      fi
    fi
  fi
} || echo "[cron-with-alert] alert path crashed (swallowed) job=$JOB_NAME exit=$CMD_EXIT" >&2

# CRITICAL: always the wrapped command's code.
exit "$CMD_EXIT"
