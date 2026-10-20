/**
 * In-memory Store used by tests and `npm run demo`.
 *
 * Isolation model: one global async mutex serialises transactions (which is
 * strictly stronger than Postgres Serializable), and each transaction works
 * on a structured clone of the state that is swapped in only on success. So
 * a throw inside `tx()` rolls back every write, exactly like the production
 * `prisma.$transaction(..., { isolationLevel: "Serializable" })` calls.
 */

import { randomUUID } from "node:crypto";
import {
  UniqueViolationError,
  type AdvisoryLock,
  type AuditLogRow,
  type BillingEventRow,
  type CreditPackageRow,
  type FeeRow,
  type MembershipRow,
  type PaymentRow,
  type StaffTaskRow,
  type Store,
  type Tx,
} from "./types.ts";

export interface MemoryState {
  payments: Map<string, PaymentRow>;
  memberships: Map<string, MembershipRow>;
  billingEvents: Map<string, BillingEventRow>;
  creditPackages: Map<string, CreditPackageRow>;
  fees: Map<string, FeeRow>;
  auditLogs: AuditLogRow[];
  staffTasks: StaffTaskRow[];
}

function emptyState(): MemoryState {
  return {
    payments: new Map(),
    memberships: new Map(),
    billingEvents: new Map(),
    creditPackages: new Map(),
    fees: new Map(),
    auditLogs: [],
    staffTasks: [],
  };
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function must<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`${what} not found`);
  return row;
}

export class MemoryStore implements Store {
  state: MemoryState = emptyState();
  private readonly mutex = new Mutex();
  /** Optional clock so tests can control createdAt. */
  now: () => Date = () => new Date();

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(this.view(draft));
      this.state = draft;
      return result;
    });
  }

  /** Seed helpers (bypass the mutex; for test setup only). */
  seedMembership(m: MembershipRow): void {
    this.state.memberships.set(m.id, structuredClone(m));
  }
  seedFee(f: FeeRow): void {
    this.state.fees.set(f.id, structuredClone(f));
  }
  seedPayment(p: Partial<PaymentRow> & Pick<PaymentRow, "customerId" | "amountCents">): PaymentRow {
    const row = this.newPaymentRow({ type: "charge", status: "pending", gateway: "NMI", ...p });
    this.state.payments.set(row.id, row);
    return row;
  }

  private newPaymentRow(data: Partial<PaymentRow> & Pick<PaymentRow, "customerId" | "amountCents" | "type" | "status" | "gateway">): PaymentRow {
    return {
      id: data.id ?? randomUUID(),
      gatewayTransactionId: null,
      chargeStatus: null,
      fulfillmentStatus: null,
      paymentType: null,
      idempotencyKey: null,
      requestHash: null,
      contextJson: null,
      description: null,
      cardLastFour: null,
      createdByUserId: null,
      parentPaymentId: null,
      gatewayRequestedAt: null,
      gatewayRespondedAt: null,
      processedAt: null,
      fulfilledAt: null,
      failureReasonCode: null,
      failureReasonText: null,
      gatewayDeclineDetail: null,
      reconciliationAttempts: 0,
      createdAt: this.now(),
      ...data,
    };
  }

  private view(s: MemoryState): Tx {
    const clone = <T>(v: T): T => structuredClone(v);
    return {
      // The global mutex already holds every row; FOR UPDATE is implicit.
      lockPayment: async (id) => clone(s.payments.get(id) ?? null),
      getPayment: async (id) => clone(s.payments.get(id) ?? null),
      insertPayment: async (data) => {
        if (data.idempotencyKey) {
          for (const p of s.payments.values()) {
            if (p.idempotencyKey === data.idempotencyKey) {
              throw new UniqueViolationError("idempotencyKey");
            }
          }
        }
        const row = this.newPaymentRow(data);
        s.payments.set(row.id, row);
        return clone(row);
      },
      updatePayment: async (id, patch) => {
        const row = { ...must(s.payments.get(id), `Payment ${id}`), ...patch, id };
        s.payments.set(id, row);
        return clone(row);
      },
      findPaymentByIdempotencyKey: async (key) =>
        clone([...s.payments.values()].find((p) => p.idempotencyKey === key) ?? null),
      findPaymentByGatewayTxn: async (gateway, txnId) =>
        clone(
          [...s.payments.values()].find(
            (p) => p.gateway === gateway && p.gatewayTransactionId === txnId && p.type === "charge",
          ) ?? null,
        ),
      listPayments: async (filter, limit = Number.POSITIVE_INFINITY) =>
        clone(
          [...s.payments.values()]
            .filter(filter)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, limit),
        ),

      getMembership: async (id) => clone(s.memberships.get(id) ?? null),
      updateMembership: async (id, patch) => {
        const row = { ...must(s.memberships.get(id), `Membership ${id}`), ...patch, id };
        s.memberships.set(id, row);
        return clone(row);
      },
      insertBillingEvent: async (data) => {
        const row: BillingEventRow = { ...data, id: randomUUID(), createdAt: this.now() };
        s.billingEvents.set(row.id, row);
        return clone(row);
      },
      insertCreditPackage: async (data) => {
        const row: CreditPackageRow = { ...data, id: randomUUID() };
        s.creditPackages.set(row.id, row);
        return clone(row);
      },
      getFee: async (id) => clone(s.fees.get(id) ?? null),
      updateFee: async (id, patch) => {
        const row = { ...must(s.fees.get(id), `Fee ${id}`), ...patch, id };
        s.fees.set(id, row);
        return clone(row);
      },

      audit: async (entry) => {
        const row: AuditLogRow = {
          ipAddress: null,
          ...entry,
          id: randomUUID(),
          createdAt: this.now(),
        };
        s.auditLogs.push(row);
        return clone(row);
      },
      findAudit: async (action, entityId) =>
        clone(s.auditLogs.find((a) => a.action === action && a.entityId === entityId) ?? null),
      createStaffTask: async (task) => {
        const row: StaffTaskRow = {
          status: "pending",
          ...task,
          id: randomUUID(),
          createdAt: this.now(),
        };
        s.staffTasks.push(row);
        return clone(row);
      },
    };
  }
}

export class MemoryAdvisoryLock implements AdvisoryLock {
  private held = false;
  async tryAcquire(): Promise<boolean> {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  async release(): Promise<void> {
    this.held = false;
  }
}
