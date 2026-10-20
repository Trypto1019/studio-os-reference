/**
 * Win-back offer payload: a versioned JSON record stamped onto an open
 * follow-up intent when an offer SMS goes out, so the booking flow, the
 * credit grant and the AI front desk all agree on "this customer has a live
 * offer".
 *
 * Patterns kept from production:
 *   - Tolerant parser: older sends predate `copyVersion`; anything that is
 *     not exactly this offer parses to null instead of throwing.
 *   - Purchase-resolved offers are closed for every customer-facing
 *     behaviour (no credit, no "you already redeemed" continuity).
 *   - A/B copy assignment is strict alternation over a warmest-first batch,
 *     so both variants get the same warmth distribution (not warm-first vs
 *     cold-second halves).
 */

export const WINBACK_OFFER_KIND = "winback_offer";
export const WINBACK_CAMPAIGN = "winback_return_session";
export const WINBACK_OFFER = "complimentary_return_session";
export const WINBACK_COPY_VERSIONS = ["v2a", "v2b"] as const;
export type WinbackCopyVersion = (typeof WINBACK_COPY_VERSIONS)[number];

export interface WinbackOfferPayload {
  kind: typeof WINBACK_OFFER_KIND;
  campaign: typeof WINBACK_CAMPAIGN;
  offer: typeof WINBACK_OFFER;
  sentAt: string;
  outboundMessageId: string | null;
  copyVersion: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function toWinbackOfferPayload(payload: unknown): WinbackOfferPayload | null {
  if (!isRecord(payload)) return null;
  if (payload.kind !== WINBACK_OFFER_KIND || payload.campaign !== WINBACK_CAMPAIGN || payload.offer !== WINBACK_OFFER) return null;
  if (typeof payload.sentAt !== "string") return null;
  return {
    kind: WINBACK_OFFER_KIND,
    campaign: WINBACK_CAMPAIGN,
    offer: WINBACK_OFFER,
    sentAt: payload.sentAt,
    outboundMessageId: typeof payload.outboundMessageId === "string" ? payload.outboundMessageId : null,
    copyVersion: typeof payload.copyVersion === "string" ? payload.copyVersion : null,
  };
}

export function isConversionResolved(payload: unknown): boolean {
  return isRecord(payload) && typeof payload.resolvedVia === "string" && payload.resolvedVia.startsWith("conversion:");
}

export interface OpenIntentLike {
  status: string;
  expiresAt: Date;
  payload: unknown;
}

export function findActiveWinbackOffer(intents: readonly OpenIntentLike[], now: Date = new Date()): WinbackOfferPayload | null {
  for (const intent of intents) {
    if (intent.status !== "OPEN" || intent.expiresAt <= now || isConversionResolved(intent.payload)) continue;
    const p = toWinbackOfferPayload(intent.payload);
    if (p) return p;
  }
  return null;
}

/** Strict alternation over a batch already sorted warmest-first. */
export function assignCopyVersions<T>(warmestFirst: readonly T[]): Array<T & { copyVersion: WinbackCopyVersion }> {
  return warmestFirst.map((item, i) => ({ ...item, copyVersion: WINBACK_COPY_VERSIONS[i % 2]! }));
}
