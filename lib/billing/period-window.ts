/**
 * Period-window decision for a staff-initiated billing-day change.
 *
 * Incident pattern this guards against: moving `nextBillingDate` while
 * leaving `currentPeriodEnd` months in the past. The stale window then made
 * entitlement checks treat a paying member as lapsed (unpaid session flags,
 * wrong renewal math). This helper is the single place that classifies the
 * window and computes what the change should do to it; the route stays a
 * thin shell, so the behaviour is fixture-testable without auth mocking.
 */

export type PeriodWindowChoice = "align" | "keep" | null;

export type PeriodWindowPlan =
  | { kind: "decision_required"; staleWindow: true }
  | {
      kind: "proceed";
      staleWindow: boolean;
      /** Fields to merge into the membership update ({} = leave the window). */
      periodData:
        | { currentPeriodEnd: Date }
        | { currentPeriodStart: Date; currentPeriodEnd: Date }
        | Record<string, never>;
    };

export function planPeriodWindowForBillingDayChange(args: {
  previousCurrentPeriodEnd: Date;
  previousNextBillingDate: Date;
  newNextBillingDate: Date;
  billingIntervalMonths: number;
  choice: PeriodWindowChoice;
  now?: Date;
}): PeriodWindowPlan {
  const now = args.now ?? new Date();
  const mirrors = args.previousCurrentPeriodEnd.getTime() === args.previousNextBillingDate.getTime();

  if (mirrors) {
    // Normal case: the window end slides with the billing date.
    return { kind: "proceed", staleWindow: false, periodData: { currentPeriodEnd: args.newNextBillingDate } };
  }

  const staleWindow = args.previousCurrentPeriodEnd.getTime() < now.getTime();
  if (!staleWindow) {
    // Live window that doesn't mirror the billing date (e.g. a mid-cycle
    // courtesy shift): leave it alone.
    return { kind: "proceed", staleWindow: false, periodData: {} };
  }

  // Stale window: staff must choose explicitly; never guess.
  if (args.choice === null) return { kind: "decision_required", staleWindow: true };
  if (args.choice === "keep") return { kind: "proceed", staleWindow: true, periodData: {} };

  // align: re-anchor the whole window to the new billing date.
  const start = new Date(args.newNextBillingDate.getTime());
  const anchorDay = start.getUTCDate();
  start.setUTCMonth(start.getUTCMonth() - args.billingIntervalMonths);
  // Month-length clamp (Mar 31 - 1 month = Feb 28/29).
  if (start.getUTCDate() !== anchorDay) start.setUTCDate(0);

  return {
    kind: "proceed",
    staleWindow: true,
    periodData: { currentPeriodStart: start, currentPeriodEnd: args.newNextBillingDate },
  };
}
