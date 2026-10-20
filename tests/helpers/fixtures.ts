import { createHmac } from "node:crypto";
import { MemoryAdvisoryLock, MemoryStore } from "../../lib/db/memory-store.ts";
import { FakeGateway } from "../../lib/payments/gateway.ts";
import type { PaymentDeps, PaymentIntentInput } from "../../lib/payments/payment-intent.ts";
import type { MembershipRow } from "../../lib/db/types.ts";

export const BRAND = "Acme Wellness Studio";

export function setup(opts: { stripe?: boolean } = {}) {
  const store = new MemoryStore();
  const nmi = new FakeGateway("NMI");
  const stripe = opts.stripe ? new FakeGateway("STRIPE") : undefined;
  const silent = { error: () => undefined, warn: () => undefined };
  const deps: PaymentDeps = { store, gateways: { NMI: nmi, ...(stripe ? { STRIPE: stripe } : {}) }, brandName: BRAND, log: silent };
  return { store, nmi, stripe, deps, lock: new MemoryAdvisoryLock() };
}

export function membership(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    id: "mem_test_1",
    customerId: "cus_test_1",
    status: "PAST_DUE",
    billingPriceCents: 18900,
    priceTiers: null,
    priceLocked: false,
    cyclesBilled: 2,
    billingIntervalMonths: 1,
    currentPeriodStart: new Date("2026-01-31T00:00:00Z"),
    currentPeriodEnd: new Date("2026-02-28T00:00:00Z"),
    nextBillingDate: new Date("2026-02-28T00:00:00Z"),
    billingFailureCount: 1,
    lastBilledAt: null,
    ...overrides,
  };
}

export function renewalInput(overrides: Partial<PaymentIntentInput> = {}): PaymentIntentInput {
  return {
    customerId: "cus_test_1",
    amountCents: 18900,
    context: { kind: "MEMBERSHIP_RENEWAL", membershipId: "mem_test_1" },
    paymentMethod: { kind: "vault", vaultId: "vault_test_1" },
    idempotencyKey: "renewal:mem_test_1:3",
    ...overrides,
  };
}

export const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

// --- provider-format signers (test side of the verification code) ---

export function stripeSignatureHeader(body: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

/** Svix secrets are "whsec" + "_" + base64(key); built at runtime in tests. */
export function svixSecret(key = "test-signing-key-not-real"): string {
  return ["whsec", Buffer.from(key).toString("base64")].join("_");
}

export function svixHeaders(secret: string, body: string, id = "msg_test_1", ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(secret.split("_")[1]!, "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` };
}

export function signalWireFormSignature(url: string, params: Record<string, string>, key: string): string {
  let canonical = url;
  for (const k of Object.keys(params).sort()) canonical += k + params[k];
  return createHmac("sha1", key).update(canonical).digest("base64");
}
