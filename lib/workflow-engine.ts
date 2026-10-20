/**
 * Workflow engine (sanitized subset): the automation layer that replaced the
 * hosted CRM's drip campaigns.
 *
 * Model: WorkflowTemplate (name, trigger stage) -> ordered WorkflowSteps
 * (channel, delay, body) -> per-customer WorkflowInstance -> one
 * WorkflowStepExecution per step with its own scheduledAt. A cron job calls
 * processDueWorkflows() every 5 minutes.
 *
 * Dispatch gates, in order, for each due execution:
 *   1. Staleness floor: more than 48h past due => skip with [STALE]. An
 *      outage must never dump its accumulated backlog on customers at once.
 *      Runs before the business-hours reschedule, which would erase the
 *      evidence.
 *   2. Send-time eligibility for retention templates (win-back premise
 *      re-check) => skip [NO_LONGER_ELIGIBLE] and cancel the instance.
 *   3. Business hours in the studio timezone, by message class: solicitation
 *      SMS 09:00-19:00, transactional 07:00-21:00. Outside => reschedule.
 *   4. Consent: opted-out / suppressed => skip [OPTED_OUT].
 *   5. Touch limit: max 3 SMS / 5 email per customer per rolling 5 days
 *      across ALL workflows, reset by a customer reply => skip [TOUCH_LIMIT].
 *   6. Master kill switch (default OFF): SMS/EMAIL are recorded as
 *      [DISPATCH_DISABLED] instead of sent, so a new cadence can be verified
 *      end to end without messaging anyone. CALL_TASK is internal and always
 *      fires.
 * Every path ends by completing the instance if nothing is left pending.
 */

export type WorkflowChannel = "SMS" | "EMAIL" | "CALL_TASK";
export type MessageClass = "TRANSACTIONAL" | "SOLICITATION";

export const BUSINESS_HOURS: Record<MessageClass, { start: number; end: number }> = {
  TRANSACTIONAL: { start: 7, end: 21 },
  SOLICITATION: { start: 9, end: 19 },
};
export const STALE_DISPATCH_FLOOR_HOURS = 48;
export const TOUCH_LIMIT_WINDOW_DAYS = 5;
export const TOUCH_LIMIT_CAPS: Record<"SMS" | "EMAIL", number> = { SMS: 3, EMAIL: 5 };

export interface WorkflowStep {
  id: string;
  stepOrder: number;
  delayMinutes: number;
  channel: WorkflowChannel;
  subject?: string;
  body: string;
}
export interface WorkflowTemplate {
  id: string;
  name: string;
  isActive: boolean;
  /** Retention/sales templates send under the narrower solicitation window. */
  solicitation: boolean;
  steps: WorkflowStep[];
}
export interface WorkflowCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  smsOptOut: boolean;
  emailOptOut: boolean;
  lastRespondedAt: Date | null;
}
export type ExecutionStatus = "pending" | "sent" | "failed" | "skipped";
export interface WorkflowExecution {
  id: string;
  instanceId: string;
  stepId: string;
  channel: WorkflowChannel;
  scheduledAt: Date;
  executedAt: Date | null;
  status: ExecutionStatus;
  message: string | null;
  note: string | null;
}
export interface WorkflowInstance {
  id: string;
  templateId: string;
  customerId: string;
  status: "active" | "paused" | "completed" | "cancelled";
}

export interface WorkflowRepo {
  getTemplateByName(name: string): Promise<WorkflowTemplate | null>;
  getTemplate(id: string): Promise<WorkflowTemplate>;
  getCustomer(id: string): Promise<WorkflowCustomer>;
  getInstance(id: string): Promise<WorkflowInstance>;
  createInstance(customerId: string, templateId: string): Promise<WorkflowInstance>;
  setInstanceStatus(id: string, status: WorkflowInstance["status"]): Promise<void>;
  activeInstancesFor(customerId: string): Promise<WorkflowInstance[]>;
  createExecution(e: Omit<WorkflowExecution, "id">): Promise<WorkflowExecution>;
  updateExecution(id: string, patch: Partial<WorkflowExecution>): Promise<void>;
  executionsFor(instanceId: string): Promise<WorkflowExecution[]>;
  dueExecutions(now: Date, limit: number): Promise<WorkflowExecution[]>;
  countSent(customerId: string, channel: WorkflowChannel, since: Date): Promise<number>;
}

export interface MessageSender {
  sendSms(to: string, body: string): Promise<{ id: string }>;
  sendEmail(to: string, subject: string, body: string): Promise<{ id: string }>;
  createCallTask(customerId: string, body: string): Promise<{ id: string }>;
}

export interface WorkflowDeps {
  repo: WorkflowRepo;
  sender: MessageSender;
  timezone: string;
  brandName: string;
  dispatchEnabled: boolean;
  isSuppressed?: (phone: string) => Promise<boolean>;
  /** Send-time premise check; returns a reason to stop, or null. */
  eligibility?: (templateName: string, customerId: string) => Promise<string | null>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function hourIn(timezone: string, at: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false })
    .formatToParts(at)
    .find((p) => p.type === "hour");
  const h = part ? Number.parseInt(part.value, 10) : 0;
  return h === 24 ? 0 : h; // Intl can render midnight as 24
}

export function isWithinBusinessHours(channel: WorkflowChannel, at: Date, timezone: string, cls: MessageClass): boolean {
  if (channel === "EMAIL") return true; // email doesn't ring a phone
  const h = hourIn(timezone, at);
  const w = BUSINESS_HOURS[cls];
  return h >= w.start && h < w.end;
}

export function nextBusinessTime(channel: WorkflowChannel, from: Date, timezone: string, cls: MessageClass): Date {
  let t = new Date(from);
  for (let i = 0; i < 7 * 48 && !isWithinBusinessHours(channel, t, timezone, cls); i++) {
    t = new Date(t.getTime() + 30 * 60 * 1000);
  }
  return t;
}

export function messageClassFor(template: Pick<WorkflowTemplate, "solicitation">, channel: WorkflowChannel): MessageClass {
  return channel === "SMS" && template.solicitation ? "SOLICITATION" : "TRANSACTIONAL";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface TemplateVariables {
  first_name: string;
  last_name: string;
  brand: string;
  [key: string]: string | undefined;
}

/** `{{var}}` substitution. A missing first name reads "there", never "{{first_name}}". */
export function renderTemplate(template: string, vars: TemplateVariables): string {
  const v: Record<string, string | undefined> = { ...vars, first_name: vars.first_name?.trim() || "there" };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (typeof v[key] === "string" && v[key] ? v[key]! : m));
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

/**
 * Start a template for a customer: cancels any other active instance (one
 * conversation at a time), then schedules every step cumulatively from now.
 */
export async function startWorkflow(deps: WorkflowDeps, customerId: string, templateName: string): Promise<string | null> {
  const template = await deps.repo.getTemplateByName(templateName);
  if (!template || !template.isActive || template.steps.length === 0) return null;
  for (const inst of await deps.repo.activeInstancesFor(customerId)) {
    await cancelInstance(deps, inst.id, "new_workflow_started");
  }
  const instance = await deps.repo.createInstance(customerId, template.id);
  let at = (deps.now ?? (() => new Date()))();
  for (const step of [...template.steps].sort((a, b) => a.stepOrder - b.stepOrder)) {
    at = new Date(at.getTime() + step.delayMinutes * 60 * 1000);
    await deps.repo.createExecution({
      instanceId: instance.id,
      stepId: step.id,
      channel: step.channel,
      scheduledAt: at,
      executedAt: null,
      status: "pending",
      message: null,
      note: null,
    });
  }
  return instance.id;
}

async function cancelInstance(deps: WorkflowDeps, instanceId: string, reason: string) {
  await deps.repo.setInstanceStatus(instanceId, "cancelled");
  for (const e of await deps.repo.executionsFor(instanceId)) {
    if (e.status === "pending") await deps.repo.updateExecution(e.id, { status: "failed", note: `Cancelled: ${reason}` });
  }
}

async function completeIfDone(deps: WorkflowDeps, instanceId: string) {
  const inst = await deps.repo.getInstance(instanceId);
  if (inst.status !== "active") return;
  const execs = await deps.repo.executionsFor(instanceId);
  if (execs.every((e) => e.status !== "pending")) await deps.repo.setInstanceStatus(instanceId, "completed");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type DispatchOutcome = "sent" | "stale" | "ineligible" | "rescheduled" | "opted_out" | "touch_limit" | "dispatch_disabled" | "failed";

export async function touchLimitAllows(deps: WorkflowDeps, customer: WorkflowCustomer, channel: WorkflowChannel, now: Date) {
  if (channel !== "SMS" && channel !== "EMAIL") return true; // internal tasks don't spend the budget
  const since = new Date(now.getTime() - TOUCH_LIMIT_WINDOW_DAYS * 86_400_000);
  if (customer.lastRespondedAt && customer.lastRespondedAt >= since) return true; // they're engaged
  return (await deps.repo.countSent(customer.id, channel, since)) < TOUCH_LIMIT_CAPS[channel];
}

export async function executeStep(deps: WorkflowDeps, exec: WorkflowExecution): Promise<DispatchOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const instance = await deps.repo.getInstance(exec.instanceId);
  const template = await deps.repo.getTemplate(instance.templateId);
  const step = template.steps.find((s) => s.id === exec.stepId)!;
  const customer = await deps.repo.getCustomer(instance.customerId);
  const skip = async (note: string, outcome: DispatchOutcome) => {
    await deps.repo.updateExecution(exec.id, { status: "skipped", executedAt: now, note });
    return outcome;
  };

  try {
    if (now.getTime() - exec.scheduledAt.getTime() > STALE_DISPATCH_FLOOR_HOURS * 3_600_000) {
      return await skip(`[STALE] scheduledAt ${exec.scheduledAt.toISOString()} more than ${STALE_DISPATCH_FLOOR_HOURS}h past due`, "stale");
    }

    if (deps.eligibility) {
      const reason = await deps.eligibility(template.name, customer.id);
      if (reason) {
        await skip(`[NO_LONGER_ELIGIBLE] ${reason}`, "ineligible");
        await cancelInstance(deps, instance.id, `[NO_LONGER_ELIGIBLE] ${reason}`);
        return "ineligible";
      }
    }

    const cls = messageClassFor(template, step.channel);
    if (!isWithinBusinessHours(step.channel, now, deps.timezone, cls)) {
      await deps.repo.updateExecution(exec.id, { scheduledAt: nextBusinessTime(step.channel, now, deps.timezone, cls) });
      return "rescheduled";
    }

    if (step.channel === "SMS") {
      if (!customer.phone || customer.smsOptOut || (await deps.isSuppressed?.(customer.phone))) {
        return await skip("[OPTED_OUT] sms", "opted_out");
      }
    }
    if (step.channel === "EMAIL" && (!customer.email || customer.emailOptOut)) {
      return await skip("[OPTED_OUT] email", "opted_out");
    }

    if (!(await touchLimitAllows(deps, customer, step.channel, now))) {
      return await skip(`[TOUCH_LIMIT] ${step.channel} cap reached in ${TOUCH_LIMIT_WINDOW_DAYS}d`, "touch_limit");
    }

    const vars: TemplateVariables = { first_name: customer.firstName, last_name: customer.lastName, brand: deps.brandName };
    const body = renderTemplate(step.body, vars);

    if (!deps.dispatchEnabled && step.channel !== "CALL_TASK") {
      await deps.repo.updateExecution(exec.id, { status: "skipped", executedAt: now, message: body, note: "[DISPATCH_DISABLED]" });
      return "dispatch_disabled";
    }

    const sent =
      step.channel === "SMS"
        ? await deps.sender.sendSms(customer.phone!, body)
        : step.channel === "EMAIL"
          ? await deps.sender.sendEmail(customer.email!, renderTemplate(step.subject ?? deps.brandName, vars), body)
          : await deps.sender.createCallTask(customer.id, body);
    await deps.repo.updateExecution(exec.id, { status: "sent", executedAt: now, message: body, note: `externalId=${sent.id}` });
    return "sent";
  } catch (err) {
    await deps.repo.updateExecution(exec.id, { status: "failed", executedAt: now, note: err instanceof Error ? err.message : String(err) });
    return "failed";
  } finally {
    await completeIfDone(deps, instance.id);
  }
}

export async function processDueWorkflows(deps: WorkflowDeps, limit = 200): Promise<Record<DispatchOutcome, number>> {
  const now = (deps.now ?? (() => new Date()))();
  const counts = { sent: 0, stale: 0, ineligible: 0, rescheduled: 0, opted_out: 0, touch_limit: 0, dispatch_disabled: 0, failed: 0 };
  for (const exec of await deps.repo.dueExecutions(now, limit)) {
    const instance = await deps.repo.getInstance(exec.instanceId);
    if (instance.status !== "active") continue;
    counts[await executeStep(deps, exec)]++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// In-memory repo (tests + demo)
// ---------------------------------------------------------------------------

export class MemoryWorkflowRepo implements WorkflowRepo {
  templates = new Map<string, WorkflowTemplate>();
  customers = new Map<string, WorkflowCustomer>();
  instances = new Map<string, WorkflowInstance>();
  executions = new Map<string, WorkflowExecution>();
  private seq = 0;
  private id(p: string) {
    return `${p}_${++this.seq}`;
  }
  async getTemplateByName(name: string) {
    return [...this.templates.values()].find((t) => t.name === name) ?? null;
  }
  async getTemplate(id: string) {
    return this.templates.get(id)!;
  }
  async getCustomer(id: string) {
    return this.customers.get(id)!;
  }
  async getInstance(id: string) {
    return this.instances.get(id)!;
  }
  async createInstance(customerId: string, templateId: string) {
    const i: WorkflowInstance = { id: this.id("wfi"), customerId, templateId, status: "active" };
    this.instances.set(i.id, i);
    return i;
  }
  async setInstanceStatus(id: string, status: WorkflowInstance["status"]) {
    this.instances.get(id)!.status = status;
  }
  async activeInstancesFor(customerId: string) {
    return [...this.instances.values()].filter((i) => i.customerId === customerId && (i.status === "active" || i.status === "paused"));
  }
  async createExecution(e: Omit<WorkflowExecution, "id">) {
    const row = { ...e, id: this.id("wfe") };
    this.executions.set(row.id, row);
    return row;
  }
  async updateExecution(id: string, patch: Partial<WorkflowExecution>) {
    Object.assign(this.executions.get(id)!, patch);
  }
  async executionsFor(instanceId: string) {
    return [...this.executions.values()].filter((e) => e.instanceId === instanceId);
  }
  async dueExecutions(now: Date, limit: number) {
    return [...this.executions.values()]
      .filter((e) => e.status === "pending" && e.scheduledAt <= now)
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
      .slice(0, limit);
  }
  async countSent(customerId: string, channel: WorkflowChannel, since: Date) {
    return [...this.executions.values()].filter(
      (e) =>
        e.status === "sent" &&
        e.channel === channel &&
        e.executedAt !== null &&
        e.executedAt >= since &&
        this.instances.get(e.instanceId)?.customerId === customerId,
    ).length;
  }
}
