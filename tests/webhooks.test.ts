import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  constantTimeEqual,
  verifySignalWireSignature,
  verifyStripeSignature,
  verifySvixSignature,
} from "../lib/webhooks/signatures.ts";
import { withSignalWireSignature } from "../lib/webhooks/signalwire-guard.ts";
import { createStripeWebhookHandler } from "../app/api/webhooks/stripe/route.ts";
import { createResendWebhookHandler, type EmailEventSink } from "../app/api/webhooks/resend/route.ts";
import { chargeWithIntent } from "../lib/payments/payment-intent.ts";
import { setup, signalWireFormSignature, stripeSignatureHeader, svixHeaders, svixSecret } from "./helpers/fixtures.ts";

const STRIPE_SECRET = "stripe-test-secret-not-real";

describe("Stripe signature", () => {
  const body = JSON.stringify({ id: "evt_1" });
  test("valid signature passes", () => {
    assert.equal(verifyStripeSignature(body, stripeSignatureHeader(body, STRIPE_SECRET), STRIPE_SECRET).ok, true);
  });
  test("tampered body fails", () => {
    const h = stripeSignatureHeader(body, STRIPE_SECRET);
    assert.deepEqual(verifyStripeSignature(body + " ", h, STRIPE_SECRET), { ok: false, reason: "signature_mismatch" });
  });
  test("replayed old timestamp fails", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const r = verifyStripeSignature(body, stripeSignatureHeader(body, STRIPE_SECRET, old), STRIPE_SECRET);
    assert.deepEqual(r, { ok: false, reason: "timestamp_outside_tolerance" });
  });
  test("rotation: any v1 may match", () => {
    const good = stripeSignatureHeader(body, STRIPE_SECRET);
    const [t, v1] = good.split(",");
    assert.equal(verifyStripeSignature(body, `${t},v1=${"0".repeat(64)},${v1}`, STRIPE_SECRET).ok, true);
  });
  test("missing secret fails closed", () => {
    assert.equal(verifyStripeSignature(body, "t=1,v1=x", "").ok, false);
  });
});

describe("Svix signature", () => {
  const secret = svixSecret();
  const body = JSON.stringify({ type: "email.delivered" });
  const h = svixHeaders(secret, body);
  const hdr = { id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"] };
  test("valid", () => assert.deepEqual(verifySvixSignature(secret, hdr, body), { ok: true }));
  test("wrong body", () => assert.equal(verifySvixSignature(secret, hdr, "{}").ok, false));
  test("stale timestamp", () => assert.equal(verifySvixSignature(secret, hdr, body, Number(hdr.timestamp) + 600).ok, false));
  test("missing headers", () => assert.equal(verifySvixSignature(secret, { ...hdr, id: null }, body).ok, false));
});

describe("SignalWire signature", () => {
  const key = "signalwire-test-key-not-real";
  const url = "https://crm.example.com/api/webhooks/signalwire/sms-inbound";
  const params = { From: "+15550100101", To: "+15550100102", Body: "STOP" };
  test("form scheme", () => {
    const signature = signalWireFormSignature(url, params, key);
    assert.equal(verifySignalWireSignature({ url, params, signature, signingKey: key }), true);
  });
  test("provider signed the explicit :443 variant", () => {
    const signature = signalWireFormSignature("https://crm.example.com:443/api/webhooks/signalwire/sms-inbound", params, key);
    assert.equal(verifySignalWireSignature({ url, params, signature, signingKey: key }), true);
  });
  test("param tampering fails; no key fails closed", () => {
    const signature = signalWireFormSignature(url, params, key);
    assert.equal(verifySignalWireSignature({ url, params: { ...params, Body: "START" }, signature, signingKey: key }), false);
    assert.equal(verifySignalWireSignature({ url, params, signature, signingKey: undefined }), false);
  });
  test("guard rebuilds the URL from the trusted origin, not the Host header", async () => {
    const handler = withSignalWireSignature({ publicUrl: "https://crm.example.com", signingKey: key }, async (p) => new Response(p.Body));
    const body = new URLSearchParams(params).toString();
    const signature = signalWireFormSignature(url, params, key);
    const ok = await handler(new Request("http://127.0.0.1:3000/api/webhooks/signalwire/sms-inbound", { method: "POST", body, headers: { "x-signalwire-signature": signature, host: "evil.example.com" } }));
    assert.equal(ok.status, 200);
    const bad = await handler(new Request("http://127.0.0.1:3000/api/webhooks/signalwire/sms-inbound", { method: "POST", body, headers: { "x-signalwire-signature": "bogus" } }));
    assert.equal(bad.status, 403);
  });
  test("constantTimeEqual handles length mismatch without throwing", () => {
    assert.equal(constantTimeEqual("abc", "abcd"), false);
    assert.equal(constantTimeEqual("abc", "abc"), true);
  });
});

describe("Stripe webhook route", () => {
  const post = (body: string, sig?: string) =>
    new Request("https://crm.example.com/api/webhooks/stripe", { method: "POST", body, headers: sig ? { "stripe-signature": sig } : {} });

  test("503 when secret is not configured, 400 on bad signature", async () => {
    const { deps } = setup();
    assert.equal((await createStripeWebhookHandler({ ...deps, webhookSecret: undefined })(post("{}"))).status, 503);
    assert.equal((await createStripeWebhookHandler({ ...deps, webhookSecret: STRIPE_SECRET })(post("{}", "t=1,v1=00"))).status, 400);
  });

  test("payment_intent.succeeded finalizes a stuck PENDING Stripe row; redelivery is deduplicated", async () => {
    const { store, deps, stripe } = setup({ stripe: true });
    stripe!.willRespond("crash_after_create");
    await assert.rejects(chargeWithIntent(deps, {
      customerId: "cus_w", amountCents: 3000, context: { kind: "MANUAL_CHARGE", reason: "x" },
      paymentMethod: { kind: "stripe_customer", stripeCustomerId: "cus_stripe_w" },
    }));
    const [row] = [...store.state.payments.values()];
    const handler = createStripeWebhookHandler({ ...deps, webhookSecret: STRIPE_SECRET });
    const body = JSON.stringify({ id: "evt_ok_1", type: "payment_intent.succeeded", created: 1, livemode: false, data: { object: { id: row!.gatewayTransactionId } } });
    const res = await handler(post(body, stripeSignatureHeader(body, STRIPE_SECRET)));
    assert.equal(res.status, 200);
    assert.equal(store.state.payments.get(row!.id)!.chargeStatus, "SUCCEEDED");

    const dup = await handler(post(body, stripeSignatureHeader(body, STRIPE_SECRET)));
    assert.deepEqual(await dup.json(), { received: true, duplicate: true });
    assert.equal(store.state.auditLogs.filter((a) => a.action === "STRIPE_WEBHOOK_EVENT").length, 1);
  });

  test("dashboard-side refund with no local refund row opens a StaffTask", async () => {
    const { store, deps } = setup({ stripe: true });
    const r = await chargeWithIntent(deps, {
      customerId: "cus_w", amountCents: 3000, context: { kind: "MANUAL_CHARGE", reason: "x" },
      paymentMethod: { kind: "stripe_customer", stripeCustomerId: "cus_stripe_w" },
    });
    assert.equal(r.kind, "succeeded");
    const pi = r.kind === "succeeded" ? r.payment.gatewayTransactionId : "";
    const body = JSON.stringify({ id: "evt_rf_1", type: "charge.refunded", created: 1, livemode: false, data: { object: { payment_intent: pi, amount_refunded: 3000 } } });
    await createStripeWebhookHandler({ ...deps, webhookSecret: STRIPE_SECRET })(post(body, stripeSignatureHeader(body, STRIPE_SECRET)));
    assert.equal(store.state.staffTasks.length, 1);
    assert.ok(store.state.auditLogs.some((a) => a.action === "STRIPE_EXTERNAL_REFUND_DETECTED"));
  });
});

describe("Email delivery webhook route", () => {
  function sink() {
    const calls: string[] = [];
    const s: EmailEventSink = {
      findCustomerByMessageId: async (id) => (id === "known" ? "cus_e" : null),
      recordDelivery: async (_id, ev) => void calls.push(`record:${ev}`),
      setEmailOptOut: async (_c, reason) => void calls.push(`optout:${reason}`),
      opsAlert: async () => void calls.push("alert"),
    };
    return { s, calls };
  }
  const secret = svixSecret();
  const req = (body: string, headers: Record<string, string>) => new Request("https://crm.example.com/api/webhooks/resend", { method: "POST", body, headers });

  test("hard bounce opts out; soft bounce only records; complaint alerts ops", async () => {
    const { s, calls } = sink();
    const h = createResendWebhookHandler({ secret, sink: s });
    for (const [type, extra] of [["email.bounced", { bounce: { type: "Permanent" } }], ["email.bounced", { bounce: { type: "Transient" } }], ["email.complained", {}]] as const) {
      const body = JSON.stringify({ type, data: { email_id: "known", ...extra } });
      assert.equal((await h(req(body, svixHeaders(secret, body)))).status, 200);
    }
    assert.deepEqual(calls, ["record:email.bounced", "optout:hard_bounce", "record:email.bounced", "record:email.complained", "optout:complaint", "alert"]);
  });

  test("unsigned request is 401; unconfigured secret is 503 unless fail-open is chosen", async () => {
    const { s } = sink();
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "known" } });
    assert.equal((await createResendWebhookHandler({ secret, sink: s })(req(body, {}))).status, 401);
    assert.equal((await createResendWebhookHandler({ secret: undefined, sink: s })(req(body, {}))).status, 503);
  });
});
