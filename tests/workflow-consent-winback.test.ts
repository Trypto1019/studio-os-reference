import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryWorkflowRepo,
  processDueWorkflows,
  renderTemplate,
  startWorkflow,
  nextBusinessTime,
  type WorkflowDeps,
} from "../lib/workflow-engine.ts";
import { isAuthorizedOptOutAcknowledgment, optOutAckText, sendNewOptOutAcknowledgment, type SendSmsOptions } from "../lib/consent/sms-optout-ack.ts";
import { applyStaffSmsOptOutChange, ensureSuppression, MemorySuppressionClient, normalizeSmsPhone, CARRIER_STOP_REASON } from "../lib/consent/suppression.ts";
import { voiceCallConsent, LEGACY_SMS_MECHANISM } from "../lib/consent/marketing-consent.ts";
import { RETENTION_TEMPLATES, winbackNoLongerEligibleReason, type RetentionSnapshot } from "../lib/winback/eligibility.ts";
import { assignCopyVersions, findActiveWinbackOffer, toWinbackOfferPayload } from "../lib/winback/offer-payload.ts";
import { BRAND } from "./helpers/fixtures.ts";

const TZ = "America/Los_Angeles";
const NOON_PT = new Date("2026-06-01T19:00:00Z");

function wf(now: Date, over: Partial<WorkflowDeps> = {}) {
  const repo = new MemoryWorkflowRepo();
  const sent: string[] = [];
  repo.customers.set("cus_1", { id: "cus_1", firstName: "", lastName: "Sample", email: "jordan@example.com", phone: "+15550100123", smsOptOut: false, emailOptOut: false, lastRespondedAt: null });
  repo.templates.set("t1", {
    id: "t1", name: "No Show - Rebook", isActive: true, solicitation: true,
    steps: [
      { id: "s1", stepOrder: 1, delayMinutes: 0, channel: "SMS", body: "Hey {{first_name}}, {{brand}} misses you" },
      { id: "s2", stepOrder: 2, delayMinutes: 60 * 24, channel: "EMAIL", subject: "{{brand}}", body: "Come back {{first_name}}" },
    ],
  });
  const deps: WorkflowDeps = {
    repo, timezone: TZ, brandName: BRAND, dispatchEnabled: true, now: () => now,
    sender: {
      sendSms: async (_to, body) => (sent.push(`sms:${body}`), { id: "m1" }),
      sendEmail: async (_to, subject) => (sent.push(`email:${subject}`), { id: "e1" }),
      createCallTask: async () => ({ id: "t" }),
    },
    ...over,
  };
  return { repo, deps, sent };
}

describe("workflow engine", () => {
  test("renders with a safe first-name fallback and sends inside business hours", async () => {
    const { deps, sent } = wf(NOON_PT);
    await startWorkflow(deps, "cus_1", "No Show - Rebook");
    const counts = await processDueWorkflows(deps);
    assert.equal(counts.sent, 1);
    assert.deepEqual(sent, [`sms:Hey there, ${BRAND} misses you`]);
    assert.equal(renderTemplate("{{unknown}} {{first_name}}", { first_name: "Alex", last_name: "", brand: BRAND }), "{{unknown}} Alex");
  });

  test("solicitation SMS outside 09-19 local is rescheduled, not sent", async () => {
    const tenPm = new Date("2026-06-02T05:00:00Z"); // 22:00 PT
    const { deps, repo, sent } = wf(tenPm);
    await startWorkflow(deps, "cus_1", "No Show - Rebook");
    assert.equal((await processDueWorkflows(deps)).rescheduled, 1);
    assert.equal(sent.length, 0);
    const exec = [...repo.executions.values()].find((e) => e.channel === "SMS")!;
    assert.equal(exec.scheduledAt.toISOString(), "2026-06-02T16:00:00.000Z"); // 09:00 PT
    assert.equal(nextBusinessTime("SMS", tenPm, TZ, "TRANSACTIONAL").toISOString(), "2026-06-02T14:00:00.000Z"); // 07:00 PT
  });

  test("48h staleness floor skips instead of dumping an outage backlog", async () => {
    const { deps, repo } = wf(NOON_PT);
    await startWorkflow({ ...deps, now: () => new Date(NOON_PT.getTime() - 4 * 86_400_000) }, "cus_1", "No Show - Rebook");
    const counts = await processDueWorkflows(deps);
    assert.equal(counts.stale, 2);
    assert.ok([...repo.executions.values()].every((e) => e.note?.startsWith("[STALE]")));
  });

  test("touch limit: 3 SMS / 5 days across workflows, reset by a reply", async () => {
    const { deps, repo } = wf(NOON_PT);
    for (let i = 0; i < 3; i++) {
      repo.executions.set(`old_${i}`, { id: `old_${i}`, instanceId: "wfi_old", stepId: "s1", channel: "SMS", scheduledAt: NOON_PT, executedAt: new Date(NOON_PT.getTime() - 86_400_000), status: "sent", message: "x", note: null });
    }
    repo.instances.set("wfi_old", { id: "wfi_old", templateId: "t1", customerId: "cus_1", status: "completed" });
    await startWorkflow(deps, "cus_1", "No Show - Rebook");
    assert.equal((await processDueWorkflows(deps)).touch_limit, 1);

    const { deps: d2, repo: r2 } = wf(NOON_PT);
    for (const [k, v] of repo.executions) if (k.startsWith("old_")) r2.executions.set(k, v);
    r2.instances.set("wfi_old", repo.instances.get("wfi_old")!);
    r2.customers.get("cus_1")!.lastRespondedAt = new Date(NOON_PT.getTime() - 3600_000);
    await startWorkflow(d2, "cus_1", "No Show - Rebook");
    assert.equal((await processDueWorkflows(d2)).sent, 1);
  });

  test("kill switch records instead of sending; suppression and eligibility skip", async () => {
    const off = wf(NOON_PT, { dispatchEnabled: false });
    await startWorkflow(off.deps, "cus_1", "No Show - Rebook");
    assert.equal((await processDueWorkflows(off.deps)).dispatch_disabled, 1);
    assert.equal(off.sent.length, 0);

    const sup = wf(NOON_PT, { isSuppressed: async () => true });
    await startWorkflow(sup.deps, "cus_1", "No Show - Rebook");
    assert.equal((await processDueWorkflows(sup.deps)).opted_out, 1);

    const inel = wf(NOON_PT, { eligibility: async () => "customer rebooked" });
    const id = await startWorkflow(inel.deps, "cus_1", "No Show - Rebook");
    assert.equal((await processDueWorkflows(inel.deps)).ineligible, 1);
    assert.equal(inel.repo.instances.get(id!)!.status, "cancelled");
  });
});

describe("consent", () => {
  test("STOP ack exemption is an unforgeable capability", async () => {
    let seen: SendSmsOptions | null = null;
    let authorizedDuringSend = false;
    await sendNewOptOutAcknowledgment(BRAND, "+15550100123", async (opts) => {
      seen = opts;
      authorizedDuringSend = isAuthorizedOptOutAcknowledgment(opts);
      return { ok: true };
    });
    assert.equal(authorizedDuringSend, true);
    assert.equal(isAuthorizedOptOutAcknowledgment(seen!), false, "capability is single-use");
    assert.equal(isAuthorizedOptOutAcknowledgment({ to: "+15550100123", body: optOutAckText(BRAND) }), false, "copying the text is not enough");
  });

  test("suppression: normalization, create-only upsert, shared-number protection", async () => {
    assert.equal(normalizeSmsPhone("+1 (555) 010-0123"), "5550100123");
    assert.equal(normalizeSmsPhone("123"), null);
    const c = new MemorySuppressionClient();
    await ensureSuppression(c, "+15550100123", CARRIER_STOP_REASON);
    await ensureSuppression(c, "5550100123"); // staff opt-out must not overwrite carrier STOP
    assert.equal(c.rows.get("5550100123"), CARRIER_STOP_REASON);
    const r = await applyStaffSmsOptOutChange(c, { customerId: "a", phone: "5550100123", smsOptOut: false, now: new Date() });
    assert.equal(r.status, "preserved_non_staff_reason");

    const fam = new MemorySuppressionClient();
    fam.customers.set("a", { phone: "+15550100124", smsOptOut: true });
    fam.customers.set("b", { phone: "5550100124", smsOptOut: true });
    await applyStaffSmsOptOutChange(fam, { customerId: "a", phone: "+15550100124", smsOptOut: true, now: new Date() });
    const cleared = await applyStaffSmsOptOutChange(fam, { customerId: "a", phone: "+15550100124", smsOptOut: false, now: new Date() });
    assert.equal(cleared.status, "preserved_other_opt_out");
    assert.equal(await fam.isSuppressed("5550100124"), true);
  });

  test("AI voice consent needs its own evidence", () => {
    const ok = () => true;
    const cust = { id: "c", smsOptIn: true };
    const ev = (state: Record<string, unknown>, source = "manual") => ({ granted: true, source, disclosureVersion: "v1", disclosureTextHash: "0".repeat(64), currentState: state });
    assert.equal(voiceCallConsent(cust, null, ok).allowed, false);
    assert.equal(voiceCallConsent(cust, ev({ consentMechanism: LEGACY_SMS_MECHANISM, voiceConsent: true }), ok).basis, "unverified_administrative_sms_consent");
    assert.equal(voiceCallConsent(cust, ev({ voiceConsent: true }), ok).allowed, true);
    assert.equal(voiceCallConsent(cust, ev({ voiceConsent: true }, "web_form"), () => false).allowed, false);
    assert.equal(voiceCallConsent({ ...cust, smsOptIn: false }, ev({ voiceConsent: true }), ok).allowed, false);
  });
});

describe("win-back", () => {
  const snap = (o: Partial<RetentionSnapshot> = {}): RetentionSnapshot => ({ exists: true, ownBillableMemberships: 0, sharedBillableMemberships: 0, livePackagesWithCredits: 0, membershipExpiring: false, packageExpiring: false, ...o });
  test("premise re-check per template", () => {
    assert.equal(winbackNoLongerEligibleReason(RETENTION_TEMPLATES.INACTIVE, snap()), null);
    assert.match(winbackNoLongerEligibleReason(RETENTION_TEMPLATES.INACTIVE, snap({ sharedBillableMemberships: 1 }))!, /billable/);
    assert.match(winbackNoLongerEligibleReason(RETENTION_TEMPLATES.COOLED_OFF, snap({ livePackagesWithCredits: 2 }))!, /live credits/);
    assert.equal(winbackNoLongerEligibleReason(RETENTION_TEMPLATES.AT_RISK, snap({ ownBillableMemberships: 1 })), null);
    assert.match(winbackNoLongerEligibleReason(RETENTION_TEMPLATES.EXPIRING, snap())!, /expiry/);
  });
  test("offer payload: tolerant parse, resolved offers closed, A/B alternation", () => {
    const payload = { kind: "winback_offer", campaign: "winback_return_session", offer: "complimentary_return_session", sentAt: "2026-06-01T00:00:00Z" };
    assert.equal(toWinbackOfferPayload(payload)?.copyVersion, null);
    assert.equal(toWinbackOfferPayload({ ...payload, offer: "other" }), null);
    const future = new Date(Date.now() + 86_400_000);
    assert.ok(findActiveWinbackOffer([{ status: "OPEN", expiresAt: future, payload }]));
    assert.equal(findActiveWinbackOffer([{ status: "OPEN", expiresAt: future, payload: { ...payload, resolvedVia: "conversion:pay_1" } }]), null);
    assert.deepEqual(assignCopyVersions([{ id: 1 }, { id: 2 }, { id: 3 }]).map((x) => x.copyVersion), ["v2a", "v2b", "v2a"]);
  });
});
