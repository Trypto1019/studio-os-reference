/**
 * Consent decision for AI/artificial-voice outbound CALLS.
 *
 * Context: AI-generated voices count as "artificial" voice under US
 * telemarketing rules, so voice consent needs its own evidence record
 * (ConsentEvent, channel = voice) and can never be inferred from:
 *   - an SMS opt-in, an administrative/legacy SMS consent stamp, or
 *   - a marketing-email preference (turning email off never stops calls,
 *     and turning it on never starts them).
 * Marketing SMS uses a different rule (allowed unless opted out) and does not
 * come through here.
 *
 * Pure function over the latest consent event, so it is exhaustively
 * testable; `basis` is logged with every decision for audit.
 */

export const LEGACY_SMS_MECHANISM = "legacy_sms_capture";
export const STAFF_SMS_MECHANISM = "staff_entered_sms";

export interface PhoneConsentCustomer {
  id: string;
  smsOptIn: boolean;
}

export interface ConsentEventLike {
  granted: boolean;
  source: string;
  disclosureVersion: string;
  disclosureTextHash: string;
  currentState: unknown;
}

/** Checks the form disclosure text/hash/version against the published one. */
export type DisclosureVerifier = (evidence: {
  version: string;
  hash: string;
  text: string | null;
  mechanism: string | null;
}) => boolean;

export function voiceCallConsent(
  customer: PhoneConsentCustomer,
  event: ConsentEventLike | null | undefined,
  verifyDisclosure: DisclosureVerifier,
): { allowed: boolean; basis: string } {
  if (!customer.smsOptIn) return { allowed: false, basis: "phone_preference_disabled" };
  if (!event) return { allowed: false, basis: "no_voice_consent" };
  if (!event.granted) return { allowed: false, basis: "latest_consent_declined" };

  const state = (event.currentState ?? {}) as Record<string, unknown>;
  const mechanism = typeof state.consentMechanism === "string" ? state.consentMechanism : null;
  if (mechanism === LEGACY_SMS_MECHANISM || mechanism === STAFF_SMS_MECHANISM) {
    return { allowed: false, basis: "unverified_administrative_sms_consent" };
  }

  if (event.source === "web_form") {
    const verified =
      verifyDisclosure({
        version: event.disclosureVersion,
        hash: event.disclosureTextHash,
        text: typeof state.disclosureText === "string" ? state.disclosureText : null,
        mechanism,
      }) && state.voiceConsent === true;
    return { allowed: verified, basis: verified ? "verified_web_form_consent" : "unverified_web_form_consent" };
  }

  const voice = state.voiceConsent === true;
  return { allowed: voice, basis: voice ? "voice_consent_event" : "voice_consent_missing" };
}
