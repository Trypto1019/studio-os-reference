/**
 * Dataset hygiene gate: fails on any phone that is not a reserved fictional
 * 555 number, any email outside example.com, any private infra path, or any
 * term from the private scrub list (brands, people, hosts). The scrub list
 * lives outside the repo so this public file never lists what it hides; set
 * PORTFOLIO_SCRUB_TERMS to its path to enable that check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "coverage"]);
const BINARY = /\.(png|jpe?g|gif|ico|pdf|woff2?|zip|gz)$/i;

// Line format: plain = forbidden term, "owner:" = name allowed only in LICENSE,
// "re:" = regex, "#" = comment.
function loadPrivateTerms(): { terms: string[]; owner: string[] } {
  const path = process.env.PORTFOLIO_SCRUB_TERMS;
  if (!path || !existsSync(path)) return { terms: [], owner: [] };
  const terms: string[] = [];
  const owner: string[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("re:")) continue;
    if (line.startsWith("owner:")) owner.push(line.slice("owner:".length));
    else terms.push(line);
  }
  return { terms, owner };
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PRIVATE = loadPrivateTerms();
const SCRUB_TERMS = [...PRIVATE.terms, ...PRIVATE.owner];
const SCRUB = SCRUB_TERMS.length
  ? new RegExp(`\\b(${SCRUB_TERMS.map(escapeRe).join("|")})\\b`, "i")
  : /(?!)/;
const INFRA_PATHS = /(^|[\s"'`(=])\/(root|opt|var\/www)\//;
const OWNER_EXCEPTION_FILE = "LICENSE";

const PHONE = /(?<![\w.])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?![\w])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (!BINARY.test(name)) yield p;
  }
}

function isFictionalPhone(area: string, exchange: string, line: string): boolean {
  return (area === "555" && exchange.startsWith("01")) || (exchange === "555" && line.startsWith("01"));
}

test("no real phones, non-example emails, or scrub-list terms anywhere in the repo", () => {
  const findings: string[] = [];
  let files = 0;
  for (const file of walk(ROOT)) {
    files++;
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((raw, i) => {
      const where = `${rel}:${i + 1}`;
      const line = rel === OWNER_EXCEPTION_FILE ? [...PRIVATE.owner].sort((a, b) => b.length - a.length).reduce((l, o) => l.replace(new RegExp(escapeRe(o), "gi"), ""), raw) : raw;
      for (const m of line.matchAll(PHONE)) {
        if (!isFictionalPhone(m[1]!, m[2]!, m[3]!)) findings.push(`${where} phone`);
      }
      for (const m of line.matchAll(EMAIL)) {
        if (!/@example\.(com|org|net)$/i.test(m[0])) findings.push(`${where} email`);
      }
      if (SCRUB.test(line)) findings.push(`${where} scrub-term`);
      if (INFRA_PATHS.test(line)) findings.push(`${where} private-path`);
    });
  }
  assert.ok(files > 30, `expected to scan the repo, scanned ${files} files`);
  assert.deepEqual(findings, [], `hygiene findings (values not printed):\n${findings.join("\n")}`);
});

test("the gate itself catches what it should", () => {
  const sample = (s: string) => [...s.matchAll(PHONE)].some((m) => !isFictionalPhone(m[1]!, m[2]!, m[3]!));
  assert.equal(sample(`call +1 ${["415", "867", "2209"].join("-")}`), true);
  assert.equal(sample("call +1-555-010-0199"), false);
  assert.equal(sample("call 212-555-0143"), false);
  const probe = SCRUB_TERMS.find((t) => /^\w.*\w$/.test(t));
  if (probe) assert.equal(SCRUB.test(`hello ${probe} there`), true);
  assert.equal(INFRA_PATHS.test(` cd /${"ro"}ot/app`), true);
});
