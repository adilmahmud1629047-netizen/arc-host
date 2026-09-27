(function () {
  "use strict";

  var FA = window.FlareAdmin;
  if (!FA) return;

  var root = document.getElementById("admin-payments-root");
  if (!root) return;

  var statusEl = document.getElementById("admin-payments-status");
  var tbody = document.getElementById("admin-payments-tbody");
  var emptyEl = document.getElementById("admin-payments-empty");
  var loadingEl = document.getElementById("admin-payments-loading");
  var summaryEl = document.getElementById("admin-payments-summary");
  var prevBtn = document.getElementById("admin-payments-prev");
  var nextBtn = document.getElementById("admin-payments-next");
  var pageInfo = document.getElementById("admin-payments-page-info");

  var filterStatus = document.getElementById("filter-status");
  var filterProvider = document.getElementById("filter-provider");
  var filterOrder = document.getElementById("filter-order");
  var filterCustomer = document.getElementById("filter-customer");
  var filterTransaction = document.getElementById("filter-transaction");
  var filterForm = document.getElementById("admin-payments-filters");
  var resetBtn = document.getElementById("admin-payments-reset");

  var detailSection = document.getElementById("admin-payments-detail");
  var detailTitle = document.getElementById("admin-payments-detail-title");
  var detailStatus = document.getElementById("admin-payments-detail-status");
  var detailFields = document.getElementById("admin-payments-detail-fields");
  var detailActions = document.getElementById("admin-payments-detail-actions");
  var detailClose = document.getElementById("admin-payments-detail-close");

  var manualForm = document.getElementById("admin-manual-verify-form");
  var manualTransaction = document.getElementById("manual-verify-transaction");
  var manualAmount = document.getElementById("manual-verify-amount");
  var manualCurrency = document.getElementById("manual-verify-currency");
  var manualNote = document.getElementById("manual-verify-note");
  var manualSubmit = document.getElementById("manual-verify-submit");
  var manualCancel = document.getElementById("manual-verify-cancel");

  var state = {
    page: 1,
    limit: 20,
    status: "",
    provider: "all",
    order: "",
    customer: "",
    transaction: "",
    detailId: null,
  };

  var STATUS_LABELS = {
    awaiting_verification: "Awaiting verification",
    verified: "Verified",
    rejected: "Rejected",
    initiated: "Initiated",
    pending: "Pending",
    successful: "Successful",
    failed: "Failed",
    cancelled: "Cancelled",
    expired: "Expired",
    refunded: "Refunded",
  };

  var PROVIDER_LABELS = {
    all: "All providers",
    manual: "Manual (Transaction ID)",
    uddoktapay: "UddoktaPay",
    sslcommerz: "SSLCommerz",
    disabled: "Disabled / legacy",
  };

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
      case "verified":
      case "successful":
        return "is-success";
      case "awaiting_verification":
      case "pending":
        return "is-warning";
      case "rejected":
      case "failed":
      case "cancelled":
      case "expired":
        return "is-danger";
      default:
        return "";
    }
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || titleCase(status) || "—";
  }

  function providerLabel(provider) {
    return PROVIDER_LABELS[provider] || titleCase(provider) || "—";
  }

  function provenanceLabel(source) {
    if (source === "uddoktapay_auto") return "UddoktaPay automatic";
    if (source === "admin_manual") return "Admin manual verification";
    if (!source) return "—";
    return titleCase(source);
  }

  function formatAmount(payment) {
    var code = payment.currency || "";
    var amt = payment.amount || "";
    if (code === "BDT") return "৳" + String(amt).replace(/\.00$/, "");
    if (!code) return String(amt || "—");
    return code + " " + amt;
  }

  function hasFilters() {
    return Boolean(
      state.status ||
        (state.provider && state.provider !== "all") ||
        state.order ||
        state.customer ||
        state.transaction
    );
  }

  function buildQuery() {
    var params = new URLSearchParams();
    params.set("page", String(state.page));
    params.set("limit", String(state.limit));
    // Always sent so the server opens the extended (all-provider) view.
    params.set("provider", state.provider || "all");
    if (state.status) params.set("status", state.status);
    if (state.order) params.set("order", state.order);
    if (state.customer) params.set("customer", state.customer);
    if (state.transaction) params.set("transaction", state.transaction);
    return params.toString();
  }

  function syncUrl() {
    var qs = buildQuery();
    var path = "/admin/payments" + (qs ? "?" + qs : "");
    if (window.location.search !== (qs ? "?" + qs : "")) {
      window.history.replaceState(null, "", path);
    }
  }

  function setFilterInputs() {
    if (filterStatus) filterStatus.value = state.status;
    if (filterProvider) filterProvider.value = state.provider || "all";
    if (filterOrder) filterOrder.value = state.order;
    if (filterCustomer) filterCustomer.value = state.customer;
    if (filterTransaction) filterTransaction.value = state.transaction;
  }

  function readUrl() {
    var params = new URLSearchParams(window.location.search);
    var page = parseInt(params.get("page") || "1", 10);
    state.page = page > 0 ? page : 1;
    var limit = parseInt(params.get("limit") || "20", 10);
    state.limit = limit > 0 && limit <= 50 ? limit : 20;
    state.status = params.get("status") || "";
    var provider = params.get("provider");
    state.provider = provider ? provider : "all";
    state.order = params.get("order") || "";
    state.customer = params.get("customer") || "";
    state.transaction = params.get("transaction") || "";
    setFilterInputs();
  }

  function actionButton(label, paymentId) {
    var btn = document.createElement("button");
    btn.className = "btn btn-outline btn-sm";
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("data-payment-id", paymentId);
    return btn;
  }

  function appendField(list, label, value) {
    var wrap = document.createElement("div");
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    if (value === null || value === undefined || value === "") {
      dd.textContent = "—";
    } else {
      dd.textContent = String(value);
    }
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    list.appendChild(wrap);
    return dd;
  }

  function detailVisible() {
    return Boolean(detailSection && !detailSection.hidden);
  }

  function setDetailMessage(message, kind) {
    if (!detailStatus) return;
    FA.setStatus(detailStatus, message || "", kind || "status");
    if (!message) FA.clearMessage(detailStatus);
  }

  function clearDetail() {
    if (detailFields) detailFields.textContent = "";
    if (detailActions) detailActions.textContent = "";
    if (detailTitle) detailTitle.textContent = "Payment details";
    setDetailMessage("", null);
    hideManualForm();
  }

  function closeDetail() {
    state.detailId = null;
    if (detailSection) detailSection.hidden = true;
    clearDetail();
  }

  function hideManualForm() {
    if (!manualForm) return;
    manualForm.hidden = true;
    manualForm.removeAttribute("data-payment-id");
    if (manualTransaction) manualTransaction.value = "";
    if (manualAmount) manualAmount.value = "";
    if (manualCurrency) manualCurrency.value = "";
    if (manualNote) manualNote.value = "";
    if (manualSubmit) {
      manualSubmit.disabled = false;
      manualSubmit.textContent = "Confirm manual verification";
    }
  }

  function showManualForm(payment) {
    if (!manualForm || !payment) return;
    manualForm.setAttribute("data-payment-id", payment.id);
    if (manualTransaction) {
      manualTransaction.value =
        payment.transactionId || payment.gatewayReference || "";
    }
    if (manualAmount) manualAmount.value = String(payment.amount || "");
    if (manualCurrency) manualCurrency.value = payment.currency || "";
    if (manualNote) manualNote.value = "";
    manualForm.hidden = false;
    if (manualSubmit) {
      manualSubmit.disabled = false;
      manualSubmit.textContent = "Confirm manual verification";
    }
    if (manualTransaction) manualTransaction.focus();
  }

  // Row cell builder: order link stays, every payment gets a Details button,
  // and each quick action the API marks available is one click away.
  function appendRowActions(tdAction, payment) {
    var actions = payment.availableActions || [];
    var canQuickReview =
      actions.indexOf("verify") !== -1 || actions.indexOf("reject") !== -1;
    var canGateway = actions.indexOf("verify-uddoktapay") !== -1;
    var canManual = actions.indexOf("manual-verify") !== -1;

    if (canQuickReview && actions.indexOf("verify") !== -1) {
      var verify = actionButton("Verify", payment.id);
      verify.className = "btn btn-primary btn-sm";
      verify.setAttribute("data-action", "verify");
      verify.addEventListener("click", function () {
        reviewPayment(payment.id, "verify", verify, statusEl);
      });
      tdAction.appendChild(verify);
    }
    if (canQuickReview && actions.indexOf("reject") !== -1) {
      var reject = actionButton("Reject", payment.id);
      reject.setAttribute("data-action", "reject");
      reject.addEventListener("click", function () {
        reviewPayment(payment.id, "reject", reject, statusEl);
      });
      tdAction.appendChild(reject);
    }
    if (canGateway) {
      var gateway = actionButton("Verify with UddoktaPay", payment.id);
      gateway.className = "btn btn-primary btn-sm";
      gateway.setAttribute("data-action", "verify-uddoktapay");
      gateway.addEventListener("click", function () {
        gatewayVerify(payment.id, gateway, statusEl);
      });
      tdAction.appendChild(gateway);
    }
    if (canManual) {
      var manual = actionButton("Manual Verification", payment.id);
      // The server marks both actions available for an open gateway attempt;
      // gateway verification stays primary and manual is the visible fallback
      // when it fails (no invoice, gateway down, mismatch).
      manual.className = canGateway
        ? "btn btn-outline btn-sm"
        : "btn btn-primary btn-sm";
      manual.setAttribute("data-action", "manual-verify");
      manual.addEventListener("click", function () {
        openDetail(payment.id, payment, true);
      });
      tdAction.appendChild(manual);
    }

    var details = actionButton("Details", payment.id);
    details.setAttribute("data-action", "details");
    details.addEventListener("click", function () {
      openDetail(payment.id, payment);
    });
    tdAction.appendChild(details);
  }

  function appendRow(payment) {
    if (!tbody) return;
    var tr = document.createElement("tr");
    tr.className = "admin-payments-row";

    var tdOrder = document.createElement("td");
    tdOrder.setAttribute("data-label", "Order");
    var link = document.createElement("a");
    link.href = "/admin/orders/" + payment.orderId;
    link.textContent = payment.orderNumber || "—";
    tdOrder.appendChild(link);
    tr.appendChild(tdOrder);

    var tdPayment = document.createElement("td");
    tdPayment.setAttribute("data-label", "Payment");
    tdPayment.textContent = payment.id;
    tr.appendChild(tdPayment);

    var tdCustomer = document.createElement("td");
    tdCustomer.setAttribute("data-label", "Customer");
    tdCustomer.textContent =
      (payment.customer && payment.customer.email) || "—";
    tr.appendChild(tdCustomer);

    var tdProvider = document.createElement("td");
    tdProvider.setAttribute("data-label", "Provider");
    tdProvider.textContent = providerLabel(payment.provider);
    tr.appendChild(tdProvider);

    var tdMethod = document.createElement("td");
    tdMethod.setAttribute("data-label", "Method");
    tdMethod.textContent = payment.paymentMethod || "—";
    tr.appendChild(tdMethod);

    var tdReference = document.createElement("td");
    tdReference.setAttribute("data-label", "Reference");
    tdReference.textContent = payment.reference || "—";
    tr.appendChild(tdReference);

    var tdAmount = document.createElement("td");
    tdAmount.setAttribute("data-label", "Amount");
    tdAmount.textContent = formatAmount(payment);
    tr.appendChild(tdAmount);

    var tdStatus = document.createElement("td");
    tdStatus.setAttribute("data-label", "Status");
    var badge = document.createElement("span");
    badge.className = "status-badge " + statusClass(payment.status);
    badge.textContent = statusLabel(payment.status);
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    var tdUpdated = document.createElement("td");
    tdUpdated.setAttribute("data-label", "Updated");
    tdUpdated.textContent = formatDate(payment.updatedAt);
    tr.appendChild(tdUpdated);

    var tdAction = document.createElement("td");
    tdAction.setAttribute("data-label", "Action");
    appendRowActions(tdAction, payment);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  }

  // GET /api/admin/payments/:id and render the full detail panel. A plain
  // payment row payload (list shape) can seed the panel instantly while the
  // authoritative detail is fetched. manualPrompt opens the manual
  // verification form once the authoritative payload arrives (row action
  // "Manual Verification"); it only shows when the payment is eligible.
  async function openDetail(paymentId, seed, manualPrompt) {
    if (!detailSection) return;
    state.detailId = paymentId;
    if (detailSection.hidden) {
      detailSection.hidden = false;
    }
    clearDetail();
    if (seed) renderDetail(seed, null);
    setDetailMessage("Loading payment…", null);
    if (detailSection.scrollIntoView) {
      detailSection.scrollIntoView({ block: "nearest" });
    }

    try {
      var res = await FA.apiRequest(
        "/api/admin/payments/" + encodeURIComponent(paymentId),
        { headers: { Accept: "application/json" } }
      );
      if (FA.redirectIfSignedOut(res.response)) return;
      if (state.detailId !== paymentId) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        setDetailMessage(
          FA.errorFromResponse(res.body, "Unable to load this payment."),
          "error"
        );
        return;
      }

      var payment = (res.body.data && res.body.data.id && res.body.data) || null;
      if (!payment) {
        setDetailMessage("Unable to load this payment.", "error");
        return;
      }
      setDetailMessage("", null);
      renderDetail(payment, seed || null);
      if (
        manualPrompt &&
        payment.availableActions &&
        payment.availableActions.indexOf("manual-verify") !== -1
      ) {
        showManualForm(payment);
      }
    } catch (err) {
      if (state.detailId !== paymentId) return;
      setDetailMessage("Unable to reach the server.", "error");
    }
  }

  function renderDetail(payment, seedFallback) {
    if (detailTitle) {
      detailTitle.textContent =
        "Payment · " + (payment.orderNumber || payment.id);
    }

    if (detailFields) {
      detailFields.textContent = "";

      var ddOrder = appendField(detailFields, "Order number", payment.orderNumber);
      if (payment.orderId) {
        var orderLink = document.createElement("a");
        orderLink.href = "/admin/orders/" + payment.orderId;
        orderLink.textContent = "View order";
        var orderWrap = document.createElement("div");
        var orderDt = document.createElement("dt");
        orderDt.textContent = "Order";
        var orderDd = document.createElement("dd");
        orderDd.appendChild(orderLink);
        orderWrap.appendChild(orderDt);
        orderWrap.appendChild(orderDd);
        detailFields.appendChild(orderWrap);
      }
      appendField(
        detailFields,
        "Order status",
        payment.order ? payment.order.status : null
      );
      appendField(detailFields, "Order amount",
        payment.order && payment.order.amount
          ? formatAmount({ amount: payment.order.amount, currency: payment.order.currency })
          : null
      );
      appendField(detailFields, "Payment id", payment.id);
      appendField(
        detailFields,
        "Customer",
        payment.customer && payment.customer.email
          ? payment.customer.email + " · " + payment.customer.id
          : null
      );
      appendField(detailFields, "Provider", providerLabel(payment.provider));
      appendField(detailFields, "Payment method", payment.paymentMethod);

      var statusValue =
        payment.status || (seedFallback && seedFallback.status) || null;
      var statusDd = appendField(detailFields, "Payment status", statusLabel(statusValue));
      if (statusValue && statusDd) {
        statusDd.textContent = statusLabel(statusValue);
      }

      var reference =
        payment.transactionId ||
        payment.manualReference ||
        payment.gatewayReference ||
        (seedFallback && seedFallback.reference) ||
        null;
      appendField(detailFields, "Reference", reference);
      appendField(detailFields, "Amount", formatAmount(payment));
      appendField(detailFields, "Currency", payment.currency);
      appendField(detailFields, "Initiated", formatDate(payment.initiatedAt));
      appendField(detailFields, "Created", formatDate(payment.createdAt));
      appendField(detailFields, "Updated", formatDate(payment.updatedAt));
      appendField(detailFields, "Paid", formatDate(payment.paidAt));

      var provenance = payment.provenance || null;
      if (provenance) {
        appendField(
          detailFields,
          "Verification source",
          provenance.source ? provenanceLabel(provenance.source) : null
        );
        appendField(detailFields, "Verified by", provenance.verifiedBy);
        appendField(detailFields, "Verified at", formatDate(provenance.verifiedAt));
        appendField(detailFields, "Verification note", provenance.note);
        appendField(detailFields, "Rejected by", provenance.rejectedBy);
        appendField(detailFields, "Rejected at", formatDate(provenance.rejectedAt));
        appendField(detailFields, "Rejection reason", provenance.rejectionReason);
      }
    }

    if (detailActions) renderDetailActions(payment);
  }

  function renderDetailActions(payment) {
    detailActions.textContent = "";
    var actions = payment.availableActions || [];

    if (actions.indexOf("verify") !== -1) {
      var verify = actionButton("Verify", payment.id);
      verify.className = "btn btn-primary btn-sm";
      verify.setAttribute("data-action", "verify");
      verify.addEventListener("click", function () {
        reviewPayment(payment.id, "verify", verify, detailStatus);
      });
      detailActions.appendChild(verify);
    }
    if (actions.indexOf("reject") !== -1) {
      var reject = actionButton("Reject", payment.id);
      reject.setAttribute("data-action", "reject");
      reject.addEventListener("click", function () {
        reviewPayment(payment.id, "reject", reject, detailStatus);
      });
      detailActions.appendChild(reject);
    }
    if (actions.indexOf("verify-uddoktapay") !== -1) {
      var gateway = actionButton("Verify with UddoktaPay", payment.id);
      gateway.className = "btn btn-primary btn-sm";
      gateway.setAttribute("data-action", "verify-uddoktapay");
      gateway.addEventListener("click", function () {
        gatewayVerify(payment.id, gateway, detailStatus);
      });
      detailActions.appendChild(gateway);
    }
    if (actions.indexOf("manual-verify") !== -1) {
      var manual = actionButton("Manual Verification", payment.id);
      manual.setAttribute("data-action", "manual-verify");
      manual.addEventListener("click", function () {
        showManualForm(payment);
      });
      detailActions.appendChild(manual);
    }

    if (payment.orderId) {
      var orderLink = document.createElement("a");
      orderLink.className = "btn btn-outline btn-sm";
      orderLink.href = "/admin/orders/" + payment.orderId;
      orderLink.textContent = "View order";
      detailActions.appendChild(orderLink);
    }
  }

  function messageTarget(targetEl) {
    return targetEl && targetEl !== statusEl ? targetEl : statusEl;
  }

  async function refreshAfterAction(paymentId) {
    await load();
    if (state.detailId && state.detailId === paymentId) {
      await openDetail(paymentId, null);
    }
  }

  // Server-side review: the API marks the order paid (verify) or the payment
  // rejected — this button never changes any state on its own.
  async function reviewPayment(paymentId, action, btn, targetEl) {
    if (!btn || btn.disabled) return;
    var originalLabel = btn.textContent;
    var sink = messageTarget(targetEl);
    btn.disabled = true;
    btn.textContent = action === "verify" ? "Verifying…" : "Rejecting…";
    FA.clearMessage(statusEl);
    if (sink !== statusEl) FA.clearMessage(sink);

    try {
      var res = await FA.apiRequest(
        "/api/admin/payments/" + encodeURIComponent(paymentId) + "/" + action,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({}),
        }
      );

      if (FA.redirectIfSignedOut(res.response)) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          sink,
          FA.errorFromResponse(
            res.body,
            action === "verify"
              ? "Unable to verify this payment."
              : "Unable to reject this payment."
          ),
          "error"
        );
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }

      // The confirmation is written AFTER the refresh: reloading the list and
      // reopening the detail panel clears this message node, so a status set
      // first would never be seen by the admin.
      await refreshAfterAction(paymentId);
      FA.setStatus(
        sink,
        action === "verify"
          ? "Payment verified — the order is now marked paid."
          : "Payment rejected — the customer can submit a new Transaction ID.",
        "success"
      );
    } catch (err) {
      FA.setStatus(sink, "Unable to reach the server.", "error");
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // Automatic verification: no request data at all — the server reloads the
  // row and asks the gateway itself. Payment and order state come from that
  // reply only.
  async function gatewayVerify(paymentId, btn, targetEl) {
    if (!btn || btn.disabled) return;
    var originalLabel = btn.textContent;
    var sink = messageTarget(targetEl);
    btn.disabled = true;
    btn.textContent = "Verifying with gateway…";
    FA.clearMessage(statusEl);
    if (sink !== statusEl) FA.clearMessage(sink);

    try {
      var res = await FA.apiRequest(
        "/api/admin/payments/" + encodeURIComponent(paymentId) + "/verify-uddoktapay",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({}),
        }
      );

      if (FA.redirectIfSignedOut(res.response)) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          sink,
          FA.errorFromResponse(res.body, "Unable to verify with UddoktaPay."),
          "error"
        );
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }

      // Written after the refresh — see the note in reviewPayment().
      await refreshAfterAction(paymentId);
      FA.setStatus(
        sink,
        "Payment verified against UddoktaPay — the order is now marked paid.",
        "success"
      );
    } catch (err) {
      FA.setStatus(sink, "Unable to reach the server.", "error");
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // Manual fallback for a stuck gateway attempt: the admin supplies the exact
  // amount and the reference; the server re-checks both before it can settle.
  async function manualVerify(paymentId, btn) {
    if (btn.disabled) return;
    var trx = manualTransaction ? manualTransaction.value.trim() : "";
    var amt = manualAmount ? manualAmount.value.trim() : "";
    var currency = manualCurrency ? manualCurrency.value.trim() : "";
    var note = manualNote ? manualNote.value.trim() : "";

    if (!trx) {
      setDetailMessage("Enter the transaction or reference ID.", "error");
      if (manualTransaction) manualTransaction.focus();
      return;
    }
    if (!amt) {
      setDetailMessage("Enter the exact amount.", "error");
      if (manualAmount) manualAmount.focus();
      return;
    }

    var originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Verifying…";
    FA.clearMessage(statusEl);
    setDetailMessage("", null);

    var payload = { transactionId: trx, amount: amt };
    if (currency) payload.currency = currency;
    if (note) payload.note = note;

    try {
      var res = await FA.apiRequest(
        "/api/admin/payments/" + encodeURIComponent(paymentId) + "/manual-verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (FA.redirectIfSignedOut(res.response)) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        setDetailMessage(
          FA.errorFromResponse(res.body, "Unable to verify this payment."),
          "error"
        );
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }

      hideManualForm();
      // Written after the refresh — see the note in reviewPayment().
      await refreshAfterAction(paymentId);
      setDetailMessage(
        "Payment verified — the order is now marked paid.",
        "success"
      );
    } catch (err) {
      setDetailMessage("Unable to reach the server.", "error");
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  function emptyMessage(p) {
    var total = p.total || 0;
    if (hasFilters()) {
      return "No payments match the current filter.";
    }
    if (total > 0 && state.page > 1) {
      return (
        "No payments on page " +
        state.page +
        " of " +
        p.totalPages +
        ". Use Previous to go back."
      );
    }
    return "No payments yet.";
  }

  async function load() {
    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    if (tbody) tbody.textContent = "";
    FA.clearMessage(statusEl);

    try {
      var res = await FA.apiRequest("/api/admin/payments?" + buildQuery(), {
        headers: { Accept: "application/json" },
      });
      if (loadingEl) loadingEl.hidden = true;

      if (FA.redirectIfSignedOut(res.response)) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to load payments."),
          "error"
        );
        updatePagination(null);
        return;
      }

      var data = res.body.data || {};
      var payments = data.payments || [];
      var p = data.pagination || {};

      if (summaryEl) {
        var summary = (p.total || 0) + " payment" + (p.total === 1 ? "" : "s");
        if (state.provider && state.provider !== "all") {
          summary += " · " + providerLabel(state.provider);
        }
        if (state.status) summary += " · " + statusLabel(state.status);
        if (state.order || state.customer || state.transaction) {
          summary += " · filtered";
        }
        summaryEl.textContent = summary;
      }

      if (!payments.length) {
        if (emptyEl) {
          emptyEl.hidden = false;
          emptyEl.textContent = emptyMessage(p);
        }
      } else {
        payments.forEach(appendRow);
      }

      updatePagination(p);
      syncUrl();
    } catch (err) {
      if (loadingEl) loadingEl.hidden = true;
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
    }
  }

  function updatePagination(p) {
    if (!p) {
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (pageInfo) pageInfo.textContent = "";
      return;
    }
    if (pageInfo) {
      pageInfo.textContent =
        "Page " + p.page + " of " + p.totalPages + " · " + p.total + " total";
    }
    if (prevBtn) prevBtn.disabled = !p.hasPrev;
    if (nextBtn) nextBtn.disabled = !p.hasNext;
  }

  function readFiltersFromInputs() {
    state.status = filterStatus ? filterStatus.value : "";
    state.provider = filterProvider ? filterProvider.value : "all";
    state.order = filterOrder ? filterOrder.value.trim().slice(0, 100) : "";
    state.customer = filterCustomer
      ? filterCustomer.value.trim().slice(0, 100)
      : "";
    state.transaction = filterTransaction
      ? filterTransaction.value.trim().slice(0, 100)
      : "";
    state.page = 1;
  }

  if (filterForm) {
    filterForm.addEventListener("submit", function (event) {
      event.preventDefault();
      readFiltersFromInputs();
      load();
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", function () {
      if (state.page > 1) {
        state.page -= 1;
        load();
      }
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", function () {
      state.page += 1;
      load();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      state.status = "";
      state.provider = "all";
      state.order = "";
      state.customer = "";
      state.transaction = "";
      state.page = 1;
      setFilterInputs();
      load();
    });
  }

  if (detailClose) {
    detailClose.addEventListener("click", function () {
      closeDetail();
    });
  }

  if (manualCancel) {
    manualCancel.addEventListener("click", function () {
      hideManualForm();
      setDetailMessage("", null);
    });
  }

  if (manualForm) {
    manualForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var paymentId = manualForm.getAttribute("data-payment-id");
      if (!paymentId || !manualSubmit) return;
      manualVerify(paymentId, manualSubmit);
    });
  }

  (async function initPayments() {
    var admin = await FA.ensureAdminOrLogin();
    if (!admin) return;
    FA.initShell(admin);
    readUrl();
    await load();
  })();
})();
