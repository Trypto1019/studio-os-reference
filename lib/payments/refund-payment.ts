/**
 * Payment-scoped, MONEY-ONLY refund.
 *
 * Refunds any gateway charge by Payment id. It never cancels a membership,
 * reverses an entitlement or touches billing cycles: a wrong renewal charge
 * means the card was hit in error; the customer is still a member, so the
 * money goes back and everything else stays as it was.
 *
 * Gateway behaviour follows the ORIGINAL row's rail (never the customer's
 * current rail):
 *   - NMI full refund  -> refundOrVoid (void if unsettled, refund if settled)
 *   - NMI partial      -> refund only, rejected inside the 24h settlement
 *                         window (void is full-only and would over-refund)
 *   - Stripe           -> refund against the PaymentIntent; partials native,
 *                         no settlement gate
 *
 * Idempotency: the refund row carries the caller's idempotencyKey (same
 * unique index as charges). A replay returns the prior row, completed or
 * failed, without touching the gateway. Remaining refundable =
 * original.amount - sum(completed refund rows with parentPaymentId).
 * The original flips to REFUNDED only when fully exhausted.
 *
 * Runs inside one transaction with the original row locked FOR UPDATE. On a
 * gateway decline the transaction rolls back and refundPayment() records a
 * terminal failed refund row OUTSIDE it, so the key cannot be retried into a
 * double refund.
 */

import type { PaymentGateway, PaymentRow, Store, Tx } from "../db/types.ts";
import type { ChargeGateway } from "./gateway.ts";

const SETTLEMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export class PaymentRefundError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PaymentRefundError";
  }
}

export interface GatewayFailureContext {
  customerId: string;
  originalPaymentId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
  gateway: PaymentGateway;
  settlementNote: string;
  gatewayError: string;
}

export class RefundGatewayError extends Error {
  constructor(public readonly context: GatewayFailureContext) {
    super(context.gatewayError);
    this.name = "RefundGatewayError";
  }
}

export interface RefundInput {
  paymentId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
  userId: string;
}

export type RefundOutcome =
  | {
      kind: "ok";
      refundPaymentId: string;
      action: "refund" | "void";
      amountCents: number;
      remainingRefundableCents: number;
      fullyRefunded: boolean;
    }
  | { kind: "idempotent"; refundPaymentId: string; amountCents: number }
  | { kind: "idempotent_failed"; refundPaymentId: string; failureReasonText: string | null };

export interface RefundDeps {
  store: Store;
  nmi: ChargeGateway;
  stripe?: ChargeGateway;
  now?: () => Date;
}

/** Public entry point: transaction + terminal failure record on decline. */
export async function refundPayment(deps: RefundDeps, input: RefundInput): Promise<RefundOutcome> {
  try {
    return await deps.store.tx((tx) => refundInTx(tx, deps, input));
  } catch (err) {
    if (!(err instanceof RefundGatewayError)) throw err;
    const c = err.context;
    await deps.store.tx(async (tx) => {
      await tx.insertPayment({
        customerId: c.customerId,
        amountCents: -c.amountCents,
        type: "refund",
        status: "failed",
        gateway: c.gateway,
        idempotencyKey: c.idempotencyKey,
        parentPaymentId: c.originalPaymentId,
        failureReasonText: c.gatewayError,
        description: `Refund attempt failed: ${c.reason}`,
        createdByUserId: input.userId,
      });
      await tx.audit({
        userId: input.userId,
        action: "PAYMENT_REFUND_FAILED",
        entityType: "Payment",
        entityId: c.originalPaymentId,
        details: { amountCents: c.amountCents, settlementNote: c.settlementNote, error: c.gatewayError },
      });
    });
    throw err;
  }
}

export async function refundInTx(tx: Tx, deps: RefundDeps, input: RefundInput): Promise<RefundOutcome> {
  const now = deps.now ? deps.now() : new Date();

  // A. Lock the original row.
  const locked = await tx.lockPayment(input.paymentId);
  if (!locked) throw new PaymentRefundError(404, "Payment not found");

  // B. Idempotency by key.
  const prior = await tx.findPaymentByIdempotencyKey(input.idempotencyKey);
  if (prior) {
    if (prior.parentPaymentId !== input.paymentId) {
      throw new PaymentRefundError(409, "Idempotency key reused for a different payment");
    }
    if (prior.status === "failed") {
      return { kind: "idempotent_failed", refundPaymentId: prior.id, failureReasonText: prior.failureReasonText };
    }
    return { kind: "idempotent", refundPaymentId: prior.id, amountCents: Math.abs(prior.amountCents) };
  }

  // C. Validate the original charge.
  const original = locked;
  if (original.type === "refund" || original.amountCents < 0) {
    throw new PaymentRefundError(422, "This row is a refund, not a charge.");
  }
  if (original.status !== "completed") {
    throw new PaymentRefundError(422, `Only completed charges can be refunded (status=${original.status}).`);
  }
  if (original.gateway !== "NMI" && original.gateway !== "STRIPE") {
    throw new PaymentRefundError(422, `Only NMI or Stripe charges can be refunded here (gateway=${original.gateway}).`);
  }
  if (original.gateway === "STRIPE" && !deps.stripe) {
    throw new PaymentRefundError(422, "Stripe refund gateway not available.");
  }
  if (!original.gatewayTransactionId) {
    // e.g. charges imported from the legacy booking vendor: the gateway id
    // was never exposed, so they can only be refunded manually.
    throw new PaymentRefundError(422, "This charge has no gateway transaction id and is not gateway-refundable.");
  }

  // D. Remaining refundable.
  const refunds = await tx.listPayments(
    (p) => p.parentPaymentId === original.id && p.type === "refund" && p.status === "completed",
  );
  const refundedCents = refunds.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
  const remainingBefore = Math.max(original.amountCents - refundedCents, 0);
  if (remainingBefore === 0) throw new PaymentRefundError(409, "This charge is already fully refunded.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new PaymentRefundError(400, "amountCents must be a positive integer");
  }
  if (input.amountCents > remainingBefore) {
    throw new PaymentRefundError(409, "Refund amount exceeds remaining refundable balance", {
      remainingRefundableCents: remainingBefore,
    });
  }
  const isPartial = input.amountCents < remainingBefore;
  const txnId = original.gatewayTransactionId;

  // E. Gateway action, branched by the original rail.
  const fail = (settlementNote: string, gatewayError: string) =>
    new RefundGatewayError({
      customerId: original.customerId,
      originalPaymentId: original.id,
      amountCents: input.amountCents,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      gateway: original.gateway,
      settlementNote,
      gatewayError,
    });

  let action: "refund" | "void";
  let refundTxnId: string | null;
  let settlementNote: string;

  if (original.gateway === "STRIPE") {
    const r = await deps.stripe!.refund(txnId, input.amountCents, `refund-${input.idempotencyKey}`);
    if (!r.success) throw fail("stripe-refund", r.error ?? "Stripe refund failed");
    action = "refund";
    refundTxnId = r.transactionId ?? null;
    settlementNote = "stripe-refund";
  } else {
    if (isPartial && now.getTime() - original.createdAt.getTime() < SETTLEMENT_WINDOW_MS) {
      const waitUntil = new Date(original.createdAt.getTime() + SETTLEMENT_WINDOW_MS);
      throw new PaymentRefundError(
        422,
        `Partial refunds are available once the charge settles (~24h). Wait until ${waitUntil.toISOString()} or refund the full amount.`,
        { waitUntil: waitUntil.toISOString() },
      );
    }
    const r = isPartial
      ? await deps.nmi.refund(txnId, input.amountCents)
      : await deps.nmi.refundOrVoid(txnId, input.amountCents);
    settlementNote = isPartial ? "partial-refund-after-24h-gate" : `full-refund-or-void:${r.action}`;
    if (!r.success) throw fail(settlementNote, r.error ?? "Gateway refund failed");
    action = r.action;
    refundTxnId = r.transactionId ?? null;
  }

  return finalizeRefundWrites(tx, { original, input, now, refundTxnId, action, settlementNote, remainingBefore });
}

async function finalizeRefundWrites(
  tx: Tx,
  a: {
    original: PaymentRow;
    input: RefundInput;
    now: Date;
    refundTxnId: string | null;
    action: "refund" | "void";
    settlementNote: string;
    remainingBefore: number;
  },
): Promise<RefundOutcome> {
  const refundRow = await tx.insertPayment({
    customerId: a.original.customerId,
    amountCents: -a.input.amountCents,
    type: "refund",
    status: "completed",
    gateway: a.original.gateway,
    gatewayTransactionId: a.refundTxnId,
    idempotencyKey: a.input.idempotencyKey,
    parentPaymentId: a.original.id,
    description: `Refund of payment ${a.original.id}: ${a.input.reason}`,
    processedAt: a.now,
    createdByUserId: a.input.userId,
  });
  const remainingAfter = a.remainingBefore - a.input.amountCents;
  const fullyRefunded = remainingAfter === 0;
  if (fullyRefunded) await tx.updatePayment(a.original.id, { chargeStatus: "REFUNDED" });

  await tx.audit({
    userId: a.input.userId,
    action: "PAYMENT_REFUND",
    entityType: "Payment",
    entityId: a.original.id,
    details: {
      refundPaymentId: refundRow.id,
      amountCents: a.input.amountCents,
      reason: a.input.reason,
      gateway: a.original.gateway,
      gatewayAction: a.action,
      settlementNote: a.settlementNote,
      fullyRefunded,
      remainingRefundableCents: remainingAfter,
      // Explicit money-only markers.
      moneyOnly: true,
      membershipTouched: false,
      entitlementReversed: false,
    },
  });
  return {
    kind: "ok",
    refundPaymentId: refundRow.id,
    action: a.action,
    amountCents: a.input.amountCents,
    remainingRefundableCents: remainingAfter,
    fullyRefunded,
  };
}
