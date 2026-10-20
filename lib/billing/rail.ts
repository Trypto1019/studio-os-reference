/**
 * Dual-rail gateway routing: per-customer rail selection.
 *
 * `chargeRail` is the system-of-record rail for a customer's charges.
 * Routing is by this enum ONLY, never by the shape of a vault id (vault ids
 * on one gateway can legitimately look like customer ids on the other; a
 * prefix check would misroute them).
 *
 * STRIPE_GATEWAY_ENABLED is a default-OFF dark flag. With the flag off every
 * helper here collapses to the single-rail (NMI) behaviour byte for byte, so
 * the second rail could ship to production long before any customer used it.
 */

import { envFlagDefaultOff } from "../config.ts";
import type { PaymentMethod } from "../payments/gateway.ts";

export type ChargeRail = "NMI" | "STRIPE";
/** Which system drives renewals during a migration cutover. */
export type BillingOwner = "legacy_vendor" | "studio_os";

export function isStripeGatewayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return envFlagDefaultOff("STRIPE_GATEWAY_ENABLED", env);
}

export interface RailCustomerFields {
  chargeRail: ChargeRail;
  nmiCustomerVaultId: string | null;
  stripeCustomerId: string | null;
}

export type RailResolution =
  | { ok: true; rail: ChargeRail; method: PaymentMethod }
  | { ok: false; rail: ChargeRail; reason: string };

/** Resolve gateway + payment method. Pass the flag explicitly in tests. */
export function resolveBillingPaymentMethod(
  customer: RailCustomerFields,
  stripeEnabled: boolean = isStripeGatewayEnabled(),
): RailResolution {
  if (stripeEnabled && customer.chargeRail === "STRIPE") {
    if (!customer.stripeCustomerId) {
      return { ok: false, rail: "STRIPE", reason: "Customer is on the STRIPE rail but has no stripeCustomerId" };
    }
    return { ok: true, rail: "STRIPE", method: { kind: "stripe_customer", stripeCustomerId: customer.stripeCustomerId } };
  }
  // NMI rail, or Stripe dark => legacy behaviour.
  if (!customer.nmiCustomerVaultId) {
    return { ok: false, rail: "NMI", reason: "No payment method on file" };
  }
  return { ok: true, rail: "NMI", method: { kind: "vault", vaultId: customer.nmiCustomerVaultId } };
}

/**
 * Customer-scope filter for the daily due-membership selection, in Prisma
 * `where` shape. Flag off => EXACTLY the legacy shape (OS-owned billing +
 * NMI vault present). Flag on => each rail requires its own vault id.
 */
export function buildDueCustomerWhere(stripeEnabled: boolean = isStripeGatewayEnabled()): Record<string, unknown> {
  const nmiVaultPresent = [{ nmiCustomerVaultId: { not: null } }, { nmiCustomerVaultId: { not: "" } }];
  if (!stripeEnabled) {
    return { billingOwner: "studio_os", AND: nmiVaultPresent };
  }
  return {
    billingOwner: "studio_os",
    OR: [
      { chargeRail: "NMI", AND: nmiVaultPresent },
      { chargeRail: "STRIPE", stripeCustomerId: { not: null } },
    ],
  };
}

/** In-memory twin of buildDueCustomerWhere for tests and the demo. */
export function isDueCustomer(
  c: RailCustomerFields & { billingOwner: BillingOwner },
  stripeEnabled: boolean = isStripeGatewayEnabled(),
): boolean {
  if (c.billingOwner !== "studio_os") return false;
  const nmiOk = !!c.nmiCustomerVaultId;
  if (!stripeEnabled) return nmiOk;
  return c.chargeRail === "NMI" ? nmiOk : !!c.stripeCustomerId;
}
