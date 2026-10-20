/**
 * STOP acknowledgment as an unforgeable, single-use capability.
 *
 * Carrier rules require exactly one confirmation reply to STOP, and that reply
 * must go out even though the number is now suppressed. The transport layer
 * therefore needs ONE exemption from the suppression check, and it must not
 * be selectable by a request flag or by copying the fixed text.
 *
 * Only the consent handler, after committing a NEW suppression, creates the
 * options object and registers it in a WeakSet for the duration of the send.
 * The transport asks `isAuthorizedOptOutAcknowledgment(opts)`, which checks
 * object identity AND the exact text, so the exemption cannot carry any
 * other message.
 */

export interface SendSmsOptions {
  to: string;
  body: string;
  from?: string;
}
export interface SendSmsResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export function optOutAckText(brandName: string): string {
  return `${brandName}: You are unsubscribed. No further messages will be sent. Reply UNSTOP to subscribe again.`;
}

const acknowledgments = new WeakMap<SendSmsOptions, string>();

export function isAuthorizedOptOutAcknowledgment(opts: SendSmsOptions): boolean {
  const expected = acknowledgments.get(opts);
  return expected !== undefined && opts.body === expected;
}

export async function sendNewOptOutAcknowledgment(
  brandName: string,
  to: string,
  send: (opts: SendSmsOptions) => Promise<SendSmsResult>,
  from?: string,
): Promise<SendSmsResult> {
  const body = optOutAckText(brandName);
  const opts: SendSmsOptions = { to, body, ...(from ? { from } : {}) };
  acknowledgments.set(opts, body);
  try {
    return await send(opts);
  } finally {
    acknowledgments.delete(opts);
  }
}
