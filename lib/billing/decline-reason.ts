/**
 * Staff-facing plain words for a processor decline. The raw processor text
 * ("Do Not Honor", "Pick up card - SF") stays on the staff task as a
 * separate "processor code" line and never reaches a customer.
 */

const PREFIXES = [/^manual retry:\s*/i, /^past due after \d+ failed payment attempts\.\s*last error:\s*/i];

/** The processor's own text, minus our "Manual retry:" / "Past due..." wrappers. */
export function rawDeclineCode(reason: string | null | undefined): string {
  let text = (reason ?? "").trim();
  for (const prefix of PREFIXES) text = text.replace(prefix, "");
  return text || "Unknown";
}

const RULES: Array<[RegExp, string]> = [
  [/insufficient funds|nsf/i, "Not enough money available on the card"],
  [/do not honou?r|card was declined|generic decline|^declined?$|^decline\b/i, "The bank declined it without giving a reason"],
  [/account closed|invalid account|closed account/i, "The card's account is closed"],
  [/cvv|cvc|security code/i, "The card's security code didn't match"],
  [/pick up card|lost|stolen|restricted/i, "The bank has blocked this card (reported lost, stolen or restricted)"],
  [/blocked,? first used/i, "The bank blocked the first use of this card"],
  [/card number is incorrect|invalid card number|incorrect_number/i, "The card number on file is wrong"],
  [/expired/i, "The card has expired"],
  [/no (saved )?(payment method|card)|no_card_on_file|no vault/i, "No card on file"],
  [/authentication|3ds|requires_action|verification/i, "The bank needs the customer to verify the card (3D Secure)"],
  [/general error|invalid amount|processor|gateway|timeout|network/i, "A processor error, not a card problem"],
];

export function plainDeclineReason(reason: string | null | undefined): string {
  const raw = rawDeclineCode(reason);
  for (const [pattern, plain] of RULES) if (pattern.test(raw)) return plain;
  return "The card was declined";
}
