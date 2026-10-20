#!/usr/bin/env bash
# Invoked by unit-failure-alert@.service (OnFailure=) with the failed unit name.
# Reuses cron-with-alert.sh so there is one alert path, one cooldown policy.
set -uo pipefail
UNIT="${1:?unit name}"
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/cron-with-alert.sh" "unit-failed:$UNIT" \
  "systemctl status --no-pager --lines=30 '$UNIT'; echo; echo 'Unit entered failed state (start-limit or crash)'; exit 1"
