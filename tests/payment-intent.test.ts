import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chargeWithIntent, computeRequestHash, httpStatusFor } from "../lib/payments/payment-intent.ts";
import { computeNextBillingPrice, addMonthsClamped } from "../lib/payments/payment-fulfillment.ts";
import { membership, renewalInput, setup } from "./helpers/fixtures.ts";

describe("chargeWithIntent: durability", () => {
  test("approved charge -> SUCCEEDED + APPLIED, fulfillment and audit in one tx", async () => {
    const { store, deps, nmi } = setup();
    store.seedMembership(membership());
    const r = await chargeWithIntent(deps, renewalInput());
    assert.equal(r.kind, "succeeded");
    if (r.kind !== "succeeded") return;
    assert.equal(r.payment.chargeStatus, "SUCCEEDED");
    assert.equal(r.payment.fulfillmentStatus, "APPLIED");
    assert.equal(r.payment.status, "completed");
    assert.ok(r.payment.gatewayTransactionId?.startsWith("txn_fake_"));
    assert.ok(r.entityIds.billingEventId);
    assert.equal(nmi.calls.length, 1);
    const m = store.state.memberships.get("mem_test_1")!;
    assert.equal(m.status, "ACTIVE");
    assert.equal(m.cyclesBilled, 3);
    assert.equal(m.billingFailureCount, 0);
    // Feb 28 + 1 month, clamped correctly
    assert.equal(m.nextBillingDate?.toISOString(), "2026-03-28T00:00:00.000Z");
    assert.equal(store.state.auditLogs.filter((a) => a.action === "PAYMENT_FULFILLED_MEMBERSHIP_RENEWAL").length, 1);
  });

  test("PENDING row is committed BEFORE the gateway is called", async () => {
    const { store, deps, nmi } = setup();
    store.seedMembership(membership());
    let seenDuringCall: string | null | undefined;
    const original = nmi.charge.bind(nmi);
    nmi.charge = async (req) => {
      seenDuringCall = store.state.payments.get(req.paymentId)?.chargeStatus;
      return original(req);
    };
    await chargeWithIntent(deps, renewalInput());
    assert.equal(seenDuringCall, "PENDING");
  });

  test("decline -> FAILED with reason + decline detail, no fulfillment", async () => {
    const { store, deps, nmi } = setup();
    store.seedMembership(membership());
    nmi.willRespond("declined");
    const r = await chargeWithIntent(deps, renewalInput());
    assert.equal(r.kind, "failed");
    if (r.kind !== "failed") return;
    assert.equal(r.payment.chargeStatus, "FAILED");
    assert.equal(r.payment.failureReasonCode, "2");
    assert.equal(r.payment.gatewayDeclineDetail?.avsresponse, "N");
    assert.equal(store.state.billingEvents.size, 0);
    assert.equal(httpStatusFor(r), 402);
  });

  test("timeout -> UNKNOWN (left for reconciliation), never FAILED", async () => {
    const { deps, nmi } = setup();
    nmi.willRespond("unknown");
    const r = await chargeWithIntent(deps, renewalInput({ context: { kind: "MANUAL_CHARGE", reason: "retail" } }));
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.payment.chargeStatus, "UNKNOWN");
  });

  test("fulfillment throw rolls back Tx B: row stays PENDING with its gateway id, nothing half-applied", async () => {
    const { store, deps } = setup();
    // membership missing => handler throws inside the finalize tx
    await assert.rejects(chargeWithIntent(deps, renewalInput()), /Membership mem_test_1 not found/);
    const [p] = [...store.state.payments.values()];
    assert.equal(p!.chargeStatus, "PENDING"); // Tx B rolled back entirely
    assert.ok(p!.gatewayTransactionId, "gateway id persisted pre-confirmation");
    assert.equal(store.state.auditLogs.length, 0);
  });

  test("post-commit hook failure never affects the committed payment", async () => {
    const { store, deps } = setup();
    store.seedMembership(membership());
    const r = await chargeWithIntent({ ...deps, afterFulfilled: async () => { throw new Error("referral service down"); } }, renewalInput());
    assert.equal(r.kind, "succeeded");
  });
});

describe("chargeWithIntent: idempotency", () => {
  test("identical retry -> duplicate_succeeded, gateway called once", async () => {
    const { store, deps, nmi } = setup();
    store.seedMembership(membership());
    const a = await chargeWithIntent(deps, renewalInput());
    const b = await chargeWithIntent(deps, renewalInput());
    assert.equal(a.kind, "succeeded");
    assert.equal(b.kind, "duplicate_succeeded");
    assert.equal(nmi.calls.length, 1);
    assert.equal(store.state.payments.size, 1);
    assert.equal(store.state.billingEvents.size, 1);
    if (a.kind === "succeeded" && b.kind === "duplicate_succeeded") assert.deepEqual(b.entityIds, a.entityIds);
    assert.equal(httpStatusFor(b), 200);
  });

  test("same key, different payload -> idempotency_misuse (409)", async () => {
    const { store, deps } = setup();
    store.seedMembership(membership());
    await chargeWithIntent(deps, renewalInput());
    const r = await chargeWithIntent(deps, renewalInput({ amountCents: 100 }));
    assert.equal(r.kind, "idempotency_misuse");
    assert.equal(httpStatusFor(r), 409);
  });

  test("concurrent requests with one key -> exactly one gateway call", async () => {
    const { store, deps, nmi } = setup();
    store.seedMembership(membership());
    nmi.latencyMs = 20;
    const results = await Promise.all([chargeWithIntent(deps, renewalInput()), chargeWithIntent(deps, renewalInput())]);
    const kinds = results.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ["duplicate_pending", "succeeded"]);
    assert.equal(nmi.calls.length, 1);
  });

  test("key reused after a FAILED charge -> misuse (caller must mint a new key)", async () => {
    const { deps, nmi } = setup();
    nmi.willRespond("declined");
    const input = renewalInput({ context: { kind: "MANUAL_CHARGE", reason: "x" } });
    await chargeWithIntent(deps, input);
    const r = await chargeWithIntent(deps, input);
    assert.equal(r.kind, "idempotency_misuse");
    assert.equal(nmi.calls.length, 1);
  });

  test("no key -> every call is a fresh charge", async () => {
    const { deps, nmi } = setup();
    const input = renewalInput({ idempotencyKey: undefined, context: { kind: "MANUAL_CHARGE", reason: "x" } });
    await chargeWithIntent(deps, input);
    await chargeWithIntent(deps, input);
    assert.equal(nmi.calls.length, 2);
  });

  test("requestHash ignores handler-written output ids", () => {
    const a = computeRequestHash(renewalInput());
    const b = computeRequestHash(renewalInput({ context: { kind: "MEMBERSHIP_RENEWAL", membershipId: "mem_test_1", billingEventId: "be_1" } }));
    const c = computeRequestHash(renewalInput({ paymentMethod: { kind: "vault", vaultId: "other" } }));
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("dual rail", () => {
  test("Stripe charge persists the PaymentIntent id and routes to the Stripe adapter", async () => {
    const { store, deps, nmi, stripe } = setup({ stripe: true });
    store.seedMembership(membership());
    const r = await chargeWithIntent(deps, renewalInput({ paymentMethod: { kind: "stripe_customer", stripeCustomerId: "cus_stripe_test" } }));
    assert.equal(r.kind, "succeeded");
    assert.equal(nmi.calls.length, 0);
    assert.equal(stripe!.calls.length, 1);
    if (r.kind === "succeeded") {
      assert.equal(r.payment.gateway, "STRIPE");
      assert.ok(r.payment.gatewayTransactionId?.startsWith("pi_fake_"));
    }
  });

  test("Stripe allowlist: non-allowlisted context is refused without a gateway call", async () => {
    const { deps, stripe } = setup({ stripe: true });
    const r = await chargeWithIntent(deps, {
      customerId: "cus_test_1",
      amountCents: 5000,
      context: { kind: "PACKAGE_PURCHASE", productId: "prod_pack", credits: 5, validDays: 90 },
      paymentMethod: { kind: "stripe_customer", stripeCustomerId: "cus_stripe_test" },
    });
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.equal(r.payment.failureReasonCode, "STRIPE_CONTEXT_NOT_ALLOWED");
    assert.equal(stripe!.calls.length, 0);
  });

  test("3DS challenge -> requires_action, terminal FAILED row", async () => {
    const { deps, stripe } = setup({ stripe: true });
    stripe!.willRespond("requires_action");
    const r = await chargeWithIntent(deps, renewalInput({
      context: { kind: "MANUAL_CHARGE", reason: "x" },
      paymentMethod: { kind: "stripe_customer", stripeCustomerId: "cus_stripe_test" },
    }));
    assert.equal(r.kind, "requires_action");
    if (r.kind === "requires_action") assert.equal(r.payment.failureReasonCode, "requires_action");
  });
});

describe("fulfillment helpers", () => {
  test("price tier step-down applies from the cycle after the tier boundary", () => {
    const tiers = [{ uptoCycle: 6, priceCents: 18900 }, { uptoCycle: null, priceCents: 11900 }];
    assert.equal(computeNextBillingPrice({ priceTiers: tiers, newCyclesBilled: 5, currentPriceCents: 18900 }), null);
    assert.equal(computeNextBillingPrice({ priceTiers: tiers, newCyclesBilled: 6, currentPriceCents: 18900 }), 11900);
    assert.equal(computeNextBillingPrice({ priceTiers: null, newCyclesBilled: 6, currentPriceCents: 18900 }), null);
  });

  test("price-locked memberships never step down", async () => {
    const { store, deps } = setup();
    const tiers = [{ uptoCycle: 3, priceCents: 18900 }, { uptoCycle: null, priceCents: 11900 }];
    store.seedMembership(membership({ priceTiers: tiers, priceLocked: true }));
    await chargeWithIntent(deps, renewalInput());
    assert.equal(store.state.memberships.get("mem_test_1")!.billingPriceCents, 18900);
    store.seedMembership(membership({ id: "mem_test_2", priceTiers: tiers }));
    await chargeWithIntent(deps, renewalInput({ idempotencyKey: "k2", context: { kind: "MEMBERSHIP_RENEWAL", membershipId: "mem_test_2" } }));
    assert.equal(store.state.memberships.get("mem_test_2")!.billingPriceCents, 11900);
  });

  test("addMonthsClamped clamps to month end", () => {
    assert.equal(addMonthsClamped(new Date("2026-01-31T00:00:00Z"), 1).toISOString(), "2026-02-28T00:00:00.000Z");
    assert.equal(addMonthsClamped(new Date("2028-01-31T00:00:00Z"), 1).toISOString(), "2028-02-29T00:00:00.000Z");
  });
});
