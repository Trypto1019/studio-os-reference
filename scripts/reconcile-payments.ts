#!/usr/bin/env -S npx tsx
/**
 * Cron entry point for payment reconciliation (lib/payments/reconcile.ts).
 *
 * Production crontab line (runs from the immutable release, wrapped so a
 * non-zero exit pages someone):
 *   *\/5 * * * *  ops/cron-with-alert.sh reconcile-payments \
 *     "cd $RELEASES/current && npx tsx scripts/reconcile-payments.ts"
 *
 * Offline: `npx tsx scripts/reconcile-payments.ts --demo` seeds an in-memory
 * store with the three stuck-row shapes and reconciles them.
 */

import { pathToFileURL } from "node:url";
import { MemoryAdvisoryLock, MemoryStore } from "../lib/db/memory-store.ts";
import { FakeGateway } from "../lib/payments/gateway.ts";
import { reconcilePayments, type ReconcileDeps, type RunStats } from "../lib/payments/reconcile.ts";
import { loadConfig } from "../lib/config.ts";

export async function main(deps: ReconcileDeps): Promise<RunStats> {
  const started = Date.now();
  const stats = await reconcilePayments(deps);
  if (stats.skippedLocked) {
    console.log("[reconcile] lock not acquired; another run in progress, exiting");
    return stats;
  }
  const { skippedLocked: _, ...counts } = stats;
  console.log(`[reconcile] ${JSON.stringify(counts)} in ${((Date.now() - started) / 1000).toFixed(2)}s`);
  return stats;
}

export function seedDemo(store: MemoryStore, nmi: FakeGateway): void {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  // 1. Charged at the gateway, reply lost before we recorded success.
  const lostTxn = "txn_demo_lost_reply";
  nmi.ledger.set(lostTxn, { amountCents: 4500, status: "approved", settled: false, refundedCents: 0 });
  store.seedPayment({
    customerId: "cus_demo_1", amountCents: 4500, chargeStatus: "PENDING", fulfillmentStatus: "NOT_STARTED",
    paymentType: "MANUAL_CHARGE", contextJson: { kind: "MANUAL_CHARGE", reason: "demo" },
    gatewayTransactionId: lostTxn, createdAt: tenMinAgo,
  });
  // 2. Orphan: PENDING with no gateway id (crashed before the call).
  store.seedPayment({
    customerId: "cus_demo_2", amountCents: 2500, chargeStatus: "PENDING", fulfillmentStatus: "NOT_STARTED",
    paymentType: "MANUAL_CHARGE", contextJson: { kind: "MANUAL_CHARGE", reason: "demo" }, createdAt: tenMinAgo,
  });
  // 3. Charged and marked SUCCEEDED, but fulfillment never ran.
  store.seedPayment({
    customerId: "cus_demo_3", amountCents: 9900, status: "completed", chargeStatus: "SUCCEEDED",
    fulfillmentStatus: "NOT_STARTED", paymentType: "PACKAGE_PURCHASE",
    contextJson: { kind: "PACKAGE_PURCHASE", productId: "prod_5_pack", credits: 5, validDays: 90 },
    gatewayTransactionId: "txn_demo_unfulfilled", createdAt: tenMinAgo,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--demo")) {
    console.error("Wire a production Store (lib/db/types.ts) and gateways here, or run with --demo.");
    process.exit(2);
  }
  const store = new MemoryStore();
  const nmi = new FakeGateway("NMI");
  seedDemo(store, nmi);
  main({ store, gateways: { NMI: nmi }, brandName: loadConfig().brandName, lock: new MemoryAdvisoryLock() })
    .catch((err) => {
      console.error("[reconcile] fatal:", err);
      process.exitCode = 1;
    });
}
