(function () {
  "use strict";

  var FA = window.FlareAdmin;
  if (!FA) return;

  var root = document.getElementById("admin-orders-root");
  if (!root) return;

  var statusEl = document.getElementById("admin-orders-status");
  var tbody = document.getElementById("admin-orders-tbody");
  var emptyEl = document.getElementById("admin-orders-empty");
  var loadingEl = document.getElementById("admin-orders-loading");
  var summaryEl = document.getElementById("admin-orders-summary");
  var prevBtn = document.getElementById("admin-orders-prev");
  var nextBtn = document.getElementById("admin-orders-next");
  var pageInfo = document.getElementById("admin-orders-page-info");

  var filterStatus = document.getElementById("filter-status");
  var filterProduct = document.getElementById("filter-product");
  var filterSearch = document.getElementById("filter-search");
  var filterForm = document.getElementById("admin-orders-filters");

  var state = {
    page: 1,
    limit: 20,
    status: "",
    productType: "",
    search: "",
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
      case "paid":
      case "active":
        return "is-success";
      case "awaiting_payment":
      case "pending":
      case "provisioning":
        return "is-warning";
      case "failed":
        return "is-danger";
      case "cancelled":
      case "refunded":
        return "is-muted";
      default:
        return "";
    }
  }

  function formatAmount(order) {
    var code = order.currency || "";
    var amt = order.amount || "";
    if (code === "BDT") return "৳" + String(amt).replace(/\.00$/, "");
    return code + " " + amt;
  }

  function buildQuery() {
    var params = new URLSearchParams();
    params.set("page", String(state.page));
    params.set("limit", String(state.limit));
    if (state.status) params.set("status", state.status);
    if (state.productType) params.set("productType", state.productType);
    if (state.search) params.set("search", state.search);
    return params.toString();
  }

  function syncUrl() {
    var qs = buildQuery();
    var path = "/admin/orders" + (qs ? "?" + qs : "");
    if (window.location.search !== (qs ? "?" + qs : "")) {
      window.history.replaceState(null, "", path);
    }
  }

  function readUrl() {
    var params = new URLSearchParams(window.location.search);
    var page = parseInt(params.get("page") || "1", 10);
    state.page = page > 0 ? page : 1;
    var limit = parseInt(params.get("limit") || "20", 10);
    state.limit = limit > 0 && limit <= 50 ? limit : 20;
    state.status = params.get("status") || "";
    state.productType = params.get("productType") || "";
    state.search = params.get("search") || "";
    if (filterStatus) filterStatus.value = state.status;
    if (filterProduct) filterProduct.value = state.productType;
    if (filterSearch) filterSearch.value = state.search;
  }

  function appendRow(order) {
    if (!tbody) return;
    var tr = document.createElement("tr");
    tr.className = "admin-orders-row";

    var tdOrder = document.createElement("td");
    tdOrder.setAttribute("data-label", "Order");
    var link = document.createElement("a");
    link.href = "/admin/orders/" + order.id;
    link.textContent = order.orderNumber;
    tdOrder.appendChild(link);
    tr.appendChild(tdOrder);

    var tdCustomer = document.createElement("td");
    tdCustomer.setAttribute("data-label", "Customer");
    tdCustomer.textContent =
      (order.customer && order.customer.email) || "—";
    tr.appendChild(tdCustomer);

    var tdProduct = document.createElement("td");
    tdProduct.setAttribute("data-label", "Product");
    var planName =
      (order.plan && order.plan.name) || titleCase(order.productType);
    tdProduct.textContent = titleCase(order.productType) + " · " + planName;
    tr.appendChild(tdProduct);

    var tdAmount = document.createElement("td");
    tdAmount.setAttribute("data-label", "Amount");
    tdAmount.textContent = formatAmount(order);
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

    var tdAction = document.createElement("td");
    tdAction.setAttribute("data-label", "Action");
    var view = document.createElement("a");
    view.className = "btn btn-outline btn-sm";
    view.href = "/admin/orders/" + order.id;
    view.textContent = "View";
    tdAction.appendChild(view);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  }

  function emptyMessage(p) {
    var total = p.total || 0;
    if (state.status || state.productType || state.search) {
      return "No orders match the current filters.";
    }
    if (total > 0 && state.page > 1) {
      return (
        "No orders on page " +
        state.page +
        " of " +
        p.totalPages +
        ". Use Previous to go back."
      );
    }
    return "No orders yet.";
  }

  async function load() {
    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    if (tbody) tbody.textContent = "";
    FA.clearMessage(statusEl);

    try {
      var res = await FA.apiRequest("/api/admin/orders?" + buildQuery(), {
        headers: { Accept: "application/json" },
      });
      if (loadingEl) loadingEl.hidden = true;

      if (FA.redirectIfSignedOut(res.response)) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to load orders."),
          "error"
        );
        updatePagination(null);
        return;
      }

      var data = res.body.data || {};
      var orders = data.orders || [];
      var p = data.pagination || {};

      if (summaryEl) {
        summaryEl.textContent =
          (p.total || 0) + " order" + (p.total === 1 ? "" : "s");
      }

      if (!orders.length) {
        if (emptyEl) {
          emptyEl.hidden = false;
          emptyEl.textContent = emptyMessage(p);
        }
      } else {
        orders.forEach(appendRow);
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

  if (filterForm) {
    filterForm.addEventListener("submit", function (event) {
      event.preventDefault();
      state.status = filterStatus ? filterStatus.value : "";
      state.productType = filterProduct ? filterProduct.value : "";
      state.search = filterSearch ? filterSearch.value.trim() : "";
      state.page = 1;
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

  var resetBtn = document.getElementById("admin-orders-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      state.status = "";
      state.productType = "";
      state.search = "";
      state.page = 1;
      if (filterStatus) filterStatus.value = "";
      if (filterProduct) filterProduct.value = "";
      if (filterSearch) filterSearch.value = "";
      load();
    });
  }

  (async function initOrders() {
    var admin = await FA.ensureAdminOrLogin();
    if (!admin) return;
    FA.initShell(admin);
    readUrl();
    await load();
  })();
})();
