/**
 * Gateway port. Production had two adapters (an NMI Direct Post client and
 * the Stripe SDK); both were wrapped so the payment core only ever sees these
 * four outcomes. `FakeGateway` is the offline adapter used by tests and the
 * demo: fully scriptable, and it keeps its own ledger so reconciliation can
 * "query the gateway" for a transaction the app never heard back about.
 */

import { randomUUID } from "node:crypto";

export type GatewayOutcome =
  | { outcome: "approved"; transactionId: string; authCode?: string; responseText: string }
  | {
      outcome: "declined";
      responseCode: string;
      responseText: string;
      declineDetail?: Record<string, string>;
    }
  /** Network error, timeout, unparseable reply. Money may or may not have moved. */
  | { outcome: "unknown"; responseText: string }
  /** Off-session card needs a 3DS/SCA challenge. No money moved. */
  | { outcome: "requires_action"; responseText: string };

export type PaymentMethod =
  | { kind: "vault"; vaultId: string }
  | { kind: "stripe_customer"; stripeCustomerId: string };

export interface ChargeRequest {
  paymentId: string;
  amountCents: number;
  method: PaymentMethod;
  description: string;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  /**
   * Called as soon as the gateway assigns an id, BEFORE the charge is
   * confirmed. The payment core persists it onto the PENDING row so a crash
   * between "money moved" and "we recorded it" is always resolvable by id.
   */
  onTransactionCreated?: (transactionId: string) => Promise<void>;
}

export type QueryStatus = "approved" | "declined" | "not_found" | "indeterminate";

export interface RefundResult {
  success: boolean;
  action: "refund" | "void";
  transactionId?: string;
  error?: string;
  raw?: Record<string, string>;
}

export interface ChargeGateway {
  readonly name: "NMI" | "STRIPE";
  charge(req: ChargeRequest): Promise<GatewayOutcome>;
  query(transactionId: string): Promise<{ status: QueryStatus; responseText?: string }>;
  /** Partial or full refund of a settled transaction. */
  refund(transactionId: string, amountCents: number, idempotencyKey?: string): Promise<RefundResult>;
  /** Full reversal: void if unsettled, refund if settled. */
  refundOrVoid(transactionId: string, amountCents: number, idempotencyKey?: string): Promise<RefundResult>;
}

export type Gateways = { NMI: ChargeGateway; STRIPE?: ChargeGateway };

type Scripted =
  | GatewayOutcome["outcome"]
  /** Assigns an id, "moves money", then the process dies before replying. */
  | "crash_after_create"
  /** Moves money, but the reply is lost (timeout); no id reaches the app. */
  | "timeout_after_capture";

interface LedgerEntry {
  amountCents: number;
  status: "approved" | "declined";
  settled: boolean;
  refundedCents: number;
}

export class FakeGateway implements ChargeGateway {
  readonly calls: ChargeRequest[] = [];
  readonly ledger = new Map<string, LedgerEntry>();
  private script: Scripted[] = [];
  /** Optional artificial latency so concurrency tests can interleave. */
  latencyMs = 0;

  constructor(readonly name: "NMI" | "STRIPE" = "NMI") {}

  /** Queue outcomes for the next charge() calls; default is "approved". */
  willRespond(...outcomes: Scripted[]): this {
    this.script.push(...outcomes);
    return this;
  }

  private newId(): string {
    return (this.name === "STRIPE" ? "pi_fake_" : "txn_fake_") + randomUUID().slice(0, 8);
  }

  async charge(req: ChargeRequest): Promise<GatewayOutcome> {
    this.calls.push(req);
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const next = this.script.shift() ?? "approved";
    const id = this.newId();

    switch (next) {
      case "approved":
        await req.onTransactionCreated?.(id);
        this.ledger.set(id, { amountCents: req.amountCents, status: "approved", settled: false, refundedCents: 0 });
        return { outcome: "approved", transactionId: id, authCode: "123456", responseText: "Approved" };
      case "declined":
        this.ledger.set(id, { amountCents: req.amountCents, status: "declined", settled: false, refundedCents: 0 });
        return {
          outcome: "declined",
          responseCode: "2",
          responseText: "DECLINE",
          declineDetail: { response: "2", response_code: "200", responsetext: "DECLINE", avsresponse: "N", cvvresponse: "M" },
        };
      case "requires_action":
        return { outcome: "requires_action", responseText: "Card requires authentication" };
      case "unknown":
        return { outcome: "unknown", responseText: "Gateway unreachable" };
      case "crash_after_create":
        await req.onTransactionCreated?.(id);
        this.ledger.set(id, { amountCents: req.amountCents, status: "approved", settled: false, refundedCents: 0 });
        throw new Error("process crashed after gateway accepted the charge");
      case "timeout_after_capture":
        this.ledger.set(id, { amountCents: req.amountCents, status: "approved", settled: false, refundedCents: 0 });
        return { outcome: "unknown", responseText: "Timeout after 5000ms" };
    }
  }

  async query(transactionId: string) {
    const entry = this.ledger.get(transactionId);
    if (!entry) return { status: "not_found" as const };
    return { status: entry.status, responseText: entry.status === "approved" ? "Approved" : "DECLINE" };
  }

  settle(transactionId: string): void {
    const e = this.ledger.get(transactionId);
    if (e) e.settled = true;
  }

  async refund(transactionId: string, amountCents: number): Promise<RefundResult> {
    const e = this.ledger.get(transactionId);
    if (!e || e.status !== "approved") return { success: false, action: "refund", error: "Transaction not found" };
    if (e.refundedCents + amountCents > e.amountCents) {
      return { success: false, action: "refund", error: "Refund amount exceeds transaction balance" };
    }
    e.refundedCents += amountCents;
    return { success: true, action: "refund", transactionId: this.newId() };
  }

  async refundOrVoid(transactionId: string, amountCents: number): Promise<RefundResult> {
    const e = this.ledger.get(transactionId);
    if (e && !e.settled && e.status === "approved") {
      e.refundedCents = e.amountCents;
      return { success: true, action: "void", transactionId };
    }
    return this.refund(transactionId, amountCents);
  }
}
