# ADR 0003: Release identity and immutable cron releases

**Status:** accepted

## Context

One VPS ran the web tier with systemd and about 15 scheduled jobs with cron and timers. Two incidents shaped this decision:

- **Crash loop.** A port conflict crash-looped the web unit thousands of times over two days. `Restart=always` kept "recovering", so nobody was alerted.
- **Live edits.** Cron jobs ran TypeScript from the dev checkout. An uncommitted edit to a sweep script changed customer records before it was ever deployed.

A third failure mode was a restart after a checkout had moved ahead of its build. That left a process serving one commit's build from another commit's source.

## Decision

- Gate every deploy and every service start on **three identities equal to one SHA**: clean source, `BUILD_ID` on disk, and the `buildId` actually served. See `docs/release-identity.md`.
- Enforce the gates in **systemd** (`ExecStartPre`/`ExecStartPost`), not only in the deploy script, so manual restarts and reboots are covered too.
- Pair `StartLimitBurst` with `OnFailure=` alerting so a crash loop becomes a page, not a silent retry.
- Run all scheduled jobs from `releases/current`. It is a detached worktree at the verified SHA and is swapped atomically during deploy, so web and jobs switch together.
- Wrap every cron entry in `ops/cron-with-alert.sh`. It always preserves the exit code, applies a per-job cooldown, and has an optional consecutive-failure gate.
- There is no automatic rollback after a restart. A rollback is a deploy of a known-good SHA through the same gates.

## Consequences

- Uncommitted edits can no longer reach customers through cron.
- A `.next.previous` swap is not a valid rollback, because the guards refuse it. That is intentional.
- CI (`.github/workflows/ci.yml`) was added in this reference repo. In production the deploy script was the only gate.
