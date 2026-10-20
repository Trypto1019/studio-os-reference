/**
 * Request gateway: host routing + baseline auth, as a PURE function.
 *
 * One Next.js process serves three hosts:
 *   - marketing (example.com):   public pages rewritten to an internal route
 *                                group; only allowlisted public APIs; every
 *                                staff/customer surface is a 404 here even
 *                                with a valid session cookie.
 *   - staff CRM (crm.example.com) and booking portal (book.example.com):
 *                                authenticated app surfaces.
 *
 * API routes are DENY BY DEFAULT:
 *   1. PUBLIC_API_PATHS bypass (each route carries its own auth: webhook
 *      signatures, signed tokens, cron secret checked in-route).
 *   2. Server-to-server routes: shared secret header, constant-time compare.
 *   3. Staff session cookie.
 *   4. Customer bearer token PRESENCE (cheap); the route verifies it fully.
 *   5. Otherwise 401.
 *
 * A staff user flagged mustChangePassword is confined to the change-password
 * page/API (plus auth meta routes so they can always sign out).
 *
 * `decide()` returns a Decision; examples/next/middleware.ts maps it to
 * NextResponse in ~20 lines. Keeping the policy framework-free makes every
 * branch unit-testable (tests/rbac-middleware.test.ts).
 */

import type { AppConfig } from "./lib/config.ts";
import { constantTimeEqual } from "./lib/webhooks/signatures.ts";

export type Decision =
  | { type: "next" }
  | { type: "rewrite"; pathname: string; internal: "marketing" }
  | { type: "redirect"; location: string; status: 301 | 302 | 307 | 308 }
  | { type: "json"; status: number; body: Record<string, unknown> }
  | { type: "not_found" };

export interface RequestFacts {
  host: string;
  pathname: string;
  headers: Headers;
  /** Decoded staff session (e.g. NextAuth JWT), or null. */
  staffSession: { id: string; mustChangePassword?: boolean } | null;
}

export interface MiddlewareEnv {
  NODE_ENV?: string;
  SYNC_SECRET?: string;
  INTERNAL_INGEST_TOKEN?: string;
}

export const PUBLIC_API_PATHS = [
  "/api/auth", // auth framework callbacks
  "/api/customer-auth/login",
  "/api/customer-auth/register",
  "/api/customer-auth/forgot-password",
  "/api/customer-auth/reset-password",
  "/api/customer-auth/magic-login", // signed one-time token in body is the credential
  "/api/booking/availability",
  "/api/booking/public",
  "/api/webhooks", // every webhook verifies its own signature
  "/api/cron", // CRON_SECRET checked in-route
  "/api/calendar-feed", // 256-bit token in URL, constant-time compare, uniform 404
  "/api/email-unsubscribe", // HMAC of customer id
  "/api/health", // counts only, no config values
] as const;

export const MARKETING_INTERNAL_PREFIX = "/_marketing";
export const MARKETING_PAGES = new Set(["/", "/pricing", "/about", "/contact", "/faq"]);

const FORCED_CHANGE_ALLOWLIST = ["/account/change-password", "/api/auth/change-password"];

const PROTECTED_PAGE_PREFIXES = [
  "/dashboard",
  "/customers",
  "/schedule",
  "/payments",
  "/memberships",
  "/workflows",
  "/settings",
  "/account",
  "/reports",
];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

const matchesPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(prefix + "/");

export function normalizeHost(raw: string | null): string {
  return (raw ?? "").split(",")[0]!.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function secretHeaderOk(headers: Headers, header: string, expected: string | undefined): boolean {
  const provided = headers.get(header);
  return !!expected && !!provided && constantTimeEqual(provided, expected);
}

export function decide(req: RequestFacts, config: AppConfig, env: MiddlewareEnv = {}): Decision {
  const { pathname, headers, staffSession } = req;
  const host = normalizeHost(req.host);
  const isMarketingHost =
    config.hosts.marketing.includes(host) ||
    ((env.NODE_ENV === "development" || env.NODE_ENV === "test") && host === "marketing.localhost");

  // === Marketing host: host-level allowlist ===
  if (isMarketingHost) {
    if (pathname.startsWith("/api/")) return isPublicApiPath(pathname) ? { type: "next" } : { type: "not_found" };
    if (MARKETING_PAGES.has(pathname)) {
      return { type: "rewrite", pathname: `${MARKETING_INTERNAL_PREFIX}${pathname === "/" ? "" : pathname}`, internal: "marketing" };
    }
    return { type: "not_found" };
  }

  // The physical marketing route group is never a second public URL elsewhere.
  if (matchesPrefix(pathname, MARKETING_INTERNAL_PREFIX)) return { type: "not_found" };

  // === Forced password change gate (pages and APIs alike) ===
  if (staffSession?.mustChangePassword) {
    const allowed = pathname.startsWith("/api/auth/") || FORCED_CHANGE_ALLOWLIST.some((p) => matchesPrefix(pathname, p));
    if (!allowed) {
      return pathname.startsWith("/api/")
        ? { type: "json", status: 403, body: { error: "Password change required", requiresPasswordChange: true } }
        : { type: "redirect", location: "/account/change-password", status: 307 };
    }
  }

  // === Root: route to the right product surface by host ===
  if (pathname === "/") {
    if (staffSession) return { type: "redirect", location: "/dashboard", status: 302 };
    return { type: "redirect", location: host === config.hosts.staff ? "/login" : "/book/login", status: 302 };
  }

  // === API: deny by default ===
  if (pathname.startsWith("/api/")) {
    if (isPublicApiPath(pathname)) return { type: "next" };
    if (matchesPrefix(pathname, "/api/internal/ingest")) {
      return secretHeaderOk(headers, "x-internal-token", env.INTERNAL_INGEST_TOKEN)
        ? { type: "next" }
        : { type: "json", status: 401, body: { error: "Invalid internal token" } };
    }
    if (matchesPrefix(pathname, "/api/payments/record")) {
      return secretHeaderOk(headers, "x-sync-secret", env.SYNC_SECRET)
        ? { type: "next" }
        : { type: "json", status: 401, body: { error: "Invalid sync secret" } };
    }
    if (staffSession) return { type: "next" };
    if (headers.get("authorization")?.startsWith("Bearer ")) return { type: "next" };
    return { type: "json", status: 401, body: { error: "Unauthenticated" } };
  }

  // === Pages ===
  if (matchesPrefix(pathname, "/login")) {
    return staffSession ? { type: "redirect", location: "/dashboard", status: 307 } : { type: "next" };
  }
  // The booking portal keeps its token client-side; its pages render and
  // call bearer-authenticated APIs. Staff pages are never served there.
  if (host === config.hosts.booking && PROTECTED_PAGE_PREFIXES.some((p) => matchesPrefix(pathname, p))) {
    return { type: "not_found" };
  }
  if (PROTECTED_PAGE_PREFIXES.some((p) => matchesPrefix(pathname, p)) && !staffSession) {
    return { type: "redirect", location: "/login", status: 307 };
  }
  return { type: "next" };
}
