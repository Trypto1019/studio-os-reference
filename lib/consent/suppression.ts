/**
 * SMS suppression list (carrier STOP + staff opt-out), keyed by a normalized
 * phone so inbound STOP, staff edits and the outbound send check all agree.
 *
 * Two rules from production:
 *   - Create-only upsert: a staff opt-out never overwrites an existing
 *     carrier-STOP reason (the carrier reason is the stronger record).
 *   - Clearing is guarded: a staff opt-in removes only a staff-created row,
 *     and only if no OTHER opted-out customer shares the same normalized
 *     number (families share phones). No substring matching.
 */

export const CUSTOMER_SMS_OPT_OUT_REASON = "customer_sms_opt_out";
export const CARRIER_STOP_REASON = "carrier_stop";

export interface SuppressionClient {
  upsertSuppressionCreateOnly(phone: string, reason: string): Promise<void>;
  deleteSuppression(phone: string, reason: string): Promise<number>;
  isSuppressed(phone: string): Promise<boolean>;
  /** Phones of every OTHER customer currently opted out of SMS. */
  otherOptedOutPhones(customerId: string): Promise<Array<string | null>>;
  setCustomerSmsOptOut(customerId: string, optedOut: boolean, at: Date): Promise<void>;
}

export type SuppressionResult =
  | { status: "ensured" }
  | { status: "deleted" }
  | { status: "preserved_other_opt_out" }
  | { status: "preserved_non_staff_reason" }
  | { status: "skipped_invalid_phone" };

/** Digits only; a leading US country code is dropped from 11-digit numbers. */
export function normalizeSmsPhone(phone: string | null | undefined): string | null {
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

export async function ensureSuppression(
  client: SuppressionClient,
  phone: string | null | undefined,
  reason: string = CUSTOMER_SMS_OPT_OUT_REASON,
): Promise<SuppressionResult> {
  const normalized = normalizeSmsPhone(phone);
  if (!normalized) return { status: "skipped_invalid_phone" };
  await client.upsertSuppressionCreateOnly(normalized, reason);
  return { status: "ensured" };
}

export async function clearStaffSuppressionIfSafe(
  client: SuppressionClient,
  args: { customerId: string; phone: string | null | undefined },
): Promise<SuppressionResult> {
  const normalized = normalizeSmsPhone(args.phone);
  if (!normalized) return { status: "skipped_invalid_phone" };
  const others = await client.otherOptedOutPhones(args.customerId);
  if (others.some((p) => normalizeSmsPhone(p) === normalized)) return { status: "preserved_other_opt_out" };
  const deleted = await client.deleteSuppression(normalized, CUSTOMER_SMS_OPT_OUT_REASON);
  return deleted > 0 ? { status: "deleted" } : { status: "preserved_non_staff_reason" };
}

export async function applyStaffSmsOptOutChange(
  client: SuppressionClient,
  args: { customerId: string; phone: string | null | undefined; smsOptOut: boolean; now: Date },
): Promise<SuppressionResult> {
  await client.setCustomerSmsOptOut(args.customerId, args.smsOptOut, args.now);
  return args.smsOptOut
    ? ensureSuppression(client, args.phone)
    : clearStaffSuppressionIfSafe(client, { customerId: args.customerId, phone: args.phone });
}

/** In-memory client for tests and the demo. */
export class MemorySuppressionClient implements SuppressionClient {
  rows = new Map<string, string>();
  customers = new Map<string, { phone: string | null; smsOptOut: boolean }>();
  async upsertSuppressionCreateOnly(phone: string, reason: string) {
    if (!this.rows.has(phone)) this.rows.set(phone, reason);
  }
  async deleteSuppression(phone: string, reason: string) {
    if (this.rows.get(phone) === reason) {
      this.rows.delete(phone);
      return 1;
    }
    return 0;
  }
  async isSuppressed(phone: string) {
    const n = normalizeSmsPhone(phone);
    return n !== null && this.rows.has(n);
  }
  async otherOptedOutPhones(customerId: string) {
    return [...this.customers.entries()].filter(([id, c]) => id !== customerId && c.smsOptOut).map(([, c]) => c.phone);
  }
  async setCustomerSmsOptOut(customerId: string, optedOut: boolean) {
    const c = this.customers.get(customerId) ?? { phone: null, smsOptOut: false };
    this.customers.set(customerId, { ...c, smsOptOut: optedOut });
  }
}
