import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDueCustomerWhere, isDueCustomer, resolveBillingPaymentMethod } from "../lib/billing/rail.ts";
import { planPeriodWindowForBillingDayChange } from "../lib/billing/period-window.ts";
import { plainDeclineReason, rawDeclineCode } from "../lib/billing/decline-reason.ts";

const cust = { chargeRail: "STRIPE" as const, nmiCustomerVaultId: "vault_1", stripeCustomerId: "cus_stripe_1" };

test("rail: flag off collapses to NMI even for STRIPE-rail customers", () => {
  assert.deepEqual(resolveBillingPaymentMethod(cust, false), { ok: true, rail: "NMI", method: { kind: "vault", vaultId: "vault_1" } });
  assert.deepEqual(resolveBillingPaymentMethod(cust, true), { ok: true, rail: "STRIPE", method: { kind: "stripe_customer", stripeCustomerId: "cus_stripe_1" } });
  assert.equal(resolveBillingPaymentMethod({ ...cust, stripeCustomerId: null }, true).ok, false);
  assert.equal(resolveBillingPaymentMethod({ ...cust, chargeRail: "NMI", nmiCustomerVaultId: null }, true).ok, false);
});

test("rail: due-customer filter keeps the legacy shape when dark", () => {
  assert.deepEqual(Object.keys(buildDueCustomerWhere(false)).sort(), ["AND", "billingOwner"]);
  assert.ok("OR" in buildDueCustomerWhere(true));
  assert.equal(isDueCustomer({ ...cust, billingOwner: "legacy_vendor" }, true), false);
  assert.equal(isDueCustomer({ ...cust, nmiCustomerVaultId: null, billingOwner: "studio_os" }, false), false);
  assert.equal(isDueCustomer({ ...cust, nmiCustomerVaultId: null, billingOwner: "studio_os" }, true), true);
});

test("period window: mirrors -> slide; stale -> decision required; align clamps month end", () => {
  const now = new Date("2026-07-20T00:00:00Z");
  const slide = planPeriodWindowForBillingDayChange({
    previousCurrentPeriodEnd: new Date("2026-08-01T00:00:00Z"), previousNextBillingDate: new Date("2026-08-01T00:00:00Z"),
    newNextBillingDate: new Date("2026-08-05T00:00:00Z"), billingIntervalMonths: 1, choice: null, now,
  });
  assert.deepEqual(slide, { kind: "proceed", staleWindow: false, periodData: { currentPeriodEnd: new Date("2026-08-05T00:00:00Z") } });

  const stale = { previousCurrentPeriodEnd: new Date("2026-04-15T00:00:00Z"), previousNextBillingDate: new Date("2026-08-01T00:00:00Z"), newNextBillingDate: new Date("2026-03-31T00:00:00Z"), billingIntervalMonths: 1, now };
  assert.deepEqual(planPeriodWindowForBillingDayChange({ ...stale, choice: null }), { kind: "decision_required", staleWindow: true });
  assert.deepEqual(planPeriodWindowForBillingDayChange({ ...stale, choice: "keep" }), { kind: "proceed", staleWindow: true, periodData: {} });
  const aligned = planPeriodWindowForBillingDayChange({ ...stale, choice: "align" });
  assert.equal(aligned.kind === "proceed" && "currentPeriodStart" in aligned.periodData && aligned.periodData.currentPeriodStart.toISOString(), "2026-02-28T00:00:00.000Z");
});

test("decline reasons: plain words for staff, raw code preserved", () => {
  assert.equal(rawDeclineCode("Manual retry: Do Not Honor"), "Do Not Honor");
  assert.equal(plainDeclineReason("Past due after 3 failed payment attempts. Last error: Insufficient funds"), "Not enough money available on the card");
  assert.equal(plainDeclineReason("Pick up card - SF"), "The bank has blocked this card (reported lost, stolen or restricted)");
  assert.equal(plainDeclineReason("weird new code"), "The card was declined");
});
