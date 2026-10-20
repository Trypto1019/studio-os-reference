import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryMirrorTarget, runMirror, syncCustomers, CHANGE_LIMIT, SENTINEL_NOTE, type LegacyCustomer } from "../scripts/mirror-sync.skeleton.ts";

const opts = { mode: "hourly" as const, dryRun: false, force: false, resolvePlan: (n: string) => (n === "Unlimited Monthly" ? "prod_unl" : null), log: () => undefined };
const row = (i: number, over: Partial<LegacyCustomer> = {}): LegacyCustomer => ({
  legacyId: `L-${i}`, email: `member${i}@example.com`, phone: `+1555010${String(i).padStart(4, "0")}`, firstName: "Alex", lastName: "Placeholder", planName: null, ...over,
});

test("creates, then no-ops unchanged rows; sentinel phones flagged, never stored", async () => {
  const t = new MemoryMirrorTarget();
  const r1 = await syncCustomers([row(1), row(2, { phone: "0000000000" })], t, opts);
  assert.equal(r1.created, 2);
  assert.equal(t.customers[1]!.phone, null);
  assert.equal(t.customers[1]!.notes, SENTINEL_NOTE);
  const r2 = await syncCustomers([row(1)], t, opts);
  assert.equal(r2.unchanged, 1);
});

test("cutover gate: OS-owned customers are never overwritten", async () => {
  const t = new MemoryMirrorTarget();
  await syncCustomers([row(1)], t, opts);
  t.customers[0]!.billingOwner = "studio_os";
  const r = await syncCustomers([row(1, { phone: "+15550109999" })], t, opts);
  assert.equal(r.protected, 1);
  assert.equal(t.customers[0]!.phone, "+15550100001");
});

test("unmapped plan becomes one keyed MirrorConflict (reruns update, not duplicate)", async () => {
  const t = new MemoryMirrorTarget();
  await syncCustomers([row(1, { planName: "Founders Plan" })], t, opts);
  await syncCustomers([row(1, { planName: "Founders Plan" })], t, opts);
  assert.equal(t.conflicts.size, 1);
});

test("change limit aborts the run and records the error; dry-run writes nothing", async () => {
  const t = new MemoryMirrorTarget();
  const many = Array.from({ length: CHANGE_LIMIT + 1 }, (_, i) => row(i));
  assert.equal(await runMirror(() => many, t, opts), 1);
  assert.match(t.syncState.get("hourly")!.lastError!, /aborting/);

  const dry = new MemoryMirrorTarget();
  assert.equal(await runMirror(() => [row(1)], dry, { ...opts, dryRun: true }), 0);
  assert.equal(dry.customers.length, 0);
});
