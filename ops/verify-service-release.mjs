// systemd ExecStartPre / ExecStartPost hook (see ops/systemd/*.service.d).
//
//   pre   reject source/BUILD_ID drift BEFORE the process starts
//   post  wait (bounded) until the live process serves the expected buildId,
//         and prove the PID systemd reports owns the port and runs from this
//         checkout. A failed post-check makes systemd fail the start.
//
// Because the hooks live in systemd, they also cover manual `systemctl
// restart`, reboots and automatic restarts, not just scripted deploys.
//
// Usage: node ops/verify-service-release.mjs pre|post|verify [MAINPID]
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertBuildIdentity, assertServedIdentity } from "./assert-build-identity.mjs";

export const RELEASE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = process.env.SERVICE_NAME || "studio-os";
const PORT = process.env.APP_PORT || "3000";
const IDENTITY_URLS = (process.env.IDENTITY_URLS || `http://127.0.0.1:${PORT}/login`).split(/\s+/).filter(Boolean);
const BUILD_DIR = process.env.NEXT_BUILD_DIR || ".next";

export const currentRevision = () =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: RELEASE_ROOT, encoding: "utf8" }).trim();

export function assertProcessOwner(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Missing service MainPID");
  const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
  if (!cgroup.split("\n").some((l) => l.endsWith(`/system.slice/${SERVICE}.service`))) {
    throw new Error("Process is not owned by the expected systemd service");
  }
  if (realpathSync(`/proc/${pid}/cwd`) !== RELEASE_ROOT) throw new Error("Service runs from a different checkout");
  const sockets = execFileSync("ss", ["-ltnp", `sport = :${PORT}`], { encoding: "utf8" });
  if (!sockets.includes(`pid=${pid},`)) throw new Error(`PID ${pid} does not own port ${PORT}`);
}

export async function verifyServiceRelease(phase, pid, expected = currentRevision()) {
  if (!["pre", "post", "verify"].includes(phase)) throw new Error("Expected pre|post|verify");
  assertBuildIdentity(expected, BUILD_DIR, RELEASE_ROOT);
  if (phase === "pre") return { phase, revision: expected };

  const deadline = Date.now() + 45_000;
  let lastError;
  do {
    // Source drift is a hard failure, not a readiness condition to wait out.
    assertBuildIdentity(expected, BUILD_DIR, RELEASE_ROOT);
    try {
      const mainPid =
        pid || Number(execFileSync("systemctl", ["show", SERVICE, "-p", "MainPID", "--value"], { encoding: "utf8" }).trim());
      await assertServedIdentity(expected, BUILD_DIR, IDENTITY_URLS, RELEASE_ROOT);
      assertProcessOwner(mainPid);
      return { phase, revision: expected, pid: mainPid };
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  throw lastError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [phase, pid] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(await verifyServiceRelease(phase, pid ? Number(pid) : undefined)));
  } catch (error) {
    console.error(`Service release verification FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
