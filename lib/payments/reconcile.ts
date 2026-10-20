/**
 * Payment reconciliation (runs every 5 minutes from cron).
 *
 * Walks two queues of rows stuck in non-terminal states:
 *
 *   QUEUE 1: chargeStatus=PENDING, older than 5 minutes.
 *     The foreground request crashed, timed out, or lost the reply.
 *     - No gatewayTransactionId ("orphan"): the charge probably never
 *       reached the gateway. After 3 attempts: UNKNOWN + StaffTask.
 *     - Has an id: query the gateway by id (Stripe: retrieve the stored
 *       PaymentIntent id; never search).
 *         approved      -> finalizeSucceeded (replay-safe)
 *         declined      -> finalizeFailed
 *         not_found /
 *         indeterminate -> stay PENDING; after 5 attempts UNKNOWN + StaffTask
 *
 *   QUEUE 2: chargeStatus=SUCCEEDED, fulfillmentStatus NOT_STARTED|FAILED.
 *     Money moved but the entitlement was never applied. Re-run
 *     finalizeSucceeded (row lock + idempotent handlers make this safe).
 *     After 5 failures: StaffTask; the row stays visible.
 *
 * Concurrency: a SESSION-scoped advisory lock keeps two runs from
 * interleaving. (A transaction-scoped lock would release after the first
 * row's finalize transaction and protect nothing else.)
 *
 * Isolation: each row is processed in its own try/catch; one bad row never
 * blocks the run, and its attempt counter still advances so it cannot loop.
 */

import type { AdvisoryLock, PaymentRow } from "../db/types.ts";
import { finalizeFailed, finalizeSucceeded, markUnknown, type PaymentDeps } from "./payment-intent.ts";

export const ORPHAN_ESCALATE_AT = 3;
export const QUERY_ESCALATE_AT = 5;
export const FULFILL_ESCALATE_AT = 5;
export const STUCK_PENDING_MIN_AGE_MS = 5 * 60 * 1000;
export const BATCH_LIMIT = 50;
/** Arbitrary but distinct per job (billing uses its own key). */
export const RECONCILE_LOCK_KEY = BigInt(0xbc0002);

export interface RunStats {
  skippedLocked: boolean;
  queue1: number;
  queue2: number;
  approved: number;
  declined: number;
  notFound: number;
  indeterminate: number;
  fulfilled: number;
  escalated: number;
  markedUnknown: number;
  errors: number;
}

const newStats = (): RunStats => ({
  skippedLocked: false,
  queue1: 0,
  queue2: 0,
  approved: 0,
  declined: 0,
  notFound: 0,
  indeterminate: 0,
  fulfilled: 0,
  escalated: 0,
  markedUnknown: 0,
  errors: 0,
});

export interface ReconcileDeps extends PaymentDeps {
  lock: AdvisoryLock;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function reconcilePayments(deps: ReconcileDeps): Promise<RunStats> {
  const stats = newStats();
  if (!(await deps.lock.tryAcquire())) {
    stats.skippedLocked = true;
    return stats;
  }
  try {
    await runQueue1(deps, stats);
    await runQueue2(deps, stats);
  } finally {
    await deps.lock.release();
  }
  return stats;
}

const now = (deps: PaymentDeps) => (deps.now ? deps.now() : new Date());
const log = (deps: PaymentDeps) => deps.log ?? console;

async function bumpAttempts(deps: PaymentDeps, id: string): Promise<number> {
  return deps.store.tx(async (tx) => {
    const p = await tx.getPayment(id);
    const updated = await tx.updatePayment(id, { reconciliationAttempts: (p?.reconciliationAttempts ?? 0) + 1 });
    return updated.reconciliationAttempts;
  });
}

async function audit(deps: PaymentDeps, action: string, p: PaymentRow, details: Record<string, unknown>) {
  await deps.store.tx((tx) =>
    tx.audit({
      userId: null,
      action,
      entityType: "Payment",
      entityId: p.id,
      details: { customerId: p.customerId, amountCents: p.amountCents, ...details },
    }),
  );
}

async function staffTask(deps: PaymentDeps, p: PaymentRow, title: string, description: string) {
  await deps.store.tx((tx) =>
    tx.createStaffTask({
      customerId: p.customerId,
      title,
      description,
      type: "OTHER",
      dueAt: new Date(now(deps).getTime() + DAY_MS),
    }),
  );
}

// ---------------------------------------------------------------------------
// Queue 1: stuck PENDING
// ---------------------------------------------------------------------------

async function runQueue1(deps: ReconcileDeps, stats: RunStats) {
  const cutoff = now(deps).getTime() - STUCK_PENDING_MIN_AGE_MS;
  const stuck = await deps.store.tx((tx) =>
    tx.listPayments(
      (p) =>
        p.chargeStatus === "PENDING" &&
        p.createdAt.getTime() < cutoff &&
        p.reconciliationAttempts < QUERY_ESCALATE_AT,
      BATCH_LIMIT,
    ),
  );
  stats.queue1 = stuck.length;

  for (const p of stuck) {
    try {
      if (!p.gatewayTransactionId) await processOrphan(deps, p, stats);
      else await processWithTxnId(deps, p, stats);
    } catch (err) {
      stats.errors++;
      log(deps).error(`[reconcile] queue1 row ${p.id} threw:`, err);
      await bumpAttempts(deps, p.id).catch(() => undefined);
    }
  }
}

async function processOrphan(deps: PaymentDeps, p: PaymentRow, stats: RunStats) {
  const attempts = await bumpAttempts(deps, p.id);
  const escalated = attempts >= ORPHAN_ESCALATE_AT;
  if (escalated) {
    await markUnknown(deps, p.id, "Reconciliation: payment created but never received a gateway transaction id");
    await staffTask(
      deps,
      p,
      `Investigate orphan payment ${p.id}`,
      `Payment created ${p.createdAt.toISOString()} for ${dollars(p.amountCents)} (${p.paymentType ?? "unknown"}) ` +
        `never received a gateway transaction id after ${attempts} reconciliation attempts. ` +
        `Verify in the ${p.gateway} dashboard whether a charge occurred.`,
    );
    stats.markedUnknown++;
    stats.escalated++;
  }
  await audit(deps, "PAYMENT_RECONCILIATION_ORPHAN", p, { attempts, escalated });
}

async function processWithTxnId(deps: PaymentDeps, p: PaymentRow, stats: RunStats) {
  const gateway = p.gateway === "STRIPE" ? deps.gateways.STRIPE : deps.gateways.NMI;
  if (!gateway) throw new Error(`No gateway configured for ${p.gateway}`);
  const txnId = p.gatewayTransactionId!;
  const result = await gateway.query(txnId);

  if (result.status === "approved") {
    try {
      await finalizeSucceeded(deps, p.id, txnId);
      stats.approved++;
      await audit(deps, "PAYMENT_RECONCILIATION_APPROVED", p, { transactionId: txnId });
    } catch (err) {
      // The gateway DID charge; our fulfillment failed. Never finalizeFailed
      // here; the row is retried and escalated like queue 2.
      stats.errors++;
      const attempts = await bumpAttempts(deps, p.id);
      await audit(deps, "PAYMENT_RECONCILIATION_FAILED", p, {
        transactionId: txnId,
        attempts,
        stage: "queue1_approved_handler_threw",
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempts >= FULFILL_ESCALATE_AT) {
        await escalateUnfulfilled(deps, p, attempts, err);
        stats.escalated++;
      }
    }
    return;
  }

  if (result.status === "declined") {
    await finalizeFailed(deps, p.id, "RECON_DECLINED", result.responseText ?? "Reconciliation found a declined transaction");
    stats.declined++;
    await audit(deps, "PAYMENT_RECONCILIATION_DECLINED", p, { transactionId: txnId });
    return;
  }

  // not_found | indeterminate
  if (result.status === "not_found") stats.notFound++;
  else stats.indeterminate++;
  const attempts = await bumpAttempts(deps, p.id);
  const escalated = attempts >= QUERY_ESCALATE_AT;
  if (escalated) {
    await markUnknown(deps, p.id, `Reconciliation: gateway query returned ${result.status} ${attempts} times`);
    await staffTask(
      deps,
      p,
      `Reconciliation escalation: payment ${p.id}`,
      `Payment ${p.id} (${dollars(p.amountCents)}, transaction ${txnId}) stayed PENDING for ${attempts} attempts; ` +
        `${p.gateway} query returned ${result.status}. Verify manually in the ${p.gateway} dashboard.`,
    );
    stats.markedUnknown++;
    stats.escalated++;
  }
  await audit(deps, "PAYMENT_RECONCILIATION_PENDING", p, { transactionId: txnId, status: result.status, attempts, escalated });
}

// ---------------------------------------------------------------------------
// Queue 2: SUCCEEDED but unfulfilled
// ---------------------------------------------------------------------------

async function runQueue2(deps: ReconcileDeps, stats: RunStats) {
  const stuck = await deps.store.tx((tx) =>
    tx.listPayments(
      (p) =>
        p.chargeStatus === "SUCCEEDED" &&
        (p.fulfillmentStatus === "NOT_STARTED" || p.fulfillmentStatus === "FAILED") &&
        p.reconciliationAttempts < FULFILL_ESCALATE_AT,
      BATCH_LIMIT,
    ),
  );
  stats.queue2 = stuck.length;

  for (const p of stuck) {
    if (!p.gatewayTransactionId) {
      // Data-integrity problem: SUCCEEDED always sets the id. Surface it.
      stats.errors++;
      log(deps).error(`[reconcile] queue2 ${p.id} is SUCCEEDED with no gatewayTransactionId; skipping`);
      await bumpAttempts(deps, p.id).catch(() => undefined);
      continue;
    }
    try {
      await finalizeSucceeded(deps, p.id, p.gatewayTransactionId);
      stats.fulfilled++;
      await audit(deps, "PAYMENT_RECONCILIATION_FULFILLED", p, { transactionId: p.gatewayTransactionId });
    } catch (err) {
      stats.errors++;
      const attempts = await bumpAttempts(deps, p.id);
      await deps.store.tx((tx) => tx.updatePayment(p.id, { fulfillmentStatus: "FAILED" }));
      await audit(deps, "PAYMENT_RECONCILIATION_FAILED", p, {
        transactionId: p.gatewayTransactionId,
        attempts,
        stage: "queue2_handler_threw",
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempts >= FULFILL_ESCALATE_AT) {
        await escalateUnfulfilled(deps, p, attempts, err);
        stats.escalated++;
      }
    }
  }
}

async function escalateUnfulfilled(deps: PaymentDeps, p: PaymentRow, attempts: number, err: unknown) {
  await staffTask(
    deps,
    p,
    `Payment fulfillment failed ${attempts} times: ${p.id}`,
    `Payment ${p.id} (${dollars(p.amountCents)}, ${p.paymentType ?? "unknown"}, transaction ` +
      `${p.gatewayTransactionId ?? "none"}) was charged but fulfillment failed ${attempts} times. ` +
      `Last error: ${err instanceof Error ? err.message : String(err)}. Manual intervention required.`,
  );
}
