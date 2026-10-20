import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  enforceRateLimit,
  getClientIp,
  digestKey,
  MemoryRateLimitStore,
  RATE_LIMITS,
  FORGOT_PASSWORD_PER_EMAIL,
} from "../lib/rate-limit.ts";

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

test("client IP: x-real-ip wins; else RIGHTMOST x-forwarded-for (leftmost is client-forged)", () => {
  assert.equal(getClientIp(req({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" })), "203.0.113.7");
  assert.equal(getClientIp(req({ "x-forwarded-for": "198.51.100.1, 203.0.113.9" })), "203.0.113.9");
  assert.equal(getClientIp({ headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" } }), "203.0.113.9");
  assert.equal(getClientIp(req({ "x-forwarded-for": "not-an-ip" })), "unknown");
});

test("sliding window: limit, block with Retry-After, then recovery as rows age out", async () => {
  const store = new MemoryRateLimitStore();
  const cfg = RATE_LIMITS.AUTH_LOGIN_CUSTOMER; // 5 / 5 min per ip+email
  const r = req({ "x-real-ip": "203.0.113.7" });
  const t0 = new Date("2026-06-01T12:00:00Z");
  for (let i = 0; i < 5; i++) {
    const res = await checkRateLimit(store, r, cfg, { email: "Alex@Example.com" }, new Date(t0.getTime() + i * 1000));
    assert.equal(res.allowed, true);
  }
  const blocked = await checkRateLimit(store, r, cfg, { email: "alex@example.com" }, new Date(t0.getTime() + 10_000));
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.retryAfterSec, 290);

  // different email from same IP is a different bucket
  assert.equal((await checkRateLimit(store, r, cfg, { email: "jordan@example.com" }, t0)).allowed, true);

  // after the window passes the oldest attempts, requests are allowed again
  const later = new Date(t0.getTime() + 5 * 60_000 + 5_000);
  assert.equal((await checkRateLimit(store, r, cfg, { email: "alex@example.com" }, later)).allowed, true);
});

test("forged leftmost XFF cannot escape the bucket", async () => {
  const store = new MemoryRateLimitStore();
  const cfg = { ...RATE_LIMITS.AUTH_REGISTER_CUSTOMER, limit: 2 };
  const now = new Date();
  for (const forged of ["198.51.100.1", "198.51.100.2"]) {
    await checkRateLimit(store, req({ "x-forwarded-for": `${forged}, 203.0.113.50` }), cfg, undefined, now);
  }
  const third = await checkRateLimit(store, req({ "x-forwarded-for": "198.51.100.3, 203.0.113.50" }), cfg, undefined, now);
  assert.equal(third.allowed, false);
});

test("anti-relay: per-email limit holds across rotating IPs", async () => {
  const store = new MemoryRateLimitStore();
  const now = new Date();
  assert.equal((await checkRateLimit(store, req({ "x-real-ip": "203.0.113.1" }), FORGOT_PASSWORD_PER_EMAIL, { email: "victim@example.com" }, now)).allowed, true);
  assert.equal((await checkRateLimit(store, req({ "x-real-ip": "203.0.113.2" }), FORGOT_PASSWORD_PER_EMAIL, { email: "victim@example.com" }, now)).allowed, false);
});

test("fails open on store errors", async () => {
  const store = new MemoryRateLimitStore();
  store.failWith = new Error("db down");
  const res = await checkRateLimit(store, req({}), RATE_LIMITS.BOOKING_PUBLIC_CREATE);
  assert.equal(res.allowed, true);
});

test("enforce: 429 + Retry-After + audit with redacted key digest", async () => {
  const store = new MemoryRateLimitStore();
  const audits: Array<Record<string, unknown>> = [];
  const cfg = { ...RATE_LIMITS.AUTH_RESET_PASSWORD, limit: 1 };
  const r = req({ "x-real-ip": "203.0.113.7" });
  const body = { token: "reset-token-value" };
  assert.equal(await enforceRateLimit(store, async (e) => void audits.push(e.details), r, cfg, body), null);
  const res = await enforceRateLimit(store, async (e) => void audits.push(e.details), r, cfg, body);
  assert.equal(res?.status, 429);
  assert.ok(Number(res?.headers.get("Retry-After")) >= 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.keyDigest, digestKey("ip:203.0.113.7|token:reset-token-value"));
  assert.ok(!JSON.stringify(audits).includes("reset-token-value"));
});
