#!/usr/bin/env -S npx tsx
/**
 * Offline walkthrough of the money paths. No keys, no network, no database.
 *   npm run demo
 */

import { MemoryAdvisoryLock, MemoryStore } from "../lib/db/memory-store.ts";
import { FakeGateway } from "../lib/payments/gateway.ts";
import { chargeWithIntent, type PaymentDeps } from "../lib/payments/payment-intent.ts";
import { refundPayment } from "../lib/payments/refund-payment.ts";
import { reconcilePayments } from "../lib/payments/reconcile.ts";
import { loadConfig } from "../lib/config.ts";

const cfg = loadConfig();
const store = new MemoryStore();
const nmi = new FakeGateway("NMI");
const deps: PaymentDeps = { store, gateways: { NMI: nmi }, brandName: cfg.brandName };
const step = (title: string, value: unknown) => console.log(`\n== ${title}\n${JSON.stringify(value, null, 2)}`);

store.seedMembership({
  id: "mem_demo", customerId: "cus_demo", status: "PAST_DUE", billingPriceCents: 18900,
  priceTiers: [{ uptoCycle: 6, priceCents: 18900 }, { uptoCycle: null, priceCents: 11900 }],
  priceLocked: false, cyclesBilled: 5, billingIntervalMonths: 1,
  currentPeriodStart: new Date("2026-01-31T00:00:00Z"), currentPeriodEnd: new Date("2026-02-28T00:00:00Z"),
  nextBillingDate: new Date("2026-02-28T00:00:00Z"), billingFailureCount: 1, lastBilledAt: null,
});

const renewal = {
  customerId: "cus_demo", amountCents: 18900,
  context: { kind: "MEMBERSHIP_RENEWAL" as const, membershipId: "mem_demo" },
  paymentMethod: { kind: "vault" as const, vaultId: "vault_demo" },
  idempotencyKey: "renewal:mem_demo:6",
};

const first = await chargeWithIntent(deps, renewal);
step("1. renewal charge", { kind: first.kind, entityIds: "entityIds" in first ? first.entityIds : null });

const retry = await chargeWithIntent(deps, renewal);
step("2. client retries with the same key (no second gateway call)", { kind: retry.kind, gatewayCalls: nmi.calls.length });

const misuse = await chargeWithIntent(deps, { ...renewal, amountCents: 1 });
step("3. same key, different payload", { kind: misuse.kind });

nmi.willRespond("crash_after_create");
const crashed = await chargeWithIntent(deps, {
  customerId: "cus_demo", amountCents: 2500,
  context: { kind: "MANUAL_CHARGE", reason: "retail" }, paymentMethod: { kind: "vault", vaultId: "vault_demo" },
}).catch((err: Error) => err.message);
const stuck = [...store.state.payments.values()].find((p) => p.amountCents === 2500)!;
stuck.createdAt = new Date(Date.now() - 10 * 60 * 1000); // pretend 10 minutes passed
step("4. process died after the gateway accepted the charge", { error: crashed, chargeStatus: stuck.chargeStatus, gatewayTransactionId: stuck.gatewayTransactionId });

const m = store.state.memberships.get("mem_demo")!;
step("5. membership after renewal (tier step-down applied for next cycle)", {
  status: m.status, cyclesBilled: m.cyclesBilled, nextBillingDate: m.nextBillingDate, nextPriceCents: m.billingPriceCents,
});

if (first.kind === "succeeded") {
  const refund = await refundPayment({ store, nmi }, {
    paymentId: first.payment.id, amountCents: 18900, reason: "charged in error", idempotencyKey: "refund:demo:1", userId: "usr_demo",
  });
  step("6. money-only refund (unsettled => void)", refund);
}

const stats = await reconcilePayments({ ...deps, lock: new MemoryAdvisoryLock() });
step("7. reconciliation run (queries the gateway by the persisted id, then fulfills)", stats);
console.log(`\n${cfg.brandName} demo complete. Audit rows: ${store.state.auditLogs.length}`);
