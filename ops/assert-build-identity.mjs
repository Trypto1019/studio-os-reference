// Release identity gates. A successful HTTP response does not establish WHICH
// release answered it, so every check compares three things against one
// captured commit: clean source at HEAD, the on-disk Next.js BUILD_ID, and the
// buildId embedded in what the running process actually serves.
//
// The app's next.config sets `generateBuildId: () => gitHeadSha` so BUILD_ID
// equals the commit it was built from.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The ONE buildId embedded in a served HTML page (not the manifest URL). */
export function servedBuildId(html) {
  const ids = [...html.replace(/\\"/g, '"').matchAll(/"buildId"\s*:\s*"([^"\\]+)"/g)].map((m) => m[1]);
  if (!ids.length || new Set(ids).size !== 1) throw new Error("HTTP response has no unique Next.js buildId");
  return ids[0];
}

export function assertSourceIdentity(expected, root = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(expected || "")) throw new Error("Expected a full git commit SHA");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  if (head !== expected) throw new Error(`HEAD changed: expected ${expected}, found ${head}`);
  const dirty = git("status", "--porcelain", "--untracked-files=all");
  if (dirty) throw new Error(`Source tree is not clean; BUILD_ID would not identify its contents:\n${dirty}`);
}

export function assertBuildIdentity(expected, directory, root = process.cwd()) {
  assertSourceIdentity(expected, root);
  const actual = readFileSync(resolve(root, directory, "BUILD_ID"), "utf8").trim();
  if (actual !== expected) throw new Error(`BUILD_ID mismatch: expected ${expected}, found ${actual}`);
}

export async function assertServedIdentity(expected, directory, urls, root = process.cwd()) {
  assertBuildIdentity(expected, directory, root);
  if (!urls.length) throw new Error("At least one HTTP identity probe is required");
  for (const target of urls) {
    const url = new URL(target);
    url.searchParams.set("__deploy_identity", `${expected}-${Date.now()}`); // bust caches
    const response = await fetch(url, {
      headers: { "cache-control": "no-cache, no-store" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Identity probe ${url.origin}${url.pathname}: HTTP ${response.status}`);
    const actual = servedBuildId(await response.text());
    if (actual !== expected) throw new Error(`Served BUILD_ID mismatch at ${url.origin}${url.pathname}: expected ${expected}, found ${actual}`);
  }
  // Catch a source/build change that happened while the probes ran.
  assertBuildIdentity(expected, directory, root);
}

async function main() {
  const [mode, expected, directory, ...urls] = process.argv.slice(2);
  try {
    if (mode === "source") assertSourceIdentity(expected);
    else if (mode === "build") assertBuildIdentity(expected, directory);
    else if (mode === "served") await assertServedIdentity(expected, directory, urls);
    else throw new Error("Usage: assert-build-identity.mjs source|build|served SHA [build-dir] [URLs...]");
    console.log(`Build identity gate passed (${mode}): ${expected}`);
  } catch (error) {
    console.error(`Build identity gate FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
