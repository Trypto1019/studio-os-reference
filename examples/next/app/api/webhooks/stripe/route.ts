// Thin Next.js App Router adapter. Route handlers in this repo already take a
// Web `Request` and return a Web `Response`, so wiring is just dependency
// injection. `prismaStore` / `nmiGateway` / `stripeGateway` are the app's
// production adapters implementing lib/db/types.ts and lib/payments/gateway.ts.
import { createStripeWebhookHandler } from "../../../../../../app/api/webhooks/stripe/route";
import { loadConfig } from "../../../../../../lib/config";
import { prismaStore, nmiGateway, stripeGateway } from "@/lib/adapters";

export const runtime = "nodejs"; // raw body + node:crypto

export const POST = createStripeWebhookHandler({
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  store: prismaStore,
  gateways: { NMI: nmiGateway, STRIPE: stripeGateway },
  brandName: loadConfig().brandName,
});
