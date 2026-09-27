(function () {
  "use strict";

  var FA = window.FlareAdmin;
  if (!FA) return;

  var root = document.getElementById("admin-customer-detail-root");
  if (!root) return;

  var statusEl = document.getElementById("admin-customer-status");
  var titleEl = document.getElementById("admin-customer-title");

  var PAGE_SIZE = 10;
  var currentAdmin = null;
  var currentCustomer = null;
  var actionBusy = false;
  var ordersState = { page: 1 };
  var paymentsState = { page: 1 };

  function customerIdFromPath() {
    var m = window.location.pathname.match(
      /^\/admin\/customers\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    );
    return m ? m[1] : null;
  }

  var customerId = customerIdFromPath();

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
      case "active":
      case "paid":
      case "successful":
      case "verified":
        return "is-success";
      case "pending":
      case "awaiting_payment":
      case "awaiting_verification":
      case "provisioning":
      case "initiated":
        return "is-warning";
      case "failed":
      case "suspended":
      case "rejected":
        return "is-danger";
      case "cancelled":
      case "refunded":
      case "terminated":
      case "expired":
        return "is-muted";
      default:
        return "";
    }
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null || value === "" ? "—" : String(value);
  }

  function setStatusBadge(id, status) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = "status-badge " + statusClass(status);
    el.textContent = titleCase(status);
  }

  function formatAmount(currency, amount) {
    if (currency === "BDT") return "৳" + String(amount).replace(/\.00$/, "");
    return currency + " " + amount;
  }

  function displayName(c) {
    var name = c.name || [c.firstName, c.lastName].filter(Boolean).join(" ");
    return name || c.email || "—";
  }

  function sourceLabel(source) {
    if (!source) return "—";
    if (source === "uddoktapay_auto") return "Automatic (UddoktaPay)";
    if (source === "admin_manual") return "Admin manual";
    return titleCase(source);
  }

  function shortId(value) {
    if (!value) return "—";
    var s = String(value);
    return s.length > 12 ? s.slice(0, 8) + "…" : s;
  }

  function makeCell(tr, label, text) {
    var td = document.createElement("td");
    td.setAttribute("data-label", label);
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  function makeBadgeCell(tr, label, status) {
    var td = document.createElement("td");
    td.setAttribute("data-label", label);
    var badge = document.createElement("span");
    badge.className = "status-badge " + statusClass(status);
    badge.textContent = titleCase(status);
    td.appendChild(badge);
    tr.appendChild(td);
    return td;
  }

  function renderOrders(orders) {
    var tbody = document.getElementById("admin-customer-orders-tbody");
    var empty = document.getElementById("admin-customer-orders-empty");
    if (!tbody) return;
    tbody.textContent = "";
    if (!orders || !orders.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    orders.forEach(function (o) {
      var tr = document.createElement("tr");

      var tdOrder = document.createElement("td");
      tdOrder.setAttribute("data-label", "Order");
      var link = document.createElement("a");
      link.href = "/admin/orders/" + o.id;
      link.textContent = o.orderNumber || "—";
      tdOrder.appendChild(link);
      tr.appendChild(tdOrder);

      makeCell(tr, "Product", titleCase(o.productType));
      makeCell(tr, "Plan", o.planName || "—");
      makeCell(tr, "Amount", formatAmount(o.currency, o.amount));
      makeBadgeCell(tr, "Status", o.status);
      if (o.paymentStatus) {
        makeBadgeCell(tr, "Payment", o.paymentStatus);
      } else {
        makeCell(tr, "Payment", "—");
      }
      makeCell(tr, "Created", formatDate(o.createdAt));
      makeCell(tr, "Updated", formatDate(o.updatedAt));

      tbody.appendChild(tr);
    });
  }

  function renderPayments(payments) {
    var tbody = document.getElementById("admin-customer-payments-tbody");
    var empty = document.getElementById("admin-customer-payments-empty");
    if (!tbody) return;
    tbody.textContent = "";
    if (!payments || !payments.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    payments.forEach(function (p) {
      var tr = document.createElement("tr");

      makeCell(tr, "Payment", shortId(p.id));

      var tdOrder = document.createElement("td");
      tdOrder.setAttribute("data-label", "Order");
      var link = document.createElement("a");
      link.href = "/admin/orders/" + p.orderId;
      link.textContent = p.orderNumber || "—";
      tdOrder.appendChild(link);
      tr.appendChild(tdOrder);

      makeCell(tr, "Amount", formatAmount(p.currency, p.amount));
      makeCell(tr, "Provider", p.provider || "—");
      makeCell(tr, "Method", p.paymentMethod || "—");
      makeBadgeCell(tr, "Status", p.status);
      makeCell(tr, "Reference", p.reference || "—");
      makeCell(tr, "Source", sourceLabel(p.verificationSource));
      makeCell(tr, "Created", formatDate(p.createdAt));
      makeCell(tr, "Updated", formatDate(p.updatedAt));

      tbody.appendChild(tr);
    });
  }

  function renderServices(services) {
    var tbody = document.getElementById("admin-customer-services-tbody");
    var empty = document.getElementById("admin-customer-services-empty");
    if (!tbody) return;
    tbody.textContent = "";
    if (!services || !services.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    services.forEach(function (s) {
      var tr = document.createElement("tr");

      makeCell(tr, "Service ID", shortId(s.id));
      makeCell(tr, "Type", titleCase(s.serviceType));
      makeCell(tr, "Plan", s.planName || "—");
      makeBadgeCell(tr, "Status", s.status);
      makeCell(tr, "Created", formatDate(s.createdAt));
      makeCell(tr, "Updated", formatDate(s.updatedAt));

      tbody.appendChild(tr);
    });
  }

  function updatePagination(prefix, p) {
    var prev = document.getElementById("admin-customer-" + prefix + "-prev");
    var next = document.getElementById("admin-customer-" + prefix + "-next");
    var info = document.getElementById(
      "admin-customer-" + prefix + "-page-info"
    );
    if (!p) {
      if (prev) prev.disabled = true;
      if (next) next.disabled = true;
      if (info) info.textContent = "";
      return;
    }
    if (info) {
      info.textContent =
        "Page " + p.page + " of " + p.totalPages + " · " + p.total + " total";
    }
    if (prev) prev.disabled = !p.hasPrev;
    if (next) next.disabled = !p.hasNext;
  }

  async function loadOrders() {
    if (!customerId) return;
    try {
      var params = new URLSearchParams();
      params.set("page", String(ordersState.page));
      params.set("limit", String(PAGE_SIZE));
      var res = await FA.apiRequest(
        "/api/admin/customers/" + customerId + "/orders?" + params.toString(),
        { headers: { Accept: "application/json" } }
      );
      if (FA.redirectIfSignedOut(res.response)) return;
      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to load order history."),
          "error"
        );
        updatePagination("orders", null);
        return;
      }
      var data = res.body.data || {};
      ordersState.page = (data.pagination && data.pagination.page) || 1;
      renderOrders(data.orders || []);
      updatePagination("orders", data.pagination || null);
    } catch (err) {
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
    }
  }

  async function loadPayments() {
    if (!customerId) return;
    try {
      var params = new URLSearchParams();
      params.set("page", String(paymentsState.page));
      params.set("limit", String(PAGE_SIZE));
      var res = await FA.apiRequest(
        "/api/admin/customers/" + customerId + "/payments?" + params.toString(),
        { headers: { Accept: "application/json" } }
      );
      if (FA.redirectIfSignedOut(res.response)) return;
      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to load payment history."),
          "error"
        );
        updatePagination("payments", null);
        return;
      }
      var data = res.body.data || {};
      paymentsState.page = (data.pagination && data.pagination.page) || 1;
      renderPayments(data.payments || []);
      updatePagination("payments", data.pagination || null);
    } catch (err) {
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
    }
  }

  function hideResetPanel() {
    var panel = document.getElementById("reset-password-panel");
    var value = document.getElementById("reset-password-value");
    if (panel) panel.hidden = true;
    if (value) value.textContent = "";
  }

  function showResetPanel(temporaryPassword) {
    var panel = document.getElementById("reset-password-panel");
    var value = document.getElementById("reset-password-value");
    if (value) value.textContent = temporaryPassword || "";
    if (panel) panel.hidden = false;
    if (panel && panel.scrollIntoView) {
      panel.scrollIntoView({ block: "nearest" });
    }
  }

  function renderActions(customer) {
    var suspendBtn = document.getElementById("customer-suspend-action");
    var reactivateBtn = document.getElementById("customer-reactivate-action");
    var resetBtn = document.getElementById("customer-reset-action");
    if (!suspendBtn || !reactivateBtn || !resetBtn) return;

    var isSelf = !!(currentAdmin && customer.id === currentAdmin.id);
    var isCustomer = customer.role !== "admin";

    suspendBtn.hidden = isSelf || customer.status === "suspended";
    reactivateBtn.hidden = customer.status !== "suspended";
    resetBtn.hidden = isSelf || !isCustomer;
  }

  async function runAction(action, confirmMessage) {
    if (actionBusy) return null;
    if (!window.confirm(confirmMessage)) return null;
    actionBusy = true;
    try {
      var res = await FA.apiRequest(
        "/api/admin/customers/" + customerId + "/" + action,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: "{}",
        }
      );
      if (FA.redirectIfSignedOut(res.response)) return null;
      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to complete the action."),
          "error"
        );
        return null;
      }
      return res.body.data || {};
    } catch (err) {
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
      return null;
    } finally {
      actionBusy = false;
    }
  }

  function initActions() {
    var suspendBtn = document.getElementById("customer-suspend-action");
    var reactivateBtn = document.getElementById("customer-reactivate-action");
    var resetBtn = document.getElementById("customer-reset-action");
    var dismissBtn = document.getElementById("reset-password-dismiss");

    if (dismissBtn && !dismissBtn.dataset.bound) {
      dismissBtn.dataset.bound = "1";
      dismissBtn.addEventListener("click", function () {
        hideResetPanel();
      });
    }

    if (suspendBtn && !suspendBtn.dataset.bound) {
      suspendBtn.dataset.bound = "1";
      suspendBtn.addEventListener("click", async function () {
        if (!currentCustomer) return;
        var email = currentCustomer.email || "this customer";
        var data = await runAction(
          "suspend",
          "Suspend " +
            email +
            "? They will be prevented from accessing their account and every active session will be revoked."
        );
        if (!data) return;
        hideResetPanel();
        await load();
        FA.setStatus(
          statusEl,
          "Customer suspended. " +
            (data.sessionsRevoked || 0) +
            " active session(s) revoked.",
          "success"
        );
      });
    }

    if (reactivateBtn && !reactivateBtn.dataset.bound) {
      reactivateBtn.dataset.bound = "1";
      reactivateBtn.addEventListener("click", async function () {
        if (!currentCustomer) return;
        var email = currentCustomer.email || "this customer";
        var data = await runAction(
          "reactivate",
          "Reactivate " +
            email +
            "? They will be able to sign in again with their existing password."
        );
        if (!data) return;
        hideResetPanel();
        await load();
        FA.setStatus(statusEl, "Customer reactivated.", "success");
      });
    }

    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = "1";
      resetBtn.addEventListener("click", async function () {
        if (!currentCustomer) return;
        var email = currentCustomer.email || "this customer";
        var data = await runAction(
          "reset-password",
          "Generate a one-time temporary password for " +
            email +
            "? Every active session will be signed out and the password will be shown once."
        );
        if (!data) return;
        showResetPanel(data.temporaryPassword);
        FA.setStatus(
          statusEl,
          "Temporary password generated. Deliver it securely — it will not be shown again.",
          "success"
        );
      });
    }
  }

  async function load() {
    if (!customerId) {
      FA.setStatus(statusEl, "Invalid customer id.", "error");
      return;
    }

    try {
      var res = await FA.apiRequest("/api/admin/customers/" + customerId, {
        headers: { Accept: "application/json" },
      });

      if (FA.redirectIfSignedOut(res.response)) return;

      if (res.response.status === 404) {
        FA.setStatus(statusEl, "Customer not found.", "error");
        return;
      }
      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to load customer."),
          "error"
        );
        return;
      }

      var data = res.body.data || {};
      var customer = data.customer || {};
      var summary = data.summary || {};
      currentCustomer = customer;

      if (titleEl) {
        titleEl.textContent = displayName(customer);
      }
      document.title =
        displayName(customer) + " — Admin — ARC HOST";

      setText("detail-customer-name", displayName(customer));
      setText("detail-customer-email", customer.email);
      setText("detail-customer-id", customer.id);
      setText("detail-customer-status", titleCase(customer.status));
      setStatusBadge("detail-customer-status-badge", customer.status);
      setText("detail-customer-role", titleCase(customer.role));
      setText("detail-customer-created", formatDate(customer.createdAt));
      setText("detail-customer-updated", formatDate(customer.updatedAt));

      setText("detail-summary-orders", summary.orders);
      setText("detail-summary-paid", summary.paidOrders);
      setText("detail-summary-services", summary.services);

      var ordersLink = document.getElementById("admin-customer-orders-link");
      if (ordersLink) {
        if (customer.email) {
          ordersLink.href =
            "/admin/orders?search=" + encodeURIComponent(customer.email);
        } else {
          ordersLink.hidden = true;
        }
      }
      var paymentsLink = document.getElementById(
        "admin-customer-payments-link"
      );
      if (paymentsLink) {
        paymentsLink.href = customer.email
          ? "/admin/payments?customer=" + encodeURIComponent(customer.email)
          : "/admin/payments";
      }

      renderActions(customer);
      renderServices(data.services || []);
      await Promise.all([loadOrders(), loadPayments()]);
      FA.clearMessage(statusEl);
      root.hidden = false;
    } catch (err) {
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
    }
  }

  function bindPagination() {
    var ordersPrev = document.getElementById("admin-customer-orders-prev");
    var ordersNext = document.getElementById("admin-customer-orders-next");
    var payPrev = document.getElementById("admin-customer-payments-prev");
    var payNext = document.getElementById("admin-customer-payments-next");

    if (ordersPrev) {
      ordersPrev.addEventListener("click", function () {
        if (ordersState.page > 1) {
          ordersState.page -= 1;
          loadOrders();
        }
      });
    }
    if (ordersNext) {
      ordersNext.addEventListener("click", function () {
        ordersState.page += 1;
        loadOrders();
      });
    }
    if (payPrev) {
      payPrev.addEventListener("click", function () {
        if (paymentsState.page > 1) {
          paymentsState.page -= 1;
          loadPayments();
        }
      });
    }
    if (payNext) {
      payNext.addEventListener("click", function () {
        paymentsState.page += 1;
        loadPayments();
      });
    }
  }

  (async function initCustomerDetail() {
    var admin = await FA.ensureAdminOrLogin();
    if (!admin) return;
    currentAdmin = admin;
    FA.initShell(admin);
    initActions();
    bindPagination();
    await load();
  })();
})();
