# Release identity

**Invariant:** the commit that was verified is the commit that runs. That holds for the web process and for every scheduled job, and it holds after any restart, whoever or whatever triggers it.

## Three identities, one commit

| Check | What it compares | Where |
|---|---|---|
| Source | `git rev-parse HEAD` equals the captured SHA, and the tree is clean (untracked files included) | `ops/assert-build-identity.mjs source` |
| Build | `.next/BUILD_ID` equals the SHA (`generateBuildId` returns the git HEAD) | `... build` |
| Served | the `buildId` embedded in HTML the live process returns equals the SHA. The probe uses a cache-busting query, and the build and source are re-checked after it. | `... served` |

An HTTP 200 alone doesn't tell you which build answered. During the deploy the old process keeps serving while the new build sits on disk, which is why the served check exists.

## Deploy flow (`ops/deploy.sh`)

1. Take the repo `flock`. Check out and pull, then capture `HEAD`. Assert **source**.
2. Install and generate. Assert **source** again, because tools must not dirty the tree.
3. Build into `.next.staging.<ts>`, typecheck, and assert **build** against the staging dir. If anything fails here, the live `.next` stays untouched.
4. Swap atomically: `.next` becomes `.next.previous.<ts>` (the newest 3 are kept) and staging becomes `.next`.
5. Install the systemd guards. Publish `releases/<sha>` and repoint `releases/current`.
6. Restart, assert **served**, and run the critical smoke suite.
7. A failure after the restart writes a warning file and emails the operator. **There is no automatic rollback.** A rollback means deploying a known-good SHA through the same script.

## systemd guards (`ops/systemd/studio-os.service.d/`)

- `ExecStartPre=verify-service-release.mjs pre` refuses to start a checkout whose source or `BUILD_ID` has drifted.
- `ExecStartPost=verify-service-release.mjs post $MAINPID` gives the process up to 45 s to serve the expected `buildId`. It also checks that systemd's `MainPID` owns the port, lives in the unit's cgroup and runs from this checkout. If the post check fails, the start fails.
- `crash-loop-guard.conf`: `StartLimitBurst=5` in 60 s, then `OnFailure=unit-failure-alert@%n`. Without it, `Restart=always` hid a crash loop for days.

The hooks cover deploys, manual `systemctl restart`, reboots and automatic restarts. An administrator who deletes them can bypass them. Shell wrappers alone can't constrain root.

## Immutable job releases (`ops/publish-release.sh`)

Cron and timer jobs run TypeScript through `tsx`. When they ran from the dev checkout, every uncommitted edit went live on the next tick. Now they run from `releases/current`:

```
releases/<sha>     detached git worktree at exactly <sha>, verified clean
releases/current   symlink, swapped with `ln -sfn tmp && mv -T` (atomic rename)
```

`node_modules`, `.env` and `logs/` are symlinked from the app root. The newest three releases are kept for rollback. A job that is mid-run keeps its directory until a later publish prunes it.

## Tests

`tests/ops.test.ts` builds a throwaway git repo and covers publish and prune, the deploy dry run, the parsing behind the served-identity check, and the `cron-with-alert.sh` contract.
