/**
 * Storage-agnostic row types and the transactional store contract.
 *
 * Production ran these operations through Prisma against Postgres with
 * Serializable transactions and `SELECT ... FOR UPDATE`. This reference repo
 * keeps the exact same call shapes behind a small interface so the money
 * paths can be tested offline (see lib/db/memory-store.ts). A Postgres
 * implementation only has to honour three guarantees:
 *
 *   1. `insertPayment` raises UniqueViolationError when a non-null
 *      idempotencyKey already exists (partial unique index, see
 *      prisma/sql/0001_payment_idempotency.sql).
 *   2. `tx(fn)` is atomic and isolated (Serializable): if `fn` throws, none
 *      of its writes are visible.
 *   3. `lockPayment(id)` blocks concurrent writers on that row until the
 *      surrounding transaction ends (`SELECT ... FOR UPDATE`).
 */

export type ChargeStatus =
  | "PENDING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "REFUNDED"
  | "REVERSED";

export type FulfillmentStatus = "NOT_STARTED" | "APPLIED" | "FAILED";

export type PaymentGateway = "NMI" | "STRIPE" | "CASH" | "COMP";

export type PaymentFlow =
  | "MEMBERSHIP_RENEWAL"
  | "PACKAGE_PURCHASE"
  | "MANUAL_CHARGE"
  | "NO_SHOW_FEE";

export interface PaymentRow {
  id: string;
  customerId: string;
  /** Integer cents. Refund rows are negative. */
  amountCents: number;
  type: "charge" | "refund";
  status: "pending" | "completed" | "failed";
  gateway: PaymentGateway;
  gatewayTransactionId: string | null;
  chargeStatus: ChargeStatus | null;
  fulfillmentStatus: FulfillmentStatus | null;
  paymentType: PaymentFlow | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  contextJson: unknown;
  description: string | null;
  cardLastFour: string | null;
  createdByUserId: string | null;
  parentPaymentId: string | null;
  gatewayRequestedAt: Date | null;
  gatewayRespondedAt: Date | null;
  processedAt: Date | null;
  fulfilledAt: Date | null;
  failureReasonCode: string | null;
  failureReasonText: string | null;
  gatewayDeclineDetail: Record<string, string> | null;
  reconciliationAttempts: number;
  createdAt: Date;
}

export type NewPayment = Partial<Omit<PaymentRow, "id" | "createdAt">> &
  Pick<PaymentRow, "customerId" | "amountCents" | "type" | "status" | "gateway">;

export interface MembershipRow {
  id: string;
  customerId: string;
  status: "ACTIVE" | "PAST_DUE" | "PAUSED" | "CANCELLED";
  billingPriceCents: number;
  /** Optional price step-down schedule, ascending by uptoCycle. */
  priceTiers: Array<{ uptoCycle: number | null; priceCents: number }> | null;
  priceLocked: boolean;
  cyclesBilled: number;
  billingIntervalMonths: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  nextBillingDate: Date | null;
  billingFailureCount: number;
  lastBilledAt: Date | null;
}

export interface BillingEventRow {
  id: string;
  customerId: string;
  membershipId: string;
  type: "CHARGE_SUCCESS" | "CHARGE_FAILED" | "RETRY";
  amountCents: number;
  gateway: PaymentGateway;
  gatewayTransactionId: string | null;
  createdAt: Date;
}

export interface CreditPackageRow {
  id: string;
  customerId: string;
  productId: string;
  creditsTotal: number;
  creditsRemaining: number;
  paymentId: string;
  expiresAt: Date;
}

export interface FeeRow {
  id: string;
  customerId: string;
  sessionId: string;
  amountCents: number;
  status: "PENDING" | "PAID" | "WAIVED" | "FAILED";
  paymentId: string | null;
}

export interface AuditLogRow {
  id: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: Date;
}

export interface StaffTaskRow {
  id: string;
  customerId: string | null;
  title: string;
  description: string;
  type: "CALL" | "EMAIL" | "SMS" | "OTHER";
  status: "pending" | "completed" | "cancelled";
  dueAt: Date;
  createdAt: Date;
}

export class UniqueViolationError extends Error {
  constructor(public readonly field: string) {
    super(`Unique constraint violated on ${field}`);
    this.name = "UniqueViolationError";
  }
}

/** Everything a money path may do inside one transaction. */
export interface Tx {
  lockPayment(id: string): Promise<PaymentRow | null>;
  getPayment(id: string): Promise<PaymentRow | null>;
  insertPayment(data: NewPayment): Promise<PaymentRow>;
  updatePayment(id: string, patch: Partial<PaymentRow>): Promise<PaymentRow>;
  findPaymentByIdempotencyKey(key: string): Promise<PaymentRow | null>;
  findPaymentByGatewayTxn(gateway: PaymentGateway, txnId: string): Promise<PaymentRow | null>;
  listPayments(filter: (p: PaymentRow) => boolean, limit?: number): Promise<PaymentRow[]>;

  getMembership(id: string): Promise<MembershipRow | null>;
  updateMembership(id: string, patch: Partial<MembershipRow>): Promise<MembershipRow>;
  insertBillingEvent(data: Omit<BillingEventRow, "id" | "createdAt">): Promise<BillingEventRow>;
  insertCreditPackage(data: Omit<CreditPackageRow, "id">): Promise<CreditPackageRow>;
  getFee(id: string): Promise<FeeRow | null>;
  updateFee(id: string, patch: Partial<FeeRow>): Promise<FeeRow>;

  audit(entry: Omit<AuditLogRow, "id" | "createdAt" | "ipAddress"> & { ipAddress?: string | null }): Promise<AuditLogRow>;
  findAudit(action: string, entityId: string): Promise<AuditLogRow | null>;
  createStaffTask(task: Omit<StaffTaskRow, "id" | "createdAt" | "status"> & { status?: StaffTaskRow["status"] }): Promise<StaffTaskRow>;
}

export interface Store {
  /** Run `fn` atomically. Writes are discarded if it throws. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Session-scoped advisory lock (pg_try_advisory_lock / pg_advisory_unlock). */
export interface AdvisoryLock {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** Minimal SQL client shape (node-postgres compatible) for the pg adapters. */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export class PgAdvisoryLock implements AdvisoryLock {
  constructor(private readonly sql: SqlClient, private readonly key: bigint) {}
  async tryAcquire(): Promise<boolean> {
    const { rows } = await this.sql.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [this.key.toString()],
    );
    return rows[0]?.acquired === true;
  }
  async release(): Promise<void> {
    await this.sql.query("SELECT pg_advisory_unlock($1)", [this.key.toString()]);
  }
}
