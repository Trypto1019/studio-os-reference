/**
 * Stripe webhook receiver (framework-light: Web Request in, Web Response out;
 * see examples/next for the three-line Next.js adapter).
 *
 * Security: raw-body signature verification. Bad/missing signature -> 400,
 * nothing persisted. Secret unset -> 503 so Stripe keeps retrying while the
 * endpoint is dark. The path is on the middleware public allowlist: the
 * signature IS the credential.
 *
 * Persistence: every verified event is written append-only as an AuditLog
 * row (action=STRIPE_WEBHOOK_EVENT, entityId=event.id). That row doubles as
 * the idempotency guard: a redelivered event id is acknowledged and skipped.
 *
 * Handlers (everything else is logged, not handled):
 *   charge.dispute.created         -> urgent StaffTask
 *   payment_intent.succeeded       -> idempotent finalizeSucceeded for a
 *                                     PENDING/UNKNOWN Stripe Payment row
 *   payment_intent.payment_failed  -> idempotent finalizeFailed likewise
 *   charge.refunded/refund.updated -> detect refunds issued in the Stripe
 *                                     dashboard with no local refund row
 *                                     -> StaffTask + audit
 */

import { verifyStripeSignature } from "../../../../lib/webhooks/signatures.ts";
import { finalizeFailed, finalizeSucceeded, type PaymentDeps } from "../../../../lib/payments/payment-intent.ts";

export interface StripeWebhookDeps extends PaymentDeps {
  webhookSecret: string | undefined;
  nowSec?: () => number;
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DAY_MS = 86_400_000;

export function createStripeWebhookHandler(deps: StripeWebhookDeps) {
  return async function POST(req: Request): Promise<Response> {
    if (!deps.webhookSecret) return json({ error: "Webhook secret not configured" }, 503);

    const rawBody = await req.text();
    const verified = verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), deps.webhookSecret, {
      nowSec: deps.nowSec?.(),
    });
    if (!verified.ok) {
      return json({ error: verified.reason === "missing_signature" ? "Missing signature" : "Invalid signature" }, 400);
    }

    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody) as StripeEvent;
    } catch {
      return json({ error: "Invalid payload" }, 400);
    }

    // Dedup + append-only record in ONE transaction, so two concurrent
    // deliveries of the same event cannot both pass the guard.
    const isNew = await deps.store.tx(async (tx) => {
      if (await tx.findAudit("STRIPE_WEBHOOK_EVENT", event.id)) return false;
      await tx.audit({
        userId: null,
        action: "STRIPE_WEBHOOK_EVENT",
        entityType: "StripeEvent",
        entityId: event.id,
        details: { type: event.type, created: event.created, livemode: event.livemode, payload: event },
      });
      return true;
    });
    if (!isNew) return json({ received: true, duplicate: true });

    try {
      const obj = event.data.object;
      switch (event.type) {
        case "charge.dispute.created":
          await handleDispute(deps, obj);
          break;
        case "payment_intent.succeeded":
          await reconcileIntent(deps, obj, "succeeded");
          break;
        case "payment_intent.payment_failed":
          await reconcileIntent(deps, obj, "failed");
          break;
        case "charge.refunded":
          await detectExternalRefund(deps, idOf(obj.payment_intent), Number(obj.amount_refunded ?? 0));
          break;
        case "refund.updated":
          if (obj.status === "succeeded") {
            await detectExternalRefund(deps, idOf(obj.payment_intent), Number(obj.amount ?? 0));
          }
          break;
        default:
          break; // logged-not-handled: the AuditLog row is the record
      }
    } catch (err) {
      // The event is durably recorded. A handler error must not make Stripe
      // redeliver forever (the dedup guard would skip the retry anyway).
      (deps.log ?? console).error(`[stripe-webhook] handler for ${event.type} (${event.id}) threw:`, err);
    }
    return json({ received: true });
  };
}

function idOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
}

async function handleDispute(deps: StripeWebhookDeps, dispute: Record<string, unknown>) {
  const piId = idOf(dispute.payment_intent);
  const payment = piId ? await deps.store.tx((tx) => tx.findPaymentByGatewayTxn("STRIPE", piId)) : null;
  const amount = (Number(dispute.amount ?? 0) / 100).toFixed(2);
  await deps.store.tx((tx) =>
    tx.createStaffTask({
      customerId: payment?.customerId ?? null,
      title: `URGENT: Stripe dispute ${String(dispute.id)} ($${amount})`,
      description:
        `A dispute was opened (reason: ${String(dispute.reason ?? "unknown")}). PaymentIntent: ${piId ?? "unknown"}. ` +
        (payment ? `OS Payment: ${payment.id}.` : "No matching OS Payment row found.") +
        " Respond with evidence in the Stripe dashboard before the deadline.",
      type: "OTHER",
      dueAt: new Date(Date.now() + DAY_MS),
    }),
  );
}

/**
 * Closes the loop when the foreground charge ended UNKNOWN (timeout) or the
 * process died mid-finalize (PENDING). Rows already resolved are untouched.
 */
async function reconcileIntent(deps: StripeWebhookDeps, pi: Record<string, unknown>, outcome: "succeeded" | "failed") {
  const piId = idOf(pi.id);
  if (!piId) return;
  const payment = await deps.store.tx((tx) => tx.findPaymentByGatewayTxn("STRIPE", piId));
  if (!payment) return; // not OS-originated (or id never persisted)
  if (payment.chargeStatus !== "PENDING" && payment.chargeStatus !== "UNKNOWN") return;

  if (outcome === "succeeded") {
    await finalizeSucceeded(deps, payment.id, piId);
  } else {
    const err = (pi.last_payment_error ?? {}) as Record<string, unknown>;
    await finalizeFailed(
      deps,
      payment.id,
      String(err.decline_code ?? err.code ?? "payment_failed"),
      String(err.message ?? "payment_intent.payment_failed via webhook"),
    );
  }
  await deps.store.tx((tx) =>
    tx.audit({
      userId: null,
      action: outcome === "succeeded" ? "PAYMENT_RECONCILIATION_APPROVED" : "PAYMENT_RECONCILIATION_DECLINED",
      entityType: "Payment",
      entityId: payment.id,
      details: { via: "stripe-webhook", transactionId: piId },
    }),
  );
}

/**
 * OS-initiated refunds write their negative Payment row synchronously, so a
 * matching local row already exists when the webhook lands. If not, the
 * refund was issued in the Stripe dashboard: surface it instead of letting
 * the books silently diverge.
 */
async function detectExternalRefund(deps: StripeWebhookDeps, piId: string | null, refundedCents: number) {
  if (!piId) return;
  await deps.store.tx(async (tx) => {
    const original = await tx.findPaymentByGatewayTxn("STRIPE", piId);
    if (!original) return;
    const local = await tx.listPayments(
      (p) => p.parentPaymentId === original.id && p.type === "refund" && p.status === "completed",
    );
    const locallyRefunded = local.reduce((s, p) => s + Math.abs(p.amountCents), 0);
    if (locallyRefunded >= refundedCents) return; // books match

    await tx.audit({
      userId: null,
      action: "STRIPE_EXTERNAL_REFUND_DETECTED",
      entityType: "Payment",
      entityId: original.id,
      details: { paymentIntentId: piId, stripeRefundedCents: refundedCents, locallyRefundedCents: locallyRefunded },
    });
    await tx.createStaffTask({
      customerId: original.customerId,
      title: `Stripe dashboard refund needs booking (payment ${original.id})`,
      description:
        `Stripe reports ${(refundedCents / 100).toFixed(2)} refunded on ${piId}, but the OS has ` +
        `${(locallyRefunded / 100).toFixed(2)} in refund rows. Record it so the books match.`,
      type: "OTHER",
      dueAt: new Date(Date.now() + DAY_MS),
    });
  });
}
