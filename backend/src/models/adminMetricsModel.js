const { query } = require('../config/database');

// Single-round-trip aggregate metrics for the admin overview.
// Only server-derived counts from existing tables — no secrets, no N+1.
async function getDashboardMetrics() {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE role = 'customer') AS customers,
      (SELECT COUNT(*)::int FROM orders) AS orders,
      (SELECT COUNT(*)::int FROM orders WHERE status = 'awaiting_payment') AS awaiting_payment,
      (SELECT COUNT(*)::int FROM orders WHERE status = 'paid') AS paid,
      (SELECT COUNT(*)::int FROM orders WHERE status = 'failed') AS failed_orders,
      (SELECT COUNT(*)::int FROM service_instances WHERE status = 'active') AS active_services,
      (SELECT COUNT(*)::int FROM service_instances WHERE status = 'provisioning') AS provisioning_services,
      (SELECT COUNT(*)::int FROM service_instances WHERE status = 'failed') AS failed_services
  `);

  const r = rows[0] || {};
  return {
    customers: r.customers || 0,
    orders: r.orders || 0,
    awaitingPayment: r.awaiting_payment || 0,
    paid: r.paid || 0,
    failedOrders: r.failed_orders || 0,
    activeServices: r.active_services || 0,
    provisioningServices: r.provisioning_services || 0,
    failedServices: r.failed_services || 0,
  };
}

module.exports = { getDashboardMetrics };
