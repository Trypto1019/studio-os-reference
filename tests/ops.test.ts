import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readlinkSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain ESM module without type declarations
import { servedBuildId } from "../ops/assert-build-identity.mjs";

const OPS = resolve(import.meta.dirname, "../ops");

/** Async so the in-process fake email API can answer while the script runs. */
function runAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile("bash", args, { env, encoding: "utf8" }, (err, stdout, stderr) => {
      done({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

function gitRepo(): { dir: string; commit: (msg: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "studio-os-ops-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=CI", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  return {
    dir,
    commit: (msg) => {
      writeFileSync(join(dir, "file.txt"), msg);
      git("add", "file.txt");
      git("commit", "-q", "-m", msg);
      return git("rev-parse", "HEAD");
    },
  };
}

describe("cron-with-alert.sh", () => {
  let server: Server;
  let hits = 0;
  let url = "";
  before(async () => {
    server = createServer((req, res) => {
      hits++;
      req.resume();
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/emails`;
  });
  after(() => server.close());

  test("preserves exit code + output, alerts once per cooldown, success re-arms", async () => {
    const state = mkdtempSync(join(tmpdir(), "cron-alert-"));
    const envFile = join(state, "app.env");
    writeFileSync(envFile, "EMAIL_API_KEY=test-key-not-real\n");
    const env = { ...process.env, CRON_ALERT_ENV_FILE: envFile, CRON_ALERT_TO: "ops@example.com", CRON_ALERT_API_URL: url, CRON_ALERT_STATE_DIR: state };
    const run = (cmd: string) => runAsync([join(OPS, "cron-with-alert.sh"), "job", cmd], env);

    const fail1 = await run("echo hello; exit 7");
    assert.equal(fail1.status, 7);
    assert.match(fail1.stdout, /hello/);
    assert.equal(hits, 1);

    assert.equal((await run("exit 7")).status, 7);
    assert.equal(hits, 1, "cooldown suppresses the second alert");

    assert.equal((await run("true")).status, 0);
    assert.equal((await run("exit 3")).status, 3);
    assert.equal(hits, 2, "success cleared the cooldown");
  });

  test("consecutive-failure gate and missing recipient never change the exit code", () => {
    const state = mkdtempSync(join(tmpdir(), "cron-alert-"));
    const env = { ...process.env, CRON_ALERT_STATE_DIR: state, CRON_ALERT_MIN_CONSECUTIVE: "2", CRON_ALERT_TO: "" };
    const r1 = spawnSync("bash", [join(OPS, "cron-with-alert.sh"), "flaky", "exit 5"], { env, encoding: "utf8" });
    assert.equal(r1.status, 5);
    assert.match(r1.stderr, /deferred: consecutive failure 1 of 2/);
    const r2 = spawnSync("bash", [join(OPS, "cron-with-alert.sh"), "flaky", "exit 5"], { env, encoding: "utf8" });
    assert.equal(r2.status, 5);
    assert.match(r2.stderr, /CRON_ALERT_TO not set/);
  });
});

describe("publish-release.sh", () => {
  test("atomically points current at a clean detached worktree and prunes old releases", () => {
    const { dir, commit } = gitRepo();
    const releases = mkdtempSync(join(tmpdir(), "releases-"));
    const env = { ...process.env, APP_ROOT: dir, RELEASES_DIR: releases, RELEASE_KEEP: "1" };
    const a = commit("one");
    execFileSync("bash", [join(OPS, "publish-release.sh"), a], { env });
    assert.equal(readlinkSync(join(releases, "current")), join(releases, a));
    const b = commit("two");
    execFileSync("bash", [join(OPS, "publish-release.sh"), b], { env });
    assert.equal(readlinkSync(join(releases, "current")), join(releases, b));
    assert.equal(existsSync(join(releases, a)), false, "older release pruned with KEEP=1");
    const bad = spawnSync("bash", [join(OPS, "publish-release.sh"), "abc"], { env });
    assert.equal(bad.status, 2);
    rmSync(releases, { recursive: true, force: true });
  });
});

describe("deploy.sh", () => {
  test("dry run walks every gate without side effects", () => {
    const { dir, commit } = gitRepo();
    commit("init");
    const r = spawnSync("bash", [join(OPS, "deploy.sh"), "main"], { env: { ...process.env, APP_ROOT: dir, DEPLOY_DRY_RUN: "1" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Deploy complete/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".next")), []);
  });
});

test("servedBuildId requires exactly one embedded buildId", () => {
  const sha = "a".repeat(40);
  assert.equal(servedBuildId(`<script>{"buildId":"${sha}"}</script>`), sha);
  assert.throws(() => servedBuildId("<html></html>"));
  assert.throws(() => servedBuildId(`{"buildId":"x"} {"buildId":"y"}`));
});
