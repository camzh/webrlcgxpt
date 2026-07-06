const crypto = require("crypto");

function normalizeHost(host = "") {
  return String(host || "").trim().toLowerCase().split(":")[0];
}

function isAdminDashboardHost(host = "", adminHosts = []) {
  const current = normalizeHost(host);
  return adminHosts.map(normalizeHost).filter(Boolean).includes(current);
}

function dashboardOriginForRequest({ configuredOrigin = "", host = "", fallbackPort = 3000 } = {}) {
  const configured = String(configuredOrigin || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const port = String(host || "").includes(":") ? String(host).split(":").pop() : String(fallbackPort || 3000);
  return `http://admin.rlcgxpt.localhost:${port}`;
}

function canEnterAdminDashboard(session) {
  return session?.role === "superadmin";
}

function createTicketStore({ ttlMs = 60 * 1000, randomBytes = crypto.randomBytes } = {}) {
  const tickets = new Map();

  function issue(session, issuedAt = Date.now()) {
    const ticket = randomBytes(24).toString("hex");
    tickets.set(ticket, {
      session: {
        userId: session.userId || "",
        name: session.name || "",
        phone: session.phone || "",
        group: session.group || "",
        role: session.role || "",
        displayName: session.displayName || session.name || ""
      },
      expiresAt: issuedAt + ttlMs,
      used: false
    });
    return ticket;
  }

  function consume(ticket, consumedAt = Date.now()) {
    const row = tickets.get(String(ticket || ""));
    if (!row) return { ok: false, reason: "missing" };
    if (row.used) return { ok: false, reason: "used" };
    if (row.expiresAt < consumedAt) {
      row.used = true;
      return { ok: false, reason: "expired" };
    }
    row.used = true;
    return { ok: true, session: row.session };
  }

  return { issue, consume };
}

module.exports = {
  canEnterAdminDashboard,
  createTicketStore,
  dashboardOriginForRequest,
  isAdminDashboardHost
};
