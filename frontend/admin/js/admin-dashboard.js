(function () {
  "use strict";

  var FA = window.FlareAdmin;
  if (!FA) return;

  var root = document.getElementById("admin-dashboard-root");
  if (!root) return;

  var statusEl = document.getElementById("admin-dashboard-status");
  var healthEl = document.getElementById("admin-health-status");
  var healthDot = document.getElementById("admin-health-dot");
  var recentBody = document.getElementById("admin-recent-orders-body");
  var recentEmpty = document.getElementById("admin-recent-orders-empty");
  var recentLoading = document.getElementById("admin-recent-orders-loading");

  function setMetric(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = typeof value === "number" ? String(value) : "—";
  }

  function titleCase(value) {
    if (!value) return "—";
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function formatDate(value) {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (err) {
      return "—";
    }
  }

  function statusClass(status) {
    switch (status) {
      case "paid":
      case "active":
      case "successful":
        return "is-success";
      case "awaiting_payment":
      case "pending":
      case "provisioning":
      case "initiated":
      case "pending_payment":
        return "is-warning";
      case "failed":
        return "is-danger";
      case "cancelled":
      case "refunded":
      case "suspended":
      case "terminated":
        return "is-muted";
      default:
        return "";
    }
  }

  async function loadHealth() {
    try {
      var res = await FA.apiRequest("/api/admin/health", {
        headers: { Accept: "application/json" },
      });
      if (FA.redirectIfSignedOut(res.response)) return;
      if (res.response.ok && res.body && res.body.success) {
        if (healthEl) healthEl.textContent = "API healthy";
        if (healthDot) {
          healthDot.classList.add("is-ok");
          healthDot.classList.remove("is-err");
        }
      } else {
        if (healthEl) healthEl.textContent = "API check failed";
        if (healthDot) {
          healthDot.classList.add("is-err");
          healthDot.classList.remove("is-ok");
        }
      }
    } catch (err) {
      if (healthEl) healthEl.textContent = "API unreachable";
      if (healthDot) {
        healthDot.classList.add("is-err");
        healthDot.classList.remove("is-ok");
      }
    }
  }

  async function loadMetrics() {
    try {
      var res = await FA.apiRequest("/api/admin/dashboard", {
        headers: { Accept: "application/json" },
      });
      if (FA.redirectIfSignedOut(res.response)) return;
      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(statusEl, FA.errorFromResponse(res.body, "Unable to load metrics."), "error");
        return;
      }
      var m = res.body.data.metrics || {};
      setMetric("metric-customers", m.customers);
      setMetric("metric-orders", m.orders);
      setMetric("metric-awaiting", m.awaitingPayment);
      setMetric("metric-paid", m.paid);
      setMetric("metric-failed-orders", m.failedOrders);
      setMetric("metric-active-services", m.activeServices);
      setMetric("metric-provisioning", m.provisioningServices);
      setMetric("metric-failed-services", m.failedServices);
      FA.clearMessage(statusEl);
    } catch (err) {
      FA.setStatus(statusEl, "Unable to load dashboard metrics.", "error");
    }
  }

  function appendRecentRow(order) {
    if (!recentBody) return;
    var tr = document.createElement("tr");

    var tdOrder = document.createElement("td");
    tdOrder.setAttribute("data-label", "Order");
    var link = document.createElement("a");
    link.href = "/admin/orders/" + order.id;
    link.textContent = order.orderNumber;
    tdOrder.appendChild(link);
    tr.appendChild(tdOrder);

    var tdCustomer = document.createElement("td");
    tdCustomer.setAttribute("data-label", "Customer");
    tdCustomer.textContent = (order.customer && order.customer.email) || "—";
    tr.appendChild(tdCustomer);

    var tdAmount = document.createElement("td");
    tdAmount.setAttribute("data-label", "Amount");
    tdAmount.textContent =
      (order.currency === "BDT" ? "৳" : order.currency + " ") + order.amount;
    tr.appendChild(tdAmount);

    var tdStatus = document.createElement("td");
    tdStatus.setAttribute("data-label", "Status");
    var badge = document.createElement("span");
    badge.className = "status-badge " + statusClass(order.status);
    badge.textContent = titleCase(order.status);
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    var tdCreated = document.createElement("td");
    tdCreated.setAttribute("data-label", "Created");
    tdCreated.textContent = formatDate(order.createdAt);
    tr.appendChild(tdCreated);

    recentBody.appendChild(tr);
  }

  async function loadRecentOrders() {
    if (recentLoading) recentLoading.hidden = false;
    if (recentEmpty) recentEmpty.hidden = true;
    if (recentBody) recentBody.textContent = "";
    try {
      var res = await FA.apiRequest("/api/admin/orders?limit=5", {
        headers: { Accept: "application/json" },
      });
      if (recentLoading) recentLoading.hidden = true;
      if (FA.redirectIfSignedOut(res.response)) return;
      if (!res.response.ok || !res.body || !res.body.success) {
        if (recentEmpty) {
          recentEmpty.hidden = false;
          recentEmpty.textContent = FA.errorFromResponse(
            res.body,
            "Unable to load recent orders."
          );
        }
        return;
      }
      var orders = (res.body.data && res.body.data.orders) || [];
      if (!orders.length) {
        if (recentEmpty) {
          recentEmpty.hidden = false;
          recentEmpty.textContent = "No orders yet.";
        }
        return;
      }
      orders.forEach(appendRecentRow);
    } catch (err) {
      if (recentLoading) recentLoading.hidden = true;
      if (recentEmpty) {
        recentEmpty.hidden = false;
        recentEmpty.textContent = "Unable to load recent orders.";
      }
    }
  }

  (async function initDashboard() {
    var admin = await FA.ensureAdminOrLogin();
    if (!admin) return;
    FA.initShell(admin);
    await Promise.all([loadHealth(), loadMetrics(), loadRecentOrders()]);
  })();
})();
