(function () {
  "use strict";

  var FA = window.FlareAdmin;
  if (!FA) return;

  var root = document.getElementById("admin-order-detail-root");
  if (!root) return;

  var statusEl = document.getElementById("admin-order-status");
  var titleEl = document.getElementById("admin-order-title");

  function orderIdFromPath() {
    var m = window.location.pathname.match(
      /^\/admin\/orders\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    );
    return m ? m[1] : null;
  }

  function titleCase(value) {
    if (!value) return "—";
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function verificationSourceLabel(source) {
    if (!source) return "—";
    if (source === "uddoktapay_auto") return "Automatic (UddoktaPay)";
    if (source === "admin_manual") return "Admin manual";
    return titleCase(source);
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

  function renderPayments(payments) {
    var tbody = document.getElementById("admin-payments-tbody");
    var empty = document.getElementById("admin-payments-empty");
    if (!tbody) return;
    tbody.textContent = "";
    if (!payments || !payments.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    payments.forEach(function (p) {
      var tr = document.createElement("tr");

      var tdProvider = document.createElement("td");
      tdProvider.setAttribute("data-label", "Provider");
      tdProvider.textContent = p.provider || "—";
      tr.appendChild(tdProvider);

      var tdTx = document.createElement("td");
      tdTx.setAttribute("data-label", "Transaction");
      tdTx.textContent = p.providerTransactionId || "—";
      tr.appendChild(tdTx);

      var tdSource = document.createElement("td");
      tdSource.setAttribute("data-label", "Source");
      tdSource.textContent = verificationSourceLabel(p.verificationSource);
      tr.appendChild(tdSource);

      var tdStatus = document.createElement("td");
      tdStatus.setAttribute("data-label", "Status");
      var badge = document.createElement("span");
      badge.className = "status-badge " + statusClass(p.status);
      badge.textContent = titleCase(p.status);
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      var tdAmount = document.createElement("td");
      tdAmount.setAttribute("data-label", "Amount");
      tdAmount.textContent = formatAmount(p.currency, p.amount);
      tr.appendChild(tdAmount);

      var tdMethod = document.createElement("td");
      tdMethod.setAttribute("data-label", "Method");
      tdMethod.textContent = p.paymentMethod || "—";
      tr.appendChild(tdMethod);

      var tdCreated = document.createElement("td");
      tdCreated.setAttribute("data-label", "Created");
      tdCreated.textContent = formatDate(p.createdAt);
      tr.appendChild(tdCreated);

      var tdUpdated = document.createElement("td");
      tdUpdated.setAttribute("data-label", "Updated");
      tdUpdated.textContent = formatDate(p.updatedAt);
      tr.appendChild(tdUpdated);

      tbody.appendChild(tr);
    });
  }

  async function load() {
    var id = orderIdFromPath();
    if (!id) {
      FA.setStatus(statusEl, "Invalid order id.", "error");
      return;
    }

    try {
      var res = await FA.apiRequest("/api/admin/orders/" + id, {
        headers: { Accept: "application/json" },
      });

      if (FA.redirectIfSignedOut(res.response)) return;

      if (res.response.status === 404) {
        FA.setStatus(statusEl, "Order not found.", "error");
        return;
      }
      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to load order."),
          "error"
        );
        return;
      }

      var data = res.body.data || {};
      var order = data.order || {};
      var customer = data.customer || {};
      var service = data.service;

      if (titleEl) {
        titleEl.textContent = order.orderNumber || "Order";
      }
      document.title = (order.orderNumber || "Order") + " — Admin — ARC HOST";

      setText("detail-order-number", order.orderNumber);
      setStatusBadge("detail-order-status", order.status);
      setText("detail-order-created", formatDate(order.createdAt));
      setText("detail-order-updated", formatDate(order.updatedAt));
      setText("detail-order-type", titleCase(order.productType));
      setText(
        "detail-order-cycle",
        order.billingCycle ? titleCase(order.billingCycle) : null
      );

      var plan = order.plan || {};
      setText("detail-plan-name", plan.name);
      setText("detail-plan-slug", plan.slug);
      setText("detail-plan-id", plan.id);

      setText(
        "detail-amount",
        formatAmount(order.currency, order.amount)
      );
      setText("detail-currency", order.currency);

      var name = [customer.firstName, customer.lastName]
        .filter(Boolean)
        .join(" ");
      setText("detail-customer-name", name || customer.email);
      var emailEl = document.getElementById("detail-customer-email");
      if (emailEl) {
        emailEl.textContent = customer.email || "—";
        emailEl.href = customer.id
          ? "/admin/customers/" + customer.id
          : "/admin/customers";
      }
      setText("detail-customer-id", customer.id);
      setText("detail-customer-status", titleCase(customer.status));

      if (service) {
        setText("detail-service-type", titleCase(service.serviceType));
        setStatusBadge("detail-service-status", service.status);
        setText("detail-service-hostname", service.hostname);
        setText("detail-service-created", formatDate(service.createdAt));
      } else {
        setText("detail-service-type", "Not available");
        setText("detail-service-status", "—");
        setText("detail-service-hostname", "—");
        setText("detail-service-created", "—");
        var badge = document.getElementById("detail-service-status");
        if (badge) {
          badge.className = "status-badge is-muted";
          badge.textContent = "No record";
        }
      }

      renderPayments(data.payments || []);
      FA.clearMessage(statusEl);
      root.hidden = false;
    } catch (err) {
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
    }
  }

  (async function initDetail() {
    var admin = await FA.ensureAdminOrLogin();
    if (!admin) return;
    FA.initShell(admin);
    await load();
  })();
})();
