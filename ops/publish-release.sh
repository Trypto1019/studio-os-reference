#!/usr/bin/env bash
# Publish the immutable job release for a verified deploy commit.
#
# Scheduled jobs (crontab, systemd oneshots) run TypeScript source through
# tsx. Running them from the dev checkout made every uncommitted edit live on
# the next cron tick (incident: an edited sweep script moved customers before
# any deploy). They run from $RELEASES_DIR/current instead: a detached git
# worktree at the exact commit deploy.sh verified, re-pointed only by deploy.
#
#   releases/<sha>    detached worktree at <sha>, clean
#   releases/current  symlink -> releases/<sha>, swapped atomically (mv -T)
#
# Shared with the source checkout by symlink: node_modules (a dependency bump
# is a deliberate install), .env (secrets stay in one 0600 file), logs/.
# Keeps the newest RELEASE_KEEP releases (default 3) for rollback.
#
# Usage: ops/publish-release.sh <40-char-commit-sha>
set -Eeuo pipefail

SHA="${1:?usage: publish-release.sh <commit-sha>}"
SOURCE_ROOT="${APP_ROOT:-/srv/studio-os/app}"
RELEASES="${RELEASES_DIR:-/srv/studio-os/releases}"
KEEP="${RELEASE_KEEP:-3}"
SHARED=(node_modules .env logs)

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "publish-release: expected a full 40-char sha, got '$SHA'" >&2; exit 2; }
git -C "$SOURCE_ROOT" cat-file -e "$SHA^{commit}" || { echo "publish-release: $SHA is not a commit in $SOURCE_ROOT" >&2; exit 2; }
mkdir -p "$RELEASES"
dir="$RELEASES/$SHA"

if [[ ! -d "$dir" ]]; then
  git -C "$SOURCE_ROOT" worktree add --detach "$dir" "$SHA" >/dev/null
fi
for name in "${SHARED[@]}"; do
  if [[ -e "$SOURCE_ROOT/$name" && ! -e "$dir/$name" ]]; then
    ln -s "$SOURCE_ROOT/$name" "$dir/$name"
  fi
done

# The release must be exactly the verified commit with no tracked changes.
actual="$(git -C "$dir" rev-parse HEAD)"
[[ "$actual" == "$SHA" ]] || { echo "publish-release: $dir is at $actual, expected $SHA" >&2; exit 3; }
if [[ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]]; then
  echo "publish-release: $dir has tracked changes; refusing" >&2; exit 3
fi

ln -sfn "$dir" "$RELEASES/.current.tmp"
mv -Tf "$RELEASES/.current.tmp" "$RELEASES/current"
echo "publish-release: current -> $SHA"

# Prune: keep the newest $KEEP release directories; never the current one.
mapfile -t old < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{40}' -printf '%T@ %p\n' \
  | sort -rn | awk -v keep="$KEEP" 'NR > keep { print $2 }')
current_target="$(readlink -f "$RELEASES/current")"
for path in "${old[@]}"; do
  [[ "$(readlink -f "$path")" == "$current_target" ]] && continue
  git -C "$SOURCE_ROOT" worktree remove --force "$path" && echo "publish-release: pruned $(basename "$path")"
done
