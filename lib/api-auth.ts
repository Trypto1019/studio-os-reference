/**
 * Route-level authentication and authorization (RBAC + ownership).
 *
 * Middleware (../middleware.ts) does the cheap baseline gate: "is there any
 * credential at all?". Route handlers then call these helpers for the real
 * decision: role, semantic permission, or customer ownership. Defence in
 * depth: deleting a middleware rule never silently opens a route.
 *
 * Framework-light: session resolution is injected, results are either the
 * authorized principal or a ready-to-return Web Response.
 *
 *   const auth = await authz.requirePermission(req, "CHARGE_CUSTOMER");
 *   if (isAuthError(auth)) return auth;
 *   // auth.userId, auth.role ...
 */

import { constantTimeEqual } from "./webhooks/signatures.ts";

export type UserRole = "owner" | "manager" | "staff";

export interface StaffSession {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  mustChangePassword?: boolean;
}

export interface CustomerSession {
  customerId: string;
  email: string;
}

/**
 * Semantic permission map: the single source of truth for which roles may
 * do what. Client components may import it for affordances (hide a button),
 * but only the server-side require* calls authorize anything.
 */
export const PERMISSIONS = {
  MANAGE_USERS: ["owner"],
  MANAGE_INTEGRATIONS: ["owner"],
  HARD_DELETE_CUSTOMER: ["owner"],
  MANAGE_BILLING: ["owner", "manager"],
  CHARGE_CUSTOMER: ["owner", "manager"],
  REFUND_PAYMENT: ["owner", "manager"],
  GRANT_COMPS: ["owner", "manager"],
  RESET_CUSTOMER_PASSWORD: ["owner", "manager"],
  UPDATE_CUSTOMER_CARD: ["owner", "manager", "staff"],
  VIEW_CUSTOMERS: ["owner", "manager", "staff"],
  BOOK_SESSIONS: ["owner", "manager", "staff"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: UserRole | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}

export function isAuthError(value: unknown): value is Response {
  return value instanceof Response;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface AuthDeps {
  getStaffSession(req: Request): Promise<StaffSession | null>;
  /** Verifies the customer bearer token (signature + DB lookup). */
  getCustomerSession(req: Request): Promise<CustomerSession | null>;
}

export function createAuthz(deps: AuthDeps) {
  async function requireAuth(req: Request): Promise<StaffSession | Response> {
    const s = await deps.getStaffSession(req);
    return s ? s : json({ error: "Unauthenticated" }, 401);
  }

  async function requireRole(req: Request, roles: readonly UserRole[]): Promise<StaffSession | Response> {
    const auth = await requireAuth(req);
    if (isAuthError(auth)) return auth;
    if (!roles.includes(auth.role)) return json({ error: "Forbidden", required: roles, actual: auth.role }, 403);
    return auth;
  }

  async function requirePermission(req: Request, permission: Permission): Promise<StaffSession | Response> {
    return requireRole(req, PERMISSIONS[permission]);
  }

  async function requireCustomerOwnership(req: Request, resourceCustomerId: string): Promise<CustomerSession | Response> {
    const c = await deps.getCustomerSession(req);
    if (!c) return json({ error: "Customer authentication required" }, 401);
    if (c.customerId !== resourceCustomerId) return json({ error: "Forbidden: cross-customer access denied" }, 403);
    return c;
  }

  /** Staff may act on any customer; a customer only on themself. */
  async function requireStaffOrCustomerOwnership(
    req: Request,
    resourceCustomerId: string,
  ): Promise<{ actor: "staff"; session: StaffSession } | { actor: "customer"; session: CustomerSession } | Response> {
    const staff = await deps.getStaffSession(req);
    if (staff) return { actor: "staff", session: staff };
    const customer = await requireCustomerOwnership(req, resourceCustomerId);
    return isAuthError(customer) ? customer : { actor: "customer", session: customer };
  }

  function withPermission<A extends unknown[]>(
    permission: Permission,
    handler: (req: Request, session: StaffSession, ...args: A) => Promise<Response>,
  ) {
    return async (req: Request, ...args: A): Promise<Response> => {
      const auth = await requirePermission(req, permission);
      return isAuthError(auth) ? auth : handler(req, auth, ...args);
    };
  }

  return { requireAuth, requireRole, requirePermission, requireCustomerOwnership, requireStaffOrCustomerOwnership, withPermission };
}

/**
 * Cron endpoints: `Authorization: Bearer <CRON_SECRET>`, constant-time.
 * Missing secret is a server misconfiguration (500), never "allow".
 */
export function requireCronSecret(req: Request, expected: string | undefined): Response | null {
  if (!expected) return json({ error: "Server misconfigured" }, 500);
  const provided = req.headers.get("authorization") ?? "";
  return constantTimeEqual(provided, `Bearer ${expected}`) ? null : json({ error: "Invalid cron secret" }, 401);
}
