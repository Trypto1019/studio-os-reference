/**
 * Win-back / retention send-time eligibility.
 *
 * Enrollment captures a moment in time; a re-purchase, a new membership or
 * an expiry extension between enrollment and dispatch makes the drip wrong
 * ("we miss you!" to someone who rebooked yesterday). So the workflow
 * dispatcher re-checks the template's PREMISE immediately before every send
 * and, if it no longer holds, skips the step with an honest marker and
 * cancels the rest of the instance. Purchase triggers also cancel these
 * instances directly, even on same-stage purchases.
 *
 * Premise per template:
 *   INACTIVE / COOLED_OFF: customer is gone (no billable membership, own OR
 *     shared/family, and no unexpired package credits).
 *   AT_RISK: the drip is about a billable membership; none left => dead.
 *   EXPIRING: a membership/package expiry signal must still exist.
 */

export const RETENTION_TEMPLATES = {
  AT_RISK: "Member - At Risk",
  EXPIRING: "Member - Expiring",
  INACTIVE: "Member - Inactive",
  COOLED_OFF: "Cooled Off - Reopen",
} as const;

export const WINBACK_TEMPLATE_NAMES: readonly string[] = Object.values(RETENTION_TEMPLATES);

export interface RetentionSnapshot {
  exists: boolean;
  ownBillableMemberships: number;
  /** Family/shared plans: an own-only count reads an active shared member as "gone". */
  sharedBillableMemberships: number;
  livePackagesWithCredits: number;
  membershipExpiring: boolean;
  packageExpiring: boolean;
}

/** Returns a human-readable reason when the premise no longer holds, else null. */
export function winbackNoLongerEligibleReason(templateName: string, s: RetentionSnapshot): string | null {
  if (!s.exists) return "customer no longer exists";
  if (templateName === RETENTION_TEMPLATES.EXPIRING) {
    return s.membershipExpiring || s.packageExpiring ? null : "no membership or package expiry signal remains";
  }
  const billable = s.ownBillableMemberships + s.sharedBillableMemberships;
  if (templateName === RETENTION_TEMPLATES.AT_RISK) {
    return billable > 0 ? null : "no billable membership remains";
  }
  if (billable > 0) return `customer now has ${billable} billable membership(s)`;
  if (s.livePackagesWithCredits > 0) return `customer now has ${s.livePackagesWithCredits} package(s) with live credits`;
  return null;
}
