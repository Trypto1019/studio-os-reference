/**
 * Typed fulfillment handlers.
 *
 * After a charge is approved, finalizeSucceeded() runs exactly one handler
 * from FULFILLMENT_HANDLERS inside the finalization transaction, while the
 * Payment row is locked. Handlers MUST be idempotent: the reconciliation job
 * re-runs them for rows left at chargeStatus=SUCCEEDED with
 * fulfillmentStatus != APPLIED.
 *
 * Idempotency strategy: a handler writes the ids of the entities it creates
 * back into Payment.contextJson in the same transaction. On replay it finds
 * those ids and returns without creating anything twice.
 *
 * PaymentContext is a discriminated union keyed by `kind`, and `kind` equals
 * the PaymentFlow column. Each handler asserts payment.paymentType ===
 * context.kind to defend against a corrupted contextJson row.
 *
 * The production system had ten flows (POS sale, booking charge, add-ons,
 * shared/family memberships, scheduled charges, ...). Four representative
 * ones are kept here.
 */

import type { PaymentFlow, PaymentRow, Tx } from "../db/types.ts";

export type PaymentContext =
  | {
      kind: "MEMBERSHIP_RENEWAL";
      membershipId: string;
      /** Staff-initiated retry: logged as RETRY instead of CHARGE_SUCCESS. */
      isRetry?: boolean;
      /** Output id, written by the handler for replay safety. */
      billingEventId?: string;
    }
  | {
      kind: "PACKAGE_PURCHASE";
      productId: string;
      credits: number;
      validDays: number;
      packageId?: string;
    }
  | { kind: "MANUAL_CHARGE"; reason: string }
  | { kind: "NO_SHOW_FEE"; feeId: string; sessionId: string };

export type EntityIds = {
  membershipId?: string;
  billingEventId?: string;
  packageId?: string;
  feeId?: string;
};

type Handler<K extends PaymentFlow> = (
  tx: Tx,
  payment: PaymentRow,
  context: Extract<PaymentContext, { kind: K }>,
  now: Date,
) => Promise<EntityIds>;

export function parsePaymentContext(payment: Pick<PaymentRow, "contextJson" | "paymentType" | "id">): PaymentContext {
  const ctx = payment.contextJson as PaymentContext | null;
  if (!ctx || typeof ctx !== "object" || typeof ctx.kind !== "string") {
    throw new Error(`Payment ${payment.id} has no contextJson`);
  }
  if (payment.paymentType && ctx.kind !== payment.paymentType) {
    throw new Error(`Payment ${payment.id} context kind ${ctx.kind} != paymentType ${payment.paymentType}`);
  }
  return ctx;
}

async function patchContext(tx: Tx, payment: PaymentRow, patch: Record<string, unknown>): Promise<void> {
  await tx.updatePayment(payment.id, {
    contextJson: { ...(payment.contextJson as Record<string, unknown>), ...patch },
  });
}

/** Add calendar months in UTC, clamping to month end (Jan 31 + 1mo = Feb 28/29). */
export function addMonthsClamped(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * Price step-down: given the cycle count that was just charged, what should
 * the NEXT cycle cost? Tiers are ascending by `uptoCycle` (null = open-ended).
 * Returns null when there are no tiers or the price would not change.
 *
 * Example: [{uptoCycle: 6, priceCents: 18900}, {uptoCycle: null, priceCents: 11900}]
 *   cycles 1..6 bill at 189.00; from cycle 7 the membership bills at 119.00.
 */
export function computeNextBillingPrice(args: {
  priceTiers: Array<{ uptoCycle: number | null; priceCents: number }> | null;
  newCyclesBilled: number;
  currentPriceCents: number;
}): number | null {
  const tiers = args.priceTiers;
  if (!tiers || tiers.length === 0) return null;
  const match =
    tiers.find((t) => t.uptoCycle === null || args.newCyclesBilled < t.uptoCycle) ??
    tiers[tiers.length - 1];
  return match.priceCents === args.currentPriceCents ? null : match.priceCents;
}

const membershipRenewal: Handler<"MEMBERSHIP_RENEWAL"> = async (tx, payment, ctx, now) => {
  if (ctx.billingEventId) {
    return { membershipId: ctx.membershipId, billingEventId: ctx.billingEventId };
  }
  const m = await tx.getMembership(ctx.membershipId);
  if (!m) throw new Error(`Membership ${ctx.membershipId} not found`);

  const newEnd = addMonthsClamped(m.currentPeriodEnd, m.billingIntervalMonths);
  const cyclesBilled = m.cyclesBilled + 1;
  const nextPrice = m.priceLocked
    ? null
    : computeNextBillingPrice({ priceTiers: m.priceTiers, newCyclesBilled: cyclesBilled, currentPriceCents: m.billingPriceCents });

  await tx.updateMembership(m.id, {
    status: "ACTIVE",
    currentPeriodStart: m.currentPeriodEnd,
    currentPeriodEnd: newEnd,
    nextBillingDate: newEnd,
    cyclesBilled,
    billingFailureCount: 0,
    lastBilledAt: now,
    ...(nextPrice !== null ? { billingPriceCents: nextPrice } : {}),
  });
  const event = await tx.insertBillingEvent({
    customerId: payment.customerId,
    membershipId: m.id,
    type: ctx.isRetry ? "RETRY" : "CHARGE_SUCCESS",
    amountCents: payment.amountCents,
    gateway: payment.gateway,
    gatewayTransactionId: payment.gatewayTransactionId,
  });
  await patchContext(tx, payment, { billingEventId: event.id });
  return { membershipId: m.id, billingEventId: event.id };
};

const packagePurchase: Handler<"PACKAGE_PURCHASE"> = async (tx, payment, ctx, now) => {
  if (ctx.packageId) return { packageId: ctx.packageId };
  const pkg = await tx.insertCreditPackage({
    customerId: payment.customerId,
    productId: ctx.productId,
    creditsTotal: ctx.credits,
    creditsRemaining: ctx.credits,
    paymentId: payment.id,
    expiresAt: new Date(now.getTime() + ctx.validDays * 86_400_000),
  });
  await patchContext(tx, payment, { packageId: pkg.id });
  return { packageId: pkg.id };
};

const manualCharge: Handler<"MANUAL_CHARGE"> = async () => ({});

const noShowFee: Handler<"NO_SHOW_FEE"> = async (tx, payment, ctx) => {
  const fee = await tx.getFee(ctx.feeId);
  if (!fee) throw new Error(`Fee ${ctx.feeId} not found`);
  if (fee.status !== "PAID") {
    await tx.updateFee(fee.id, { status: "PAID", paymentId: payment.id });
  }
  return { feeId: fee.id };
};

export const FULFILLMENT_HANDLERS: { [K in PaymentFlow]: Handler<K> } = {
  MEMBERSHIP_RENEWAL: membershipRenewal,
  PACKAGE_PURCHASE: packagePurchase,
  MANUAL_CHARGE: manualCharge,
  NO_SHOW_FEE: noShowFee,
};

export async function runFulfillmentHandler(
  tx: Tx,
  payment: PaymentRow,
  context: PaymentContext,
  now: Date,
): Promise<EntityIds> {
  const handler = FULFILLMENT_HANDLERS[context.kind] as Handler<typeof context.kind>;
  return handler(tx, payment, context as never, now);
}

/** Entity ids a completed payment produced, read back from contextJson. */
export function harvestEntityIds(context: PaymentContext): EntityIds {
  switch (context.kind) {
    case "MEMBERSHIP_RENEWAL":
      return { membershipId: context.membershipId, ...(context.billingEventId ? { billingEventId: context.billingEventId } : {}) };
    case "PACKAGE_PURCHASE":
      return context.packageId ? { packageId: context.packageId } : {};
    case "MANUAL_CHARGE":
      return {};
    case "NO_SHOW_FEE":
      return { feeId: context.feeId };
  }
}
