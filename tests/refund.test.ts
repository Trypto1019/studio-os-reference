import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeWithIntent } from "../lib/payments/payment-intent.ts";
import { refundPayment, PaymentRefundError, RefundGatewayError } from "../lib/payments/refund-payment.ts";
import { setup } from "./helpers/fixtures.ts";

async function paidCharge(opts: { stripe?: boolean } = {}) {
  const ctx = setup(opts);
  const r = await chargeWithIntent(ctx.deps, {
    customerId: "cus_r", amountCents: 10000, context: { kind: "MANUAL_CHARGE", reason: "retail" },
    paymentMethod: opts.stripe ? { kind: "stripe_customer", stripeCustomerId: "cus_stripe_r" } : { kind: "vault", vaultId: "v" },
  });
  assert.equal(r.kind, "succeeded");
  return { ...ctx, payment: (r as { payment: { id: string; gatewayTransactionId: string | null } }).payment };
}

const base = { reason: "charged in error", userId: "usr_staff" };

test("full refund of an unsettled NMI charge voids it and flips original to REFUNDED", async () => {
  const { store, nmi, payment } = await paidCharge();
  const r = await refundPayment({ store, nmi }, { ...base, paymentId: payment.id, amountCents: 10000, idempotencyKey: "rf1" });
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.action, "void");
    assert.equal(r.fullyRefunded, true);
  }
  assert.equal(store.state.payments.get(payment.id)!.chargeStatus, "REFUNDED");
  const audit = store.state.auditLogs.find((a) => a.action === "PAYMENT_REFUND")!;
  assert.equal(audit.details.moneyOnly, true);
});

test("partial NMI refund inside the 24h settlement window is rejected (422)", async () => {
  const { store, nmi, payment } = await paidCharge();
  await assert.rejects(
    refundPayment({ store, nmi }, { ...base, paymentId: payment.id, amountCents: 2500, idempotencyKey: "rf2" }),
    (e: unknown) => e instanceof PaymentRefundError && e.httpStatus === 422,
  );
});

test("partials after settlement track remaining balance; over-refund is 409", async () => {
  const { store, nmi, payment } = await paidCharge();
  nmi.settle(payment.gatewayTransactionId!);
  const later = () => new Date(Date.now() + 25 * 3600_000);
  const a = await refundPayment({ store, nmi, now: later }, { ...base, paymentId: payment.id, amountCents: 4000, idempotencyKey: "p1" });
  assert.equal(a.kind === "ok" && a.remainingRefundableCents, 6000);
  await assert.rejects(
    refundPayment({ store, nmi, now: later }, { ...base, paymentId: payment.id, amountCents: 7000, idempotencyKey: "p2" }),
    (e: unknown) => e instanceof PaymentRefundError && e.httpStatus === 409,
  );
  assert.notEqual(store.state.payments.get(payment.id)!.chargeStatus, "REFUNDED");
});

test("replay with the same key returns the prior refund without a second gateway call", async () => {
  const { store, nmi, payment } = await paidCharge();
  const input = { ...base, paymentId: payment.id, amountCents: 10000, idempotencyKey: "rf3" };
  await refundPayment({ store, nmi }, input);
  const again = await refundPayment({ store, nmi }, input);
  assert.equal(again.kind, "idempotent");
  assert.equal([...store.state.payments.values()].filter((p) => p.type === "refund").length, 1);
});

test("gateway failure rolls back and records a terminal failed refund for the key", async () => {
  const { store, nmi, payment } = await paidCharge();
  nmi.refundOrVoid = async () => ({ success: false, action: "refund", error: "processor unavailable" });
  const input = { ...base, paymentId: payment.id, amountCents: 10000, idempotencyKey: "rf4" };
  await assert.rejects(refundPayment({ store, nmi }, input), RefundGatewayError);
  assert.equal(store.state.payments.get(payment.id)!.chargeStatus, "SUCCEEDED");
  const replay = await refundPayment({ store, nmi }, input);
  assert.equal(replay.kind, "idempotent_failed");
});

test("refund follows the ORIGINAL rail (Stripe)", async () => {
  const { store, nmi, stripe, payment } = await paidCharge({ stripe: true });
  const r = await refundPayment({ store, nmi, stripe }, { ...base, paymentId: payment.id, amountCents: 2500, idempotencyKey: "rf5" });
  assert.equal(r.kind, "ok"); // Stripe partials need no settlement gate
});
