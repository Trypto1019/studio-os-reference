/**
 * Postgres-backed sliding-window rate limiter.
 *
 * Storage: "RateLimitEvent", one row per attempt (allowed or blocked).
 * Hot index: (scope, key, createdAt DESC), so a check is one COUNT(*).
 * Cleanup: a daily cron deletes rows older than 25h (longer than the widest
 * window), so counters survive deploys, restarts and crashes, unlike an
 * in-process map.
 *
 * Two layers:
 *   checkRateLimit()   pure check + record, returns the decision
 *   enforceRateLimit() also audits a block and returns a 429 Response, or
 *                      null when allowed
 *
 * Fail-open: if the store errors, log and allow. Rate limiting is a
 * defensive layer, not a correctness boundary; a DB blip must not take down
 * booking.
 *
 * Client IP: x-real-ip first (the edge proxy overwrites it), then the
 * RIGHTMOST x-forwarded-for entry. The leftmost entry is whatever the
 * client sent; reading it let any caller pick its own bucket.
 *
 * Audit redaction: the raw key may contain an email or a reset token. The
 * audit row stores a SHA-256 prefix so analysts can correlate attacks on the
 * same victim without leaking the credential.
 */

import { createHash } from "node:crypto";
import type { SqlClient } from "./db/types.ts";

export type RateLimitScope =
  | "AUTH_LOGIN_STAFF"
  | "AUTH_LOGIN_CUSTOMER"
  | "AUTH_REGISTER_CUSTOMER"
  | "AUTH_FORGOT_PASSWORD"
  | "AUTH_RESET_PASSWORD"
  | "AUTH_MAGIC_LINK_REQUEST"
  | "BOOKING_PUBLIC_CREATE"
  | "BOOKING_AVAILABILITY";

export type RateLimitKeyContext = { email?: string; token?: string; identifier?: string };

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;
export type RateLimitReqLike = { headers?: HeaderBag };

export interface RateLimitConfig {
  scope: RateLimitScope;
  limit: number;
  windowMs: number;
  keyFn: (req: RateLimitReqLike, body?: RateLimitKeyContext) => string | Promise<string>;
}

export type RateLimitResult =
  | { allowed: true; remaining: number; limit: number }
  | { allowed: false; retryAfterSec: number; limit: number; eventId: string };

export interface RateLimitStore {
  countSince(scope: RateLimitScope, key: string, since: Date): Promise<number>;
  oldestSince(scope: RateLimitScope, key: string, since: Date): Promise<Date | null>;
  insert(e: { scope: RateLimitScope; key: string; blocked: boolean; ipAddress: string; details?: unknown; at: Date }): Promise<string>;
}

export interface RateLimitAuditSink {
  (entry: { action: "RATE_LIMIT_BLOCKED"; entityId: string; ipAddress: string; details: Record<string, unknown> }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------

const IP_PATTERN = /^[0-9a-fA-F:.]+$/;

function readHeader(req: RateLimitReqLike, name: string): string | null {
  const h = req.headers;
  if (!h) return null;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const v = (h as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function getClientIp(req: RateLimitReqLike): string {
  const realIp = readHeader(req, "x-real-ip")?.trim();
  if (realIp && IP_PATTERN.test(realIp)) return realIp;
  const xff = readHeader(req, "x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    const rightmost = parts[parts.length - 1];
    if (rightmost && IP_PATTERN.test(rightmost)) return rightmost;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function checkRateLimit(
  store: RateLimitStore,
  req: RateLimitReqLike,
  config: RateLimitConfig,
  body?: RateLimitKeyContext,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const failOpen = (why: string, err: unknown): RateLimitResult => {
    console.warn(`[rate-limit] ${why} for scope=${config.scope}, failing open:`, err instanceof Error ? err.message : err);
    return { allowed: true, remaining: config.limit, limit: config.limit };
  };

  let key: string;
  try {
    key = await config.keyFn(req, body);
  } catch (err) {
    return failOpen("keyFn threw", err);
  }
  const ip = getClientIp(req);
  const windowStart = new Date(now.getTime() - config.windowMs);

  try {
    const count = await store.countSince(config.scope, key, windowStart);
    if (count >= config.limit) {
      // When the oldest row in the window ages out, the count drops by one.
      const oldest = await store.oldestSince(config.scope, key, windowStart);
      const retryAfterSec = oldest
        ? Math.max(1, Math.ceil((oldest.getTime() + config.windowMs - now.getTime()) / 1000))
        : Math.ceil(config.windowMs / 1000);
      const eventId = await store.insert({
        scope: config.scope,
        key,
        blocked: true,
        ipAddress: ip,
        details: { count, limit: config.limit },
        at: now,
      });
      return { allowed: false, retryAfterSec, limit: config.limit, eventId };
    }
    await store.insert({ scope: config.scope, key, blocked: false, ipAddress: ip, at: now });
    return { allowed: true, remaining: Math.max(0, config.limit - count - 1), limit: config.limit };
  } catch (err) {
    return failOpen("store error", err);
  }
}

export function digestKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export async function enforceRateLimit(
  store: RateLimitStore,
  audit: RateLimitAuditSink,
  req: RateLimitReqLike,
  config: RateLimitConfig,
  body?: RateLimitKeyContext,
  now?: Date,
): Promise<Response | null> {
  const result = await checkRateLimit(store, req, config, body, now);
  if (result.allowed) return null;

  let key: string | null = null;
  try {
    key = await config.keyFn(req, body);
  } catch {
    /* best effort */
  }
  try {
    await audit({
      action: "RATE_LIMIT_BLOCKED",
      entityId: result.eventId,
      ipAddress: getClientIp(req),
      details: {
        scope: config.scope,
        limit: config.limit,
        windowMs: config.windowMs,
        retryAfterSec: result.retryAfterSec,
        keyDigest: key ? digestKey(key) : null,
      },
    });
  } catch (err) {
    console.warn("[rate-limit] audit write failed:", err);
  }
  return new Response(
    JSON.stringify({ error: "Rate limit exceeded. Please try again shortly.", retryAfter: result.retryAfterSec }),
    { status: 429, headers: { "content-type": "application/json", "Retry-After": String(result.retryAfterSec) } },
  );
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

const FIVE_MIN = 5 * 60 * 1000;
const FIFTEEN_MIN = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

const normalizedEmail = (body?: RateLimitKeyContext) => (body?.email ?? "").toLowerCase().trim() || "unknown";
const ipKey = (req: RateLimitReqLike) => `ip:${getClientIp(req)}`;
const ipEmailKey = (req: RateLimitReqLike, body?: RateLimitKeyContext) => `ip:${getClientIp(req)}|email:${normalizedEmail(body)}`;

export const RATE_LIMITS: Record<RateLimitScope, RateLimitConfig> = {
  AUTH_LOGIN_STAFF: { scope: "AUTH_LOGIN_STAFF", limit: 5, windowMs: FIVE_MIN, keyFn: ipEmailKey },
  AUTH_LOGIN_CUSTOMER: { scope: "AUTH_LOGIN_CUSTOMER", limit: 5, windowMs: FIVE_MIN, keyFn: ipEmailKey },
  AUTH_REGISTER_CUSTOMER: { scope: "AUTH_REGISTER_CUSTOMER", limit: 5, windowMs: FIVE_MIN, keyFn: ipKey },
  AUTH_FORGOT_PASSWORD: { scope: "AUTH_FORGOT_PASSWORD", limit: 5, windowMs: FIVE_MIN, keyFn: ipEmailKey },
  AUTH_RESET_PASSWORD: {
    scope: "AUTH_RESET_PASSWORD",
    limit: 5,
    windowMs: FIVE_MIN,
    keyFn: (req, body) => `ip:${getClientIp(req)}|token:${body?.token ?? "unknown"}`,
  },
  AUTH_MAGIC_LINK_REQUEST: {
    scope: "AUTH_MAGIC_LINK_REQUEST",
    limit: 3,
    windowMs: FIFTEEN_MIN,
    keyFn: (req, body) => `ip:${getClientIp(req)}|id:${body?.identifier ?? "unknown"}`,
  },
  BOOKING_PUBLIC_CREATE: { scope: "BOOKING_PUBLIC_CREATE", limit: 20, windowMs: ONE_HOUR, keyFn: ipKey },
  BOOKING_AVAILABILITY: { scope: "BOOKING_AVAILABILITY", limit: 300, windowMs: ONE_HOUR, keyFn: ipKey },
};

/**
 * Anti-relay limiters. Incident: a bot registered throwaway portal accounts
 * under scraped third-party addresses and hit forgot-password seconds later,
 * turning the transactional email domain into a relay, while rotating its IP
 * on every attempt. The victim address is the constant, so this one is
 * keyed on the email ALONE. Distinct key namespaces (`fp-email:`) reuse the
 * existing scope without a schema migration and never collide with the
 * legacy `ip:...` keys.
 */
export const FORGOT_PASSWORD_PER_EMAIL: RateLimitConfig = {
  scope: "AUTH_FORGOT_PASSWORD",
  limit: 1,
  windowMs: FIFTEEN_MIN,
  keyFn: (_req, body) => `fp-email:${normalizedEmail(body)}`,
};

export const FORGOT_PASSWORD_PER_IP: RateLimitConfig = {
  scope: "AUTH_FORGOT_PASSWORD",
  limit: 5,
  windowMs: ONE_HOUR,
  keyFn: (req) => `fp-ip:${getClientIp(req)}`,
};

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export class MemoryRateLimitStore implements RateLimitStore {
  rows: Array<{ id: string; scope: RateLimitScope; key: string; blocked: boolean; ipAddress: string; at: Date }> = [];
  private seq = 0;
  failWith: Error | null = null;

  private match(scope: RateLimitScope, key: string, since: Date) {
    if (this.failWith) throw this.failWith;
    return this.rows.filter((r) => r.scope === scope && r.key === key && r.at.getTime() > since.getTime());
  }
  async countSince(scope: RateLimitScope, key: string, since: Date) {
    return this.match(scope, key, since).length;
  }
  async oldestSince(scope: RateLimitScope, key: string, since: Date) {
    const rows = this.match(scope, key, since);
    return rows.length ? new Date(Math.min(...rows.map((r) => r.at.getTime()))) : null;
  }
  async insert(e: Parameters<RateLimitStore["insert"]>[0]) {
    if (this.failWith) throw this.failWith;
    const id = `rle_${++this.seq}`;
    this.rows.push({ id, scope: e.scope, key: e.key, blocked: e.blocked, ipAddress: e.ipAddress, at: e.at });
    return id;
  }
}

/** node-postgres compatible implementation over the Prisma-managed table. */
export class PgRateLimitStore implements RateLimitStore {
  constructor(private readonly sql: SqlClient) {}
  async countSince(scope: RateLimitScope, key: string, since: Date) {
    const { rows } = await this.sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "RateLimitEvent" WHERE scope = $1 AND key = $2 AND "createdAt" > $3`,
      [scope, key, since],
    );
    return Number(rows[0]?.n ?? 0);
  }
  async oldestSince(scope: RateLimitScope, key: string, since: Date) {
    const { rows } = await this.sql.query<{ at: Date }>(
      `SELECT min("createdAt") AS at FROM "RateLimitEvent" WHERE scope = $1 AND key = $2 AND "createdAt" > $3`,
      [scope, key, since],
    );
    return rows[0]?.at ?? null;
  }
  async insert(e: Parameters<RateLimitStore["insert"]>[0]) {
    const { rows } = await this.sql.query<{ id: string }>(
      `INSERT INTO "RateLimitEvent" (id, scope, key, blocked, "ipAddress", details, "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6) RETURNING id`,
      [e.scope, e.key, e.blocked, e.ipAddress, e.details ? JSON.stringify(e.details) : null, e.at],
    );
    return rows[0]!.id;
  }
}

/** Daily cleanup statement (run from cron via ops/cron-with-alert.sh). */
export const RATE_LIMIT_CLEANUP_SQL = `DELETE FROM "RateLimitEvent" WHERE "createdAt" < now() - interval '25 hours'`;
