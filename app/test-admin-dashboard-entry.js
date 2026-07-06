const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canEnterAdminDashboard,
  createTicketStore,
  dashboardOriginForRequest,
  isAdminDashboardHost
} = require("./admin-dashboard-entry");

test("recognizes the simulated admin subdomain host", () => {
  assert.equal(isAdminDashboardHost("admin.rlcgxpt.localhost:3100", ["admin.rlcgxpt.localhost"]), true);
  assert.equal(isAdminDashboardHost("rlcgxpt.localhost:3100", ["admin.rlcgxpt.localhost"]), false);
});

test("builds the simulated admin origin from the current local main-domain port", () => {
  assert.equal(
    dashboardOriginForRequest({
      configuredOrigin: "",
      host: "rlcgxpt.localhost:3100",
      fallbackPort: 3000
    }),
    "http://admin.rlcgxpt.localhost:3100"
  );
});

test("allows only superadmin sessions to request a dashboard entry ticket", () => {
  assert.equal(canEnterAdminDashboard({ role: "superadmin" }), true);
  assert.equal(canEnterAdminDashboard({ role: "admin" }), false);
  assert.equal(canEnterAdminDashboard({ role: "member" }), false);
  assert.equal(canEnterAdminDashboard(null), false);
});

test("issues tickets that can be consumed only once before expiry", () => {
  const store = createTicketStore({ ttlMs: 1000, randomBytes: () => Buffer.from("123456789012345678901234") });
  const ticket = store.issue({ userId: "u1", name: "王经理", role: "superadmin" }, 1000);

  const first = store.consume(ticket, 1200);
  assert.equal(first.ok, true);
  assert.equal(first.session.name, "王经理");

  const second = store.consume(ticket, 1200);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "used");

  const expiredTicket = store.issue({ userId: "u1", name: "王经理", role: "superadmin" }, 2000);
  const expired = store.consume(expiredTicket, 4001);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
});
