#!/usr/bin/env -S npx tsx
/**
 * Mirror-mode sync: skeleton of the parallel-run migration pattern.
 * See migration/mirror-mode.md for the full write-up.
 *
 * One-way: LegacyBookingVendor -> studio OS. Never writes back. Two feeds
 * land in STAGING tables first (never straight into app tables):
 *   1. Export files (canonical snapshot with the vendor's primary keys),
 *      loaded by one-shot importers each time the vendor produces an export.
 *   2. A delta feed (polling/scrape of recent changes) for the hourly run.
 * This runner reads staging and upserts into the app schema.
 *
 * Modes:  --mode=hourly  customer + membership deltas only
 *         --mode=daily   full pass (customers, memberships, visit history,
 *                        future bookings, payment history)
 *
 * Safety rails:
 *   - Session advisory lock: overlapping runs exit cleanly.
 *   - CHANGE_LIMIT writes per entity aborts the run (a bad export must not
 *     rewrite the customer table); --force bypasses for the bootstrap only.
 *   - --dry-run logs intended writes and executes none.
 *   - Cutover gate: rows whose billingOwner is already "studio_os" are
 *     owned by the new system and are NEVER overwritten by the mirror.
 *   - Anything the mapper cannot decide (unknown plan name, unique-key
 *     collision) becomes a MirrorConflict row for staff, keyed by
 *     (entityType, entityId, field) so reruns update rather than duplicate.
 *   - Placeholder/sentinel phone numbers are imported with a note flag
 *     instead of skipped, and never reused as a real phone.
 *   - MirrorSyncState records lastSyncedAt / syncCount / lastError per
 *     dataType, which drives the parallel-run dashboard.
 *
 * Usage: npx tsx scripts/mirror-sync.skeleton.ts --demo [--mode=daily] [--dry-run]
 */

import { pathToFileURL } from "node:url";

export const CHANGE_LIMIT = 1000;
export const SENTINEL_NOTE = "phone on file is a placeholder; verify before SMS";

export interface LegacyCustomer {
  legacyId: string;
  email: string | null;
  phone: string | null;
  firstName: string;
  lastName: string;
  planName: string | null;
}

export interface OsCustomer {
  id: string;
  legacyId: string | null;
  email: string | null;
  phone: string | null;
  firstName: string;
  lastName: string;
  billingOwner: "legacy_vendor" | "studio_os";
  productId: string | null;
  notes: string | null;
}

export interface MirrorConflict {
  entityType: string;
  entityId: string;
  field: string;
  legacySnapshot: unknown;
  currentSnapshot: unknown;
  status: "OPEN" | "RESOLVED" | "IGNORED";
}

export interface MirrorTarget {
  findByLegacyIdOrEmail(legacyId: string, email: string | null): Promise<OsCustomer | null>;
  create(c: Omit<OsCustomer, "id">): Promise<OsCustomer>;
  update(id: string, patch: Partial<OsCustomer>): Promise<void>;
  upsertConflict(c: MirrorConflict): Promise<void>;
  recordSync(dataType: string, count: number, error?: string): Promise<void>;
  tryLock(): Promise<boolean>;
  unlock(): Promise<void>;
}

export interface MirrorOptions {
  mode: "hourly" | "daily";
  dryRun: boolean;
  force: boolean;
  /** Maps a legacy plan name to a product id; null = unmapped. */
  resolvePlan: (planName: string) => string | null;
  log?: (...args: unknown[]) => void;
}

// Repeated-digit placeholders the legacy system used for "no phone on file".
const SENTINEL_DIGITS = new Set(["0", "1", "5", "9"].map((d) => d.repeat(10)));

export function normalizeLegacyPhone(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10 || SENTINEL_DIGITS.has(d)) return null;
  return `+1${d}`;
}

export class ChangeLimitExceeded extends Error {}

export async function syncCustomers(
  source: AsyncIterable<LegacyCustomer> | Iterable<LegacyCustomer>,
  target: MirrorTarget,
  opts: MirrorOptions,
): Promise<{ created: number; updated: number; unchanged: number; protected: number; conflicts: number }> {
  const log = opts.log ?? (() => undefined);
  const counters = { created: 0, updated: 0, unchanged: 0, protected: 0, conflicts: 0 };
  let changes = 0;
  const bump = () => {
    if (++changes > CHANGE_LIMIT && !opts.force) {
      throw new ChangeLimitExceeded(`more than ${CHANGE_LIMIT} customer writes in one run; aborting (use --force for bootstrap)`);
    }
  };

  for await (const row of source) {
    const phone = normalizeLegacyPhone(row.phone);
    const productId = row.planName ? opts.resolvePlan(row.planName) : null;
    const existing = await target.findByLegacyIdOrEmail(row.legacyId, row.email);

    if (row.planName && !productId) {
      counters.conflicts++;
      if (!opts.dryRun) {
        await target.upsertConflict({
          // Keyed by the legacy id so reruns update the same conflict row.
          entityType: "LegacyCustomer",
          entityId: row.legacyId,
          field: "unmapped_plan",
          legacySnapshot: { legacyId: row.legacyId, planName: row.planName },
          currentSnapshot: { productId: existing?.productId ?? null },
          status: "OPEN",
        });
      }
    }

    if (!existing) {
      bump();
      counters.created++;
      if (opts.dryRun) log("[dry-run create]", row.legacyId);
      else
        await target.create({
          legacyId: row.legacyId,
          email: row.email,
          phone,
          firstName: row.firstName,
          lastName: row.lastName,
          billingOwner: "legacy_vendor",
          productId,
          notes: row.phone && !phone ? SENTINEL_NOTE : null,
        });
      continue;
    }

    // Cutover gate: once the OS owns billing for this customer, the legacy
    // system is no longer the source of truth for it.
    if (existing.billingOwner === "studio_os") {
      counters.protected++;
      continue;
    }

    const delta: Partial<OsCustomer> = {};
    if (existing.legacyId !== row.legacyId) delta.legacyId = row.legacyId;
    if (phone && existing.phone !== phone) delta.phone = phone;
    if (row.email && existing.email !== row.email) delta.email = row.email;
    if (productId && existing.productId !== productId) delta.productId = productId;
    if (Object.keys(delta).length === 0) {
      counters.unchanged++; // no-op rows are skipped, not rewritten
      continue;
    }
    bump();
    counters.updated++;
    if (opts.dryRun) log("[dry-run update]", existing.id, Object.keys(delta).join(","));
    else await target.update(existing.id, delta);
  }
  return counters;
}

export async function runMirror(
  source: () => Iterable<LegacyCustomer> | AsyncIterable<LegacyCustomer>,
  target: MirrorTarget,
  opts: MirrorOptions,
): Promise<number> {
  const log = opts.log ?? console.log;
  if (!(await target.tryLock())) {
    log("advisory lock busy; another mirror sync is running. Exit clean.");
    return 0;
  }
  try {
    const result = await syncCustomers(source(), target, opts);
    if (!opts.dryRun) await target.recordSync("Customer", result.created + result.updated);
    log(`mirror sync (${opts.mode}${opts.dryRun ? ", dry-run" : ""}):`, JSON.stringify(result));
    // daily mode continues with memberships, visits, future bookings and
    // payment history using the same create / delta / conflict pattern.
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("mirror sync FAILED:", msg);
    if (!opts.dryRun) await target.recordSync(opts.mode, 0, msg);
    return 1;
  } finally {
    await target.unlock();
  }
}

/** In-memory target used by the demo and tests. */
export class MemoryMirrorTarget implements MirrorTarget {
  customers: OsCustomer[] = [];
  conflicts = new Map<string, MirrorConflict>();
  syncState = new Map<string, { syncCount: number; lastError: string | null }>();
  private locked = false;
  private seq = 0;
  async findByLegacyIdOrEmail(legacyId: string, email: string | null) {
    return this.customers.find((c) => c.legacyId === legacyId) ?? (email ? this.customers.find((c) => c.email === email) : undefined) ?? null;
  }
  async create(c: Omit<OsCustomer, "id">) {
    const row = { ...c, id: `cus_${++this.seq}` };
    this.customers.push(row);
    return row;
  }
  async update(id: string, patch: Partial<OsCustomer>) {
    Object.assign(this.customers.find((c) => c.id === id)!, patch);
  }
  async upsertConflict(c: MirrorConflict) {
    this.conflicts.set(`${c.entityType}|${c.entityId}|${c.field}`, c);
  }
  async recordSync(dataType: string, _count: number, error?: string) {
    const s = this.syncState.get(dataType) ?? { syncCount: 0, lastError: null };
    this.syncState.set(dataType, error ? { ...s, lastError: error } : { syncCount: s.syncCount + 1, lastError: null });
  }
  async tryLock() {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }
  async unlock() {
    this.locked = false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!args.includes("--demo")) {
    console.error("This skeleton runs offline with --demo. Production wiring supplies a staging-table source and a DB target.");
    process.exit(2);
  }
  const plans: Record<string, string> = { "Unlimited Monthly": "prod_unlimited", "8 Visits Monthly": "prod_8" };
  const target = new MemoryMirrorTarget();
  const legacy: LegacyCustomer[] = [
    { legacyId: "L-1001", email: "alex.placeholder@example.com", phone: "+1 555 010 0101", firstName: "Alex", lastName: "Placeholder", planName: "Unlimited Monthly" },
    { legacyId: "L-1002", email: "jordan.sample@example.com", phone: "0000000000", firstName: "Jordan", lastName: "Sample", planName: "Legacy Founders Plan" },
  ];
  const code = await runMirror(() => legacy, target, {
    mode: args.includes("--mode=daily") ? "daily" : "hourly",
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    resolvePlan: (name) => plans[name] ?? null,
  });
  console.log(`customers=${target.customers.length} conflicts=${target.conflicts.size}`);
  process.exit(code);
}
