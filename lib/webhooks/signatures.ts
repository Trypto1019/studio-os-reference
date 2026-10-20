/**
 * Webhook signature verification for the three inbound providers.
 *
 * Common rules:
 *   - Verify over the RAW body bytes, before any JSON/form parsing.
 *   - Compare with crypto.timingSafeEqual (length-checked first, because it
 *     throws on mismatched lengths).
 *   - Fail closed when no signing secret is configured; the caller decides
 *     whether that is a 503 ("not configured yet") or a 403.
 *   - Rebuild the signed URL from a trusted PUBLIC_URL, never from the Host
 *     or X-Forwarded-* headers (attacker-controlled upstream of the app).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time string compare (also used for token-in-path webhooks). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Stripe: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`
// HMAC-SHA256(secret, `${t}.${rawBody}`), hex. Multiple v1 entries appear
// during secret rotation; any match passes. Same algorithm as the SDK's
// stripe.webhooks.constructEvent, implemented here to stay dependency-free.
// ---------------------------------------------------------------------------

export const STRIPE_TOLERANCE_SECONDS = 300;

export type StripeVerifyResult = { ok: true; timestamp: number } | { ok: false; reason: string };

export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): StripeVerifyResult {
  if (!secret) return { ok: false, reason: "secret_not_configured" };
  if (!header) return { ok: false, reason: "missing_signature" };

  let timestamp = Number.NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s?.trim());
    if (k === "t") timestamp = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  if (!Number.isFinite(timestamp) || v1.length === 0) return { ok: false, reason: "malformed_signature" };

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > (opts.toleranceSec ?? STRIPE_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return v1.some((sig) => constantTimeEqual(sig, expected))
    ? { ok: true, timestamp }
    : { ok: false, reason: "signature_mismatch" };
}

// ---------------------------------------------------------------------------
// Svix (used by the transactional email provider):
//   svix-id, svix-timestamp (unix seconds, +/-5 min), svix-signature with one
//   or more space-separated `v1,<base64>` tokens. Secret format
//   `whsec_<base64>`: strip the prefix and base64-decode to get key bytes.
// ---------------------------------------------------------------------------

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixVerifyResult = { ok: true } | { ok: false; reason: string };

export function verifySvixSignature(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SvixVerifyResult {
  const prefix = "whsec_";
  if (!secret.startsWith(prefix)) return { ok: false, reason: "bad_secret_format" };
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, reason: "missing_headers" };
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowSec - ts) > SVIX_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp_outside_tolerance" };

  const key = Buffer.from(secret.slice(prefix.length), "base64");
  const computed = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest("base64");
  const candidates = headers.signature
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));
  return candidates.some((c) => constantTimeEqual(c, computed)) ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

// ---------------------------------------------------------------------------
// SignalWire (Twilio-compatible LaML/cXML + RELAY/SWML):
//   Scheme A (raw body present): lowercase hex HMAC-SHA1(key, url + rawBody).
//   Scheme B (form webhooks): url + concat(sorted key+value), HMAC-SHA1,
//   base64. The provider sometimes signs the URL with the explicit standard
//   port, so both variants are accepted.
// The signing key is the webhook signing key, NOT the API project token.
// ---------------------------------------------------------------------------

export interface SignalWireVerifyOptions {
  /** Full URL as the provider called it, rebuilt from trusted PUBLIC_URL + path. */
  url: string;
  params: Record<string, string | string[] | undefined>;
  rawBody?: string;
  signature: string;
  signingKey: string | undefined;
}

export function getSignalWireSignature(headers: Headers): string {
  return headers.get("x-signalwire-signature") ?? headers.get("x-twilio-signature") ?? "";
}

export function signalWireCanonical(url: string, params: SignalWireVerifyOptions["params"]): string {
  let canonical = url;
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (Array.isArray(v)) for (const item of v) canonical += k + (item ?? "");
    else canonical += k + (v ?? "");
  }
  return canonical;
}

export function verifySignalWireSignature(opts: SignalWireVerifyOptions): boolean {
  if (!opts.signingKey || !opts.signature) return false;
  const provided = opts.signature.trim();

  if (opts.rawBody !== undefined) {
    const hex = createHmac("sha1", opts.signingKey).update(`${opts.url}${opts.rawBody}`, "utf8").digest("hex");
    if (constantTimeEqual(hex, provided)) return true;
  }

  const urls = [opts.url];
  const parsed = new URL(opts.url);
  if (!parsed.port) {
    const port = parsed.protocol === "https:" ? "443" : "80";
    urls.push(`${parsed.protocol}//${parsed.hostname}:${port}${parsed.pathname}${parsed.search}${parsed.hash}`);
  }
  return urls.some((u) => {
    const expected = createHmac("sha1", opts.signingKey!).update(signalWireCanonical(u, opts.params), "utf8").digest("base64");
    return constantTimeEqual(expected, provided);
  });
}
