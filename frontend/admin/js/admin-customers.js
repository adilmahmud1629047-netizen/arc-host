(function () {
  "use strict";

  var FA = window.FlareAdmin;
  if (!FA) return;

  var root = document.getElementById("admin-customers-root");
  if (!root) return;

  var statusEl = document.getElementById("admin-customers-status");
  var tbody = document.getElementById("admin-customers-tbody");
  var emptyEl = document.getElementById("admin-customers-empty");
  var loadingEl = document.getElementById("admin-customers-loading");
  var summaryEl = document.getElementById("admin-customers-summary");
  var prevBtn = document.getElementById("admin-customers-prev");
  var nextBtn = document.getElementById("admin-customers-next");
  var pageInfo = document.getElementById("admin-customers-page-info");

  var filterStatus = document.getElementById("filter-status");
  var filterSearch = document.getElementById("filter-search");
  var filterForm = document.getElementById("admin-customers-filters");

  var state = {
    page: 1,
    limit: 20,
    status: "",
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
      case "active":
      case "paid":
        return "is-success";
      case "pending":
        return "is-warning";
      case "suspended":
      case "failed":
        return "is-danger";
      case "cancelled":
      case "refunded":
        return "is-muted";
      default:
        return "";
    }
  }

  function displayName(c) {
    var name = c.name || [c.firstName, c.lastName].filter(Boolean).join(" ");
    return name || c.email || "—";
  }

  function buildQuery() {
    var params = new URLSearchParams();
    params.set("page", String(state.page));
    params.set("limit", String(state.limit));
    if (state.status) params.set("status", state.status);
    if (state.search) params.set("search", state.search);
    return params.toString();
  }

  function syncUrl() {
    var qs = buildQuery();
    var path = "/admin/customers" + (qs ? "?" + qs : "");
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
    state.search = params.get("search") || "";
    if (filterStatus) filterStatus.value = state.status;
    if (filterSearch) filterSearch.value = state.search;
  }

  function appendRow(customer) {
    if (!tbody) return;
    var tr = document.createElement("tr");
    tr.className = "admin-customers-row";

    var tdName = document.createElement("td");
    tdName.setAttribute("data-label", "Customer");
    var link = document.createElement("a");
    link.href = "/admin/customers/" + customer.id;
    link.textContent = displayName(customer);
    tdName.appendChild(link);
    tr.appendChild(tdName);

    var tdEmail = document.createElement("td");
    tdEmail.setAttribute("data-label", "Email");
    tdEmail.textContent = customer.email || "—";
    tr.appendChild(tdEmail);

    var tdStatus = document.createElement("td");
    tdStatus.setAttribute("data-label", "Status");
    var badge = document.createElement("span");
    badge.className = "status-badge " + statusClass(customer.status);
    badge.textContent = titleCase(customer.status);
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    var tdRole = document.createElement("td");
    tdRole.setAttribute("data-label", "Role");
    tdRole.textContent = titleCase(customer.role);
    tr.appendChild(tdRole);

    var tdOrders = document.createElement("td");
    tdOrders.setAttribute("data-label", "Orders");
    tdOrders.textContent = String(customer.orderCount || 0);
    tr.appendChild(tdOrders);

    var tdServices = document.createElement("td");
    tdServices.setAttribute("data-label", "Services");
    tdServices.textContent = String(customer.serviceCount || 0);
    tr.appendChild(tdServices);

    var tdLatest = document.createElement("td");
    tdLatest.setAttribute("data-label", "Latest order");
    tdLatest.textContent = formatDate(customer.latestOrderAt);
    tr.appendChild(tdLatest);

    var tdCreated = document.createElement("td");
    tdCreated.setAttribute("data-label", "Created");
    tdCreated.textContent = formatDate(customer.createdAt);
    tr.appendChild(tdCreated);

    var tdAction = document.createElement("td");
    tdAction.setAttribute("data-label", "Action");
    var view = document.createElement("a");
    view.className = "btn btn-outline btn-sm";
    view.href = "/admin/customers/" + customer.id;
    view.textContent = "View";
    tdAction.appendChild(view);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  }

  function emptyMessage(p) {
    var total = p.total || 0;
    if (state.status || state.search) {
      return "No customers match the current filters.";
    }
    if (total > 0 && state.page > 1) {
      return (
        "No customers on page " +
        state.page +
        " of " +
        p.totalPages +
        ". Use Previous to go back."
      );
    }
    return "No customers yet.";
  }

  async function load() {
    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    if (tbody) tbody.textContent = "";
    FA.clearMessage(statusEl);

    try {
      var res = await FA.apiRequest("/api/admin/customers?" + buildQuery(), {
        headers: { Accept: "application/json" },
      });
      if (loadingEl) loadingEl.hidden = true;

      if (FA.redirectIfSignedOut(res.response)) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to load customers."),
          "error"
        );
        updatePagination(null);
        return;
      }

      var data = res.body.data || {};
      var customers = data.customers || [];
      var p = data.pagination || {};

      if (summaryEl) {
        summaryEl.textContent =
          (p.total || 0) + " customer" + (p.total === 1 ? "" : "s");
      }

      if (!customers.length) {
        if (emptyEl) {
          emptyEl.hidden = false;
          emptyEl.textContent = emptyMessage(p);
        }
      } else {
        customers.forEach(appendRow);
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

  var resetBtn = document.getElementById("admin-customers-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      state.status = "";
      state.search = "";
      state.page = 1;
      if (filterStatus) filterStatus.value = "";
      if (filterSearch) filterSearch.value = "";
      load();
    });
  }

  (async function initCustomers() {
    var admin = await FA.ensureAdminOrLogin();
    if (!admin) return;
    FA.initShell(admin);
    readUrl();
    await load();
  })();
})();
