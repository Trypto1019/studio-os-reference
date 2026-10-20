import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decide, type RequestFacts } from "../middleware.ts";
import { loadConfig } from "../lib/config.ts";
import { createAuthz, hasPermission, isAuthError, requireCronSecret, type StaffSession } from "../lib/api-auth.ts";

const config = loadConfig({});
const facts = (over: Partial<Omit<RequestFacts, "headers">> & { headers?: Record<string, string> } = {}): RequestFacts => ({
  host: over.host ?? "crm.example.com",
  pathname: over.pathname ?? "/",
  headers: new Headers(over.headers ?? {}),
  staffSession: over.staffSession ?? null,
});
const staff = { id: "usr_1" };

describe("middleware: host routing", () => {
  test("marketing host rewrites public pages to the internal route group", () => {
    assert.deepEqual(decide(facts({ host: "example.com", pathname: "/" }), config), { type: "rewrite", pathname: "/_marketing", internal: "marketing" });
    assert.deepEqual(decide(facts({ host: "www.example.com:443", pathname: "/pricing" }), config), { type: "rewrite", pathname: "/_marketing/pricing", internal: "marketing" });
  });
  test("marketing host never exposes app surfaces, even with a staff session", () => {
    assert.deepEqual(decide(facts({ host: "example.com", pathname: "/dashboard", staffSession: staff }), config), { type: "not_found" });
    assert.deepEqual(decide(facts({ host: "example.com", pathname: "/api/customers", staffSession: staff }), config), { type: "not_found" });
    assert.deepEqual(decide(facts({ host: "example.com", pathname: "/api/booking/availability" }), config), { type: "next" });
  });
  test("internal route group is not a second public URL on app hosts", () => {
    assert.deepEqual(decide(facts({ pathname: "/_marketing/pricing" }), config), { type: "not_found" });
  });
  test("root redirects by host", () => {
    assert.deepEqual(decide(facts({ host: "crm.example.com" }), config), { type: "redirect", location: "/login", status: 302 });
    assert.deepEqual(decide(facts({ host: "book.example.com" }), config), { type: "redirect", location: "/book/login", status: 302 });
    assert.deepEqual(decide(facts({ host: "crm.example.com", staffSession: staff }), config), { type: "redirect", location: "/dashboard", status: 302 });
  });
  test("booking host never serves staff pages", () => {
    assert.deepEqual(decide(facts({ host: "book.example.com", pathname: "/customers", staffSession: staff }), config), { type: "not_found" });
  });
});

describe("middleware: API deny-by-default", () => {
  test("public allowlist passes, exact prefix only", () => {
    assert.deepEqual(decide(facts({ pathname: "/api/webhooks/stripe" }), config), { type: "next" });
    assert.equal(decide(facts({ pathname: "/api/webhooksX" }), config).type, "json");
  });
  test("unknown API without credentials -> 401", () => {
    const d = decide(facts({ pathname: "/api/payments/charge" }), config);
    assert.deepEqual(d, { type: "json", status: 401, body: { error: "Unauthenticated" } });
  });
  test("staff cookie or customer bearer marker passes the baseline gate", () => {
    assert.deepEqual(decide(facts({ pathname: "/api/payments/charge", staffSession: staff }), config), { type: "next" });
    assert.deepEqual(decide(facts({ pathname: "/api/me", headers: { authorization: "Bearer x" } }), config), { type: "next" });
  });
  test("server-to-server routes need their shared secret (constant-time)", () => {
    const env = { SYNC_SECRET: "sync-secret-for-tests" };
    assert.equal(decide(facts({ pathname: "/api/payments/record", staffSession: staff }), config, env).type, "json");
    assert.deepEqual(decide(facts({ pathname: "/api/payments/record", headers: { "x-sync-secret": "sync-secret-for-tests" } }), config, env), { type: "next" });
    assert.equal(decide(facts({ pathname: "/api/payments/record", headers: { "x-sync-secret": "anything" } }), config, {}).type, "json");
  });
});

describe("middleware: forced password change", () => {
  const flagged = { id: "usr_2", mustChangePassword: true };
  test("pages redirect, APIs 403, escape hatches allowed", () => {
    assert.deepEqual(decide(facts({ pathname: "/dashboard", staffSession: flagged }), config), { type: "redirect", location: "/account/change-password", status: 307 });
    assert.equal(decide(facts({ pathname: "/api/customers", staffSession: flagged }), config).type, "json");
    assert.deepEqual(decide(facts({ pathname: "/account/change-password", staffSession: flagged }), config), { type: "next" });
    assert.deepEqual(decide(facts({ pathname: "/api/auth/signout", staffSession: flagged }), config), { type: "next" });
  });
});

describe("route-level RBAC", () => {
  const sessions: Record<string, StaffSession> = {
    owner: { userId: "u_o", email: "owner@example.com", name: "Owner", role: "owner" },
    manager: { userId: "u_m", email: "manager@example.com", name: "Manager", role: "manager" },
    staff: { userId: "u_s", email: "desk@example.com", name: "Desk", role: "staff" },
  };
  const authz = createAuthz({
    getStaffSession: async (req) => sessions[req.headers.get("x-test-role") ?? ""] ?? null,
    getCustomerSession: async (req) => {
      const id = req.headers.get("x-test-customer");
      return id ? { customerId: id, email: "c@example.com" } : null;
    },
  });
  const r = (h: Record<string, string> = {}) => new Request("https://crm.example.com/api/x", { headers: h });

  test("permission matrix", async () => {
    const charge = async (role: string) => authz.requirePermission(r({ "x-test-role": role }), "CHARGE_CUSTOMER");
    assert.equal(isAuthError(await charge("owner")), false);
    assert.equal(isAuthError(await charge("manager")), false);
    const denied = await charge("staff");
    assert.ok(isAuthError(denied) && denied.status === 403);
    const anon = await authz.requirePermission(r(), "VIEW_CUSTOMERS");
    assert.ok(isAuthError(anon) && anon.status === 401);
    assert.equal(hasPermission("manager", "MANAGE_USERS"), false);
    assert.equal(hasPermission("staff", "VIEW_CUSTOMERS"), true);
  });

  test("customer ownership: no cross-customer access; staff may act on anyone", async () => {
    const own = await authz.requireCustomerOwnership(r({ "x-test-customer": "cus_a" }), "cus_a");
    assert.equal(isAuthError(own), false);
    const cross = await authz.requireCustomerOwnership(r({ "x-test-customer": "cus_a" }), "cus_b");
    assert.ok(isAuthError(cross) && cross.status === 403);
    const s = await authz.requireStaffOrCustomerOwnership(r({ "x-test-role": "staff" }), "cus_b");
    assert.ok(!isAuthError(s) && s.actor === "staff");
  });

  test("withPermission wrapper", async () => {
    const handler = authz.withPermission("REFUND_PAYMENT", async (_req, session) => new Response(session.role));
    assert.equal((await handler(r({ "x-test-role": "staff" }))).status, 403);
    assert.equal(await (await handler(r({ "x-test-role": "manager" }))).text(), "manager");
  });

  test("cron secret: missing config is 500, wrong token 401, right token passes", () => {
    const req = (auth?: string) => new Request("https://crm.example.com/api/cron/x", { headers: auth ? { authorization: auth } : {} });
    assert.equal(requireCronSecret(req("Bearer cron-test"), undefined)?.status, 500);
    assert.equal(requireCronSecret(req("Bearer nope"), "cron-test")?.status, 401);
    assert.equal(requireCronSecret(req("Bearer cron-test"), "cron-test"), null);
  });
});
