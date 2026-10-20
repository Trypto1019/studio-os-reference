import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chargeWithIntent } from "../lib/payments/payment-intent.ts";
import { reconcilePayments, ORPHAN_ESCALATE_AT, QUERY_ESCALATE_AT, FULFILL_ESCALATE_AT } from "../lib/payments/reconcile.ts";
import { membership, minutesAgo, renewalInput, setup } from "./helpers/fixtures.ts";

const manual = { kind: "MANUAL_CHARGE" as const, reason: "test" };

describe("reconciliation queue 1 (stuck PENDING)", () => {
  test("crash after the gateway accepted: recon queries by id and fulfills exactly once", async () => {
    const { store, deps, nmi, lock } = setup();
    store.seedMembership(membership());
    nmi.willRespond("crash_after_create");
    await assert.rejects(chargeWithIntent(deps, renewalInput()));
    const [stuck] = [...store.state.payments.values()];
    assert.equal(stuck!.chargeStatus, "PENDING");
    store.state.payments.get(stuck!.id)!.createdAt = minutesAgo(10);

    const stats = await reconcilePayments({ ...deps, lock });
    assert.equal(stats.approved, 1);
    const p = store.state.payments.get(stuck!.id)!;
    assert.equal(p.chargeStatus, "SUCCEEDED");
    assert.equal(p.fulfillmentStatus, "APPLIED");
    assert.equal(store.state.billingEvents.size, 1);

    // second run is a no-op
    const again = await reconcilePayments({ ...deps, lock });
    assert.equal(again.queue1 + again.queue2, 0);
    assert.equal(store.state.billingEvents.size, 1);
  });

  test("rows younger than 5 minutes are left to the foreground request", async () => {
    const { store, deps, lock } = setup();
    store.seedPayment({ customerId: "c", amountCents: 100, chargeStatus: "PENDING", paymentType: "MANUAL_CHARGE", contextJson: manual, createdAt: minutesAgo(1) });
    const stats = await reconcilePayments({ ...deps, lock });
    assert.equal(stats.queue1, 0);
  });

  test("gateway says declined -> FAILED", async () => {
    const { store, deps, nmi, lock } = setup();
    nmi.ledger.set("txn_declined", { amountCents: 100, status: "declined", settled: false, refundedCents: 0 });
    const p = store.seedPayment({ customerId: "c", amountCents: 100, chargeStatus: "PENDING", paymentType: "MANUAL_CHARGE", contextJson: manual, gatewayTransactionId: "txn_declined", createdAt: minutesAgo(10) });
    const stats = await reconcilePayments({ ...deps, lock });
    assert.equal(stats.declined, 1);
    assert.equal(store.state.payments.get(p.id)!.chargeStatus, "FAILED");
  });

  test(`orphan (no gateway id) escalates to UNKNOWN + StaffTask after ${ORPHAN_ESCALATE_AT} attempts`, async () => {
    const { store, deps, lock } = setup();
    const p = store.seedPayment({ customerId: "c", amountCents: 100, chargeStatus: "PENDING", paymentType: "MANUAL_CHARGE", contextJson: manual, createdAt: minutesAgo(10) });
    for (let i = 1; i < ORPHAN_ESCALATE_AT; i++) {
      await reconcilePayments({ ...deps, lock });
      assert.equal(store.state.payments.get(p.id)!.chargeStatus, "PENDING");
    }
    const stats = await reconcilePayments({ ...deps, lock });
    assert.equal(stats.markedUnknown, 1);
    assert.equal(store.state.payments.get(p.id)!.chargeStatus, "UNKNOWN");
    assert.equal(store.state.staffTasks.length, 1);
    assert.match(store.state.staffTasks[0]!.title, /orphan payment/);
  });

  test(`not_found escalates after ${QUERY_ESCALATE_AT} attempts and then stops being selected`, async () => {
    const { store, deps, lock } = setup();
    const p = store.seedPayment({ customerId: "c", amountCents: 100, chargeStatus: "PENDING", paymentType: "MANUAL_CHARGE", contextJson: manual, gatewayTransactionId: "txn_missing", createdAt: minutesAgo(10) });
    for (let i = 0; i < QUERY_ESCALATE_AT; i++) await reconcilePayments({ ...deps, lock });
    assert.equal(store.state.payments.get(p.id)!.chargeStatus, "UNKNOWN");
    assert.equal(store.state.staffTasks.length, 1);
    const after = await reconcilePayments({ ...deps, lock });
    assert.equal(after.queue1, 0);
  });

  test("one broken row never blocks the rest of the batch", async () => {
    const { store, deps, nmi, lock } = setup();
    nmi.ledger.set("txn_ok", { amountCents: 100, status: "approved", settled: false, refundedCents: 0 });
    const original = nmi.query.bind(nmi);
    nmi.query = async (id) => (id === "txn_boom" ? Promise.reject(new Error("gateway 500")) : original(id));
    store.seedPayment({ customerId: "c", amountCents: 100, chargeStatus: "PENDING", paymentType: "MANUAL_CHARGE", contextJson: manual, gatewayTransactionId: "txn_boom", createdAt: minutesAgo(20) });
    const good = store.seedPayment({ customerId: "c", amountCents: 100, chargeStatus: "PENDING", paymentType: "MANUAL_CHARGE", contextJson: manual, gatewayTransactionId: "txn_ok", createdAt: minutesAgo(10) });
    const stats = await reconcilePayments({ ...deps, lock });
    assert.equal(stats.errors, 1);
    assert.equal(stats.approved, 1);
    assert.equal(store.state.payments.get(good.id)!.chargeStatus, "SUCCEEDED");
  });
});

describe("reconciliation queue 2 (SUCCEEDED, unfulfilled)", () => {
  test("re-runs fulfillment idempotently", async () => {
    const { store, deps, lock } = setup();
    const p = store.seedPayment({
      customerId: "c", amountCents: 9900, status: "completed", chargeStatus: "SUCCEEDED", fulfillmentStatus: "NOT_STARTED",
      paymentType: "PACKAGE_PURCHASE", contextJson: { kind: "PACKAGE_PURCHASE", productId: "prod_pack", credits: 5, validDays: 90 },
      gatewayTransactionId: "txn_paid",
    });
    const stats = await reconcilePayments({ ...deps, lock });
    assert.equal(stats.fulfilled, 1);
    assert.equal(store.state.creditPackages.size, 1);
    assert.equal(store.state.payments.get(p.id)!.fulfillmentStatus, "APPLIED");
    await reconcilePayments({ ...deps, lock });
    assert.equal(store.state.creditPackages.size, 1);
  });

  test(`persistent handler failure escalates after ${FULFILL_ESCALATE_AT} attempts, charge is never marked failed`, async () => {
    const { store, deps, lock } = setup();
    const p = store.seedPayment({
      customerId: "c", amountCents: 18900, status: "completed", chargeStatus: "SUCCEEDED", fulfillmentStatus: "NOT_STARTED",
      paymentType: "MEMBERSHIP_RENEWAL", contextJson: { kind: "MEMBERSHIP_RENEWAL", membershipId: "missing" }, gatewayTransactionId: "txn_paid",
    });
    for (let i = 0; i < FULFILL_ESCALATE_AT; i++) await reconcilePayments({ ...deps, lock });
    const row = store.state.payments.get(p.id)!;
    assert.equal(row.chargeStatus, "SUCCEEDED");
    assert.equal(row.fulfillmentStatus, "FAILED");
    assert.equal(store.state.staffTasks.length, 1);
    assert.match(store.state.staffTasks[0]!.title, /fulfillment failed 5 times/);
  });
});

test("advisory lock: an overlapping run exits without touching rows", async () => {
  const { store, deps, lock } = setup();
  store.seedPayment({ customerId: "c", amountCents: 100, chargeStatus: "PENDING", paymentType: "MANUAL_CHARGE", contextJson: manual, createdAt: minutesAgo(10) });
  await lock.tryAcquire();
  const stats = await reconcilePayments({ ...deps, lock });
  assert.equal(stats.skippedLocked, true);
  assert.equal([...store.state.payments.values()][0]!.reconciliationAttempts, 0);
});
