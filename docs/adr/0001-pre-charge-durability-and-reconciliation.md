# ADR 0001: Pre-charge durability, idempotency keys and reconciliation

**Status:** accepted (in production since the first native charge)

## Context

The first version charged the gateway and then wrote the `Payment` row. If the process died, timed out or threw in between, money had moved and the system had no record of it. Retries from flaky mobile clients and from staff double-clicks could also charge a card twice.

## Decision

1. **Tx A** inserts `Payment(chargeStatus=PENDING, idempotencyKey, requestHash, contextJson)` and **commits before** the gateway is called.
2. The gateway call runs outside any transaction. When the gateway assigns an id before confirming (as Stripe does with PaymentIntents), the id is persisted onto the PENDING row first.
3. **Tx B** (Serializable) runs `SELECT ... FOR UPDATE`, sets SUCCEEDED, runs the typed fulfillment handler, sets APPLIED and writes the audit row. It is one atomic unit.
4. Outcomes are explicit: `FAILED` for a decline, `UNKNOWN` for a timeout or error, and `requires_action` for 3DS. Callers receive a discriminated union, never a boolean.
5. **Idempotency:** a partial unique index sits on `idempotencyKey WHERE NOT NULL`. On collision:
   - the original row is PENDING: `duplicate_pending`, with no second gateway call
   - the original SUCCEEDED and the hash matches: `duplicate_succeeded`, which replays the entity ids
   - the hash differs, or the original FAILED or is UNKNOWN: `idempotency_misuse`, returned as HTTP 409
6. **Fulfillment handlers are idempotent.** Each one writes its output ids back into `contextJson` inside Tx B.
7. **Reconciliation** runs every 5 minutes under a session-scoped advisory lock and works two queues:
   - PENDING rows older than 5 minutes. Orphans (no gateway id) escalate after 3 attempts. Rows with an id are queried at the gateway and finalized, or escalate after 5 attempts.
   - Rows that SUCCEEDED but were never fulfilled get Tx B re-run, and escalate after 5 failures.

   Escalation marks the row UNKNOWN and opens a StaffTask. Recon never marks a charge FAILED when the gateway says it was approved.
8. The Stripe webhook is a second, faster path to the same `finalizeSucceeded`/`finalizeFailed`.

## Consequences

- A crash at any point leaves a row that a machine or a person can resolve. That is tested in `tests/payment-intent.test.ts`, `tests/reconcile.test.ts` and `tests/webhooks.test.ts`.
- The schema needs raw SQL for the partial index (`prisma/sql/0001_payment_idempotency.sql`).
- Side effects that must never roll back a payment, such as referral credit and booking automations, run after commit as best-effort hooks.
- A session-scoped advisory lock is required. A transaction-scoped lock would release after the first row's Tx B.
