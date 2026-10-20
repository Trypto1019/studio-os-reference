/**
 * Transactional-email delivery webhook (Svix-signed; the provider in
 * production was Resend).
 *
 * Auth: svix-id / svix-timestamp (+/-5 min) / svix-signature, HMAC-SHA256
 * with the base64 key behind `whsec_`. Any one of several space-separated
 * `v1,` signatures may match (secret rotation).
 *
 * Secret unset: production deliberately failed OPEN (log a warning and
 * accept) so a misconfigured deploy could not drop every delivery event.
 * That trade-off is explicit here: `failOpenWhenUnconfigured` defaults to
 * false and must be opted into.
 *
 * Consequences of events (matched by provider message id):
 *   email.delivered                 -> recorded
 *   email.bounced (permanent)       -> customer.emailOptOut = true
 *   email.bounced (transient/soft)  -> recorded only; a full mailbox must
 *                                      not silently unsubscribe a member
 *   email.complained                -> emailOptOut + ops alert (a spam
 *                                      report degrades deliverability for
 *                                      every customer)
 */

import { verifySvixSignature } from "../../../../lib/webhooks/signatures.ts";

export interface EmailEventSink {
  /** Returns the customer id the provider message belongs to, if any. */
  findCustomerByMessageId(messageId: string): Promise<string | null>;
  recordDelivery(messageId: string, event: string, detail: Record<string, unknown>): Promise<void>;
  setEmailOptOut(customerId: string, reason: "hard_bounce" | "complaint"): Promise<void>;
  opsAlert(subject: string, body: string): Promise<void>;
}

export interface ResendWebhookDeps {
  secret: string | undefined;
  sink: EmailEventSink;
  failOpenWhenUnconfigured?: boolean;
  nowSec?: () => number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createResendWebhookHandler(deps: ResendWebhookDeps) {
  return async function POST(req: Request): Promise<Response> {
    const rawBody = await req.text();

    if (deps.secret) {
      const result = verifySvixSignature(
        deps.secret,
        {
          id: req.headers.get("svix-id"),
          timestamp: req.headers.get("svix-timestamp"),
          signature: req.headers.get("svix-signature"),
        },
        rawBody,
        deps.nowSec?.(),
      );
      if (!result.ok) return json({ error: "Invalid signature", reason: result.reason }, 401);
    } else if (!deps.failOpenWhenUnconfigured) {
      return json({ error: "Webhook secret not configured" }, 503);
    } else {
      console.warn("[email-webhook] signing secret not set; signature validation skipped (fail-open)");
    }

    let data: { type?: string; data?: Record<string, unknown> };
    try {
      data = JSON.parse(rawBody);
    } catch {
      return json({ error: "Invalid payload" }, 400);
    }
    const eventType = String(data.type ?? "");
    const email = data.data ?? {};
    const messageId = String(email.email_id ?? email.id ?? "");
    if (!messageId) return json({ received: true });

    const customerId = await deps.sink.findCustomerByMessageId(messageId);
    if (!customerId) return json({ received: true, matched: false });

    await deps.sink.recordDelivery(messageId, eventType, email);

    if (eventType === "email.bounced") {
      const bounce = (email.bounce ?? {}) as { type?: string };
      const permanent = (bounce.type ?? "").toLowerCase() !== "transient";
      if (permanent) await deps.sink.setEmailOptOut(customerId, "hard_bounce");
    } else if (eventType === "email.complained") {
      await deps.sink.setEmailOptOut(customerId, "complaint");
      await deps.sink.opsAlert(
        "Spam complaint on transactional email",
        `Provider message ${messageId} drew a spam complaint; the customer was opted out of email.`,
      );
    }
    return json({ received: true, matched: true, event: eventType });
  };
}
