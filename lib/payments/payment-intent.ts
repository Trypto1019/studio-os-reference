/**
 * Pre-charge durability pattern.
 *
 * Replaces the "charge the gateway, then write the Payment row" anti-pattern
 * (a crash between the two loses the record of a real charge) with:
 *
 *   Tx A: INSERT Payment(chargeStatus=PENDING, idempotencyKey, requestHash,
 *         contextJson) and COMMIT before any gateway call.
 *   Gateway call, outside any transaction.
 *   Tx B: SELECT ... FOR UPDATE the Payment row,
 *         chargeStatus=SUCCEEDED + gatewayTransactionId,
 *         run the typed fulfillment handler (payment-fulfillment.ts),
 *         fulfillmentStatus=APPLIED, audit log, COMMIT.
 *
 * Declined: one UPDATE to FAILED with the reason and decline detail.
 * Error/timeout: UPDATE to UNKNOWN; reconciliation (reconcile.ts) or the
 * gateway webhook resolves it later by querying the gateway by id.
 *
 * Idempotency: the caller-supplied idempotencyKey sits behind a partial
 * unique index (WHERE "idempotencyKey" IS NOT NULL). A duplicate INSERT is
 * caught and translated into a typed result. requestHash (SHA-256 of the
 * canonical request) tells a legitimate retry apart from key reuse with a
 * different payload, which the route layer turns into HTTP 409.
 *
 * This module does no permission checks or slot resolution; callers do that
 * first. Result types say what happened; routes translate them to HTTP.
 */

import { createHash } from "node:crypto";
import { UniqueViolationError, type PaymentRow, type Store } from "../db/types.ts";
import type { ChargeGateway, Gateways, GatewayOutcome, PaymentMethod } from "./gateway.ts";
import {
  harvestEntityIds,
  parsePaymentContext,
  runFulfillmentHandler,
  type EntityIds,
  type PaymentContext,
} from "./payment-fulfillment.ts";

export type { PaymentContext } from "./payment-fulfillment.ts";

export interface PaymentDeps {
  store: Store;
  gateways: Gateways;
  brandName: string;
  now?: () => Date;
  /**
   * Best-effort side effects that must never roll back a committed payment
   * (referral credit, "session booked" automations, dunning-task cleanup).
   * Runs after Tx B commits and only when fulfillment actually ran.
   */
  afterFulfilled?: (payment: PaymentRow, entityIds: EntityIds) => Promise<void>;
  log?: Pick<Console, "error" | "warn">;
}

export interface PaymentIntentInput {
  customerId: string;
  amountCents: number;
  context: PaymentContext;
  paymentMethod: PaymentMethod;
  /**
   * Stable per logical charge, e.g. `renewal:${membershipId}:${cycle}`.
   * Without it the call is treated as a fresh request every time.
   */
  idempotencyKey?: string;
  description?: string;
  createdByUserId?: string;
  cardLastFour?: string;
}

export type PaymentIntentResult =
  | { kind: "succeeded"; payment: PaymentRow; entityIds: EntityIds; authCode?: string }
  | { kind: "failed"; payment: PaymentRow; reason: string }
  | { kind: "unknown"; payment: PaymentRow; reason: string }
  /** 3DS/SCA needed: terminal for this row, route the customer to card update. */
  | { kind: "requires_action"; payment: PaymentRow; reason: string }
  /** Same key, original still in flight. Do not call the gateway again. */
  | { kind: "duplicate_pending"; payment: PaymentRow }
  /** Same key + same payload, already charged. Replay the original result. */
  | { kind: "duplicate_succeeded"; payment: PaymentRow; entityIds: EntityIds }
  | { kind: "idempotency_misuse"; existingPayment: PaymentRow; reason: string };

/**
 * Stripe rail allowlist: the only contexts a Stripe charge may originate
 * from. New kinds are excluded until deliberately added (allowlist, not
 * blocklist).
 */
export const STRIPE_CHARGEABLE_CONTEXTS: ReadonlyArray<PaymentContext["kind"]> = [
  "MEMBERSHIP_RENEWAL",
  "MANUAL_CHARGE",
  "NO_SHOW_FEE",
];

const clock = (deps: PaymentDeps) => (deps.now ? deps.now() : new Date());

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function chargeWithIntent(
  deps: PaymentDeps,
  input: PaymentIntentInput,
): Promise<PaymentIntentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("amountCents must be a positive integer");
  }
  const requestHash = computeRequestHash(input);
  const gatewayName = input.paymentMethod.kind === "stripe_customer" ? "STRIPE" : "NMI";

  // Tx A: durable PENDING row before the gateway is touched.
  let pending: PaymentRow;
  try {
    pending = await deps.store.tx((tx) =>
      tx.insertPayment({
        customerId: input.customerId,
        amountCents: input.amountCents,
        type: "charge",
        status: "pending",
        gateway: gatewayName,
        description: input.description ?? null,
        createdByUserId: input.createdByUserId ?? null,
        cardLastFour: input.cardLastFour ?? null,
        chargeStatus: "PENDING",
        fulfillmentStatus: "NOT_STARTED",
        paymentType: input.context.kind,
        idempotencyKey: input.idempotencyKey ?? null,
        requestHash,
        contextJson: input.context,
        gatewayRequestedAt: clock(deps),
      }),
    );
  } catch (err) {
    if (err instanceof UniqueViolationError && input.idempotencyKey) {
      return resolveDuplicate(deps, input.idempotencyKey, requestHash);
    }
    throw err;
  }

  const gateway = await callGateway(deps, input, pending.id);

  if (gateway.outcome === "approved") {
    const finalized = await finalizeSucceeded(deps, pending.id, gateway.transactionId, {
      authCode: gateway.authCode,
      createdByUserId: input.createdByUserId,
      gatewayRespondedAt: clock(deps),
    });
    return { kind: "succeeded", payment: finalized.payment, entityIds: finalized.entityIds, authCode: gateway.authCode };
  }
  if (gateway.outcome === "declined") {
    const payment = await finalizeFailed(deps, pending.id, gateway.responseCode, gateway.responseText, gateway.declineDetail);
    return { kind: "failed", payment, reason: gateway.responseText };
  }
  if (gateway.outcome === "requires_action") {
    const payment = await finalizeFailed(deps, pending.id, "requires_action", gateway.responseText);
    return { kind: "requires_action", payment, reason: gateway.responseText };
  }
  const payment = await markUnknown(deps, pending.id, gateway.responseText);
  return { kind: "unknown", payment, reason: gateway.responseText };
}

// ---------------------------------------------------------------------------
// Request hash
// ---------------------------------------------------------------------------

/**
 * Canonical fields that DEFINE the request. Only caller-supplied ids are
 * included; handler-written output ids (billingEventId, packageId) are not,
 * because they would be absent on a retry.
 */
export function computeRequestHash(input: PaymentIntentInput): string {
  const m = input.paymentMethod;
  const method = m.kind === "vault" ? `vault:${m.vaultId}` : `stripe:${m.stripeCustomerId}`;
  const entityIds = contextEntityIds(input.context).sort().join(",");
  const canonical = [
    `customerId=${input.customerId}`,
    `amountCents=${input.amountCents}`,
    `kind=${input.context.kind}`,
    `method=${method}`,
    `entityIds=${entityIds}`,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function contextEntityIds(context: PaymentContext): string[] {
  switch (context.kind) {
    case "MEMBERSHIP_RENEWAL":
      return [`membership:${context.membershipId}`];
    case "PACKAGE_PURCHASE":
      return [`product:${context.productId}:${context.credits}`];
    case "MANUAL_CHARGE":
      return [`reason:${context.reason}`];
    case "NO_SHOW_FEE":
      return [`fee:${context.feeId}`, `session:${context.sessionId}`];
  }
}

// ---------------------------------------------------------------------------
// Gateway call (dual rail)
// ---------------------------------------------------------------------------

async function callGateway(
  deps: PaymentDeps,
  input: PaymentIntentInput,
  paymentId: string,
): Promise<GatewayOutcome> {
  const description = input.description ?? `${deps.brandName} charge ${input.context.kind}`;

  let gateway: ChargeGateway | undefined;
  if (input.paymentMethod.kind === "stripe_customer") {
    if (!STRIPE_CHARGEABLE_CONTEXTS.includes(input.context.kind)) {
      return {
        outcome: "declined",
        responseCode: "STRIPE_CONTEXT_NOT_ALLOWED",
        responseText: `Context ${input.context.kind} is not allowlisted for the Stripe rail (no charge attempted)`,
      };
    }
    gateway = deps.gateways.STRIPE;
    if (!gateway) {
      return { outcome: "declined", responseCode: "STRIPE_DISABLED", responseText: "Stripe rail not configured (no charge attempted)" };
    }
  } else {
    gateway = deps.gateways.NMI;
  }

  return gateway.charge({
    paymentId,
    amountCents: input.amountCents,
    method: input.paymentMethod,
    description,
    idempotencyKey: input.idempotencyKey,
    metadata: { os_payment_id: paymentId, os_customer_id: input.customerId, os_context_kind: input.context.kind },
    // Persist the gateway id BEFORE confirmation so an UNKNOWN outcome is
    // always resolvable by retrieve-by-id (never by search).
    onTransactionCreated: async (transactionId) => {
      await deps.store.tx((tx) => tx.updatePayment(paymentId, { gatewayTransactionId: transactionId }));
    },
  });
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

/**
 * Lock the row, mark SUCCEEDED, run the fulfillment handler, mark APPLIED,
 * audit, all in one transaction. Exported for reconciliation and webhooks.
 * Replay-safe: an already SUCCEEDED+APPLIED row short-circuits, and handlers
 * are idempotent via their context output ids.
 */
export async function finalizeSucceeded(
  deps: PaymentDeps,
  paymentId: string,
  transactionId: string,
  options: { authCode?: string; createdByUserId?: string; gatewayRespondedAt?: Date } = {},
): Promise<{ payment: PaymentRow; entityIds: EntityIds; wasReplay: boolean }> {
  const result = await deps.store.tx(async (tx) => {
    const locked = await tx.lockPayment(paymentId);
    if (!locked) throw new Error(`Payment ${paymentId} vanished during finalization`);

    if (locked.chargeStatus === "SUCCEEDED" && locked.fulfillmentStatus === "APPLIED") {
      return { payment: locked, entityIds: harvestEntityIds(parsePaymentContext(locked)), wasReplay: true };
    }

    // Preserve the ORIGINAL gateway clock on late replays, so a reconciled
    // charge is never re-dated to "now".
    const respondedAt =
      locked.gatewayRespondedAt ?? options.gatewayRespondedAt ?? locked.gatewayRequestedAt ?? clock(deps);
    const charged = await tx.updatePayment(paymentId, {
      chargeStatus: "SUCCEEDED",
      status: "completed",
      gatewayTransactionId: transactionId,
      gatewayRespondedAt: respondedAt,
      processedAt: locked.processedAt ?? respondedAt,
    });

    const context = parsePaymentContext(charged);
    const entityIds = await runFulfillmentHandler(tx, charged, context, clock(deps));
    await tx.updatePayment(paymentId, { fulfillmentStatus: "APPLIED", fulfilledAt: clock(deps) });
    await tx.audit({
      userId: options.createdByUserId ?? null,
      action: `PAYMENT_FULFILLED_${charged.paymentType}`,
      entityType: "Payment",
      entityId: paymentId,
      details: {
        customerId: charged.customerId,
        amountCents: charged.amountCents,
        gatewayTransactionId: transactionId,
        ...(options.authCode ? { authCode: options.authCode } : {}),
        entityIds,
      },
    });
    const final = await tx.getPayment(paymentId);
    return { payment: final!, entityIds, wasReplay: false };
  });

  if (!result.wasReplay && deps.afterFulfilled) {
    try {
      await deps.afterFulfilled(result.payment, result.entityIds);
    } catch (err) {
      (deps.log ?? console).error(`[payment-intent] post-commit hook failed for ${paymentId}:`, err);
    }
  }
  return result;
}

export async function finalizeFailed(
  deps: PaymentDeps,
  paymentId: string,
  responseCode: string,
  responseText: string,
  declineDetail?: Record<string, string>,
): Promise<PaymentRow> {
  return deps.store.tx((tx) =>
    tx.updatePayment(paymentId, {
      chargeStatus: "FAILED",
      status: "failed",
      gatewayRespondedAt: clock(deps),
      failureReasonCode: responseCode,
      failureReasonText: responseText,
      ...(declineDetail && Object.keys(declineDetail).length > 0 ? { gatewayDeclineDetail: declineDetail } : {}),
    }),
  );
}

/** Gateway state cannot be determined. Reconciliation or staff resolve it. */
export async function markUnknown(deps: PaymentDeps, paymentId: string, responseText: string): Promise<PaymentRow> {
  return deps.store.tx((tx) =>
    tx.updatePayment(paymentId, {
      chargeStatus: "UNKNOWN",
      gatewayRespondedAt: clock(deps),
      failureReasonText: responseText,
    }),
  );
}

// ---------------------------------------------------------------------------
// Duplicate idempotency-key resolution
// ---------------------------------------------------------------------------

async function resolveDuplicate(
  deps: PaymentDeps,
  idempotencyKey: string,
  requestHash: string,
): Promise<PaymentIntentResult> {
  const existing = await deps.store.tx((tx) => tx.findPaymentByIdempotencyKey(idempotencyKey));
  if (!existing) {
    throw new Error(`Idempotency conflict fired but no row found for key ${idempotencyKey}`);
  }
  const misuse = (reason: string): PaymentIntentResult => ({ kind: "idempotency_misuse", existingPayment: existing, reason });

  switch (existing.chargeStatus) {
    case "PENDING":
      return { kind: "duplicate_pending", payment: existing };
    case "SUCCEEDED":
      if (existing.requestHash !== requestHash) {
        return misuse("idempotencyKey reused with different request payload");
      }
      return { kind: "duplicate_succeeded", payment: existing, entityIds: harvestEntityIds(parsePaymentContext(existing)) };
    case "FAILED":
      return misuse("idempotencyKey was already used for a failed charge; use a new key to retry");
    case "UNKNOWN":
      return misuse("idempotencyKey was used for a charge with UNKNOWN status; manual review required");
    case "REFUNDED":
    case "REVERSED":
      return misuse(`idempotencyKey was already used for a ${existing.chargeStatus.toLowerCase()} charge`);
    case null:
      return misuse("idempotencyKey collides with a legacy Payment row");
  }
}

/** HTTP mapping used by the route layer. */
export function httpStatusFor(result: PaymentIntentResult): number {
  switch (result.kind) {
    case "succeeded":
    case "duplicate_succeeded":
      return 200;
    case "duplicate_pending":
      return 202;
    case "failed":
    case "requires_action":
      return 402;
    case "unknown":
      return 502;
    case "idempotency_misuse":
      return 409;
  }
}
