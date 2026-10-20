#!/usr/bin/env bash
# Install the version-controlled systemd drop-ins for the web service.
# Run as an administrator from the application root during deploy.
set -Eeuo pipefail
APP_ROOT="${APP_ROOT:-/srv/studio-os/app}"
SERVICE="${SERVICE_NAME:-studio-os}"
cd "$APP_ROOT"
install -d -m 0755 "/etc/systemd/system/$SERVICE.service.d"
for conf in release-identity.conf crash-loop-guard.conf; do
  install -m 0644 "ops/systemd/$SERVICE.service.d/$conf" "/etc/systemd/system/$SERVICE.service.d/$conf"
done
install -m 0644 ops/systemd/unit-failure-alert@.service /etc/systemd/system/unit-failure-alert@.service
systemctl daemon-reload
systemctl show "$SERVICE" -p ExecStartPre -p ExecStartPost -p StartLimitBurst -p OnFailure
