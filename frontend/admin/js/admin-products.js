(function () {
  "use strict";

  var FA = window.FlareAdmin;
  if (!FA) return;

  var root = document.getElementById("admin-products-root");
  if (!root) return;

  var statusEl = document.getElementById("admin-products-status");
  var tbody = document.getElementById("admin-products-tbody");
  var emptyEl = document.getElementById("admin-products-empty");
  var loadingEl = document.getElementById("admin-products-loading");
  var summaryEl = document.getElementById("admin-products-summary");
  var prevBtn = document.getElementById("admin-products-prev");
  var nextBtn = document.getElementById("admin-products-next");
  var pageInfo = document.getElementById("admin-products-page-info");

  var filterStatus = document.getElementById("filter-status");
  var filterSearch = document.getElementById("filter-search");
  var filterForm = document.getElementById("admin-products-filters");
  var resetBtn = document.getElementById("admin-products-reset");

  var addBtn = document.getElementById("admin-products-add");
  var formPanel = document.getElementById("admin-products-form");
  var formTitle = document.getElementById("admin-products-form-title");
  var editor = document.getElementById("product-editor");
  var cancelBtn = document.getElementById("admin-products-cancel");
  var saveBtn = document.getElementById("admin-products-save");

  var typeSelect = document.getElementById("product-type");
  var typeHint = document.getElementById("product-type-hint");
  var typeLockedHint = document.getElementById("product-type-locked-hint");
  var categorySelect = document.getElementById("product-category");
  var nameInput = document.getElementById("product-name");
  var slugInput = document.getElementById("product-slug");
  var priceInput = document.getElementById("product-price");
  var billingSelect = document.getElementById("product-billing");
  var statusSelect = document.getElementById("product-status-field");
  var displayInput = document.getElementById("product-display");
  var popularInput = document.getElementById("product-popular");
  var descriptionInput = document.getElementById("product-description");
  var storageInput = document.getElementById("product-storage");
  var bandwidthInput = document.getElementById("product-bandwidth");
  var cpuInput = document.getElementById("product-cpu");
  var ramInput = document.getElementById("product-ram");
  var domainsInput = document.getElementById("product-domains");
  var emailInput = document.getElementById("product-email");
  var databasesInput = document.getElementById("product-databases");
  var ipv4Input = document.getElementById("product-ipv4");
  var sslSelect = document.getElementById("product-ssl");

  var fieldCategory = document.getElementById("field-category");
  var fieldDomains = document.getElementById("field-domains");
  var fieldEmail = document.getElementById("field-email");
  var fieldDatabases = document.getElementById("field-databases");
  var fieldIpv4 = document.getElementById("field-ipv4");
  var fieldSsl = document.getElementById("field-ssl");

  var tabButtons = document.querySelectorAll(".admin-tab");
  var navLinks = {
    web: document.getElementById("nav-cat-web"),
    minecraft: document.getElementById("nav-cat-minecraft"),
    vps: document.getElementById("nav-cat-vps"),
  };

  var CATEGORIES = ["", "web", "minecraft", "vps"];
  var STATUSES = ["", "active", "inactive", "archived"];
  var INT_PATTERN = /^\d{1,10}$/;
  var PRICE_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;
  var SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  var state = {
    page: 1,
    limit: 20,
    status: "",
    search: "",
    category: "",
  };

  var editMode = false;
  var editing = null; // product row currently being edited, or null

  function titleCase(value) {
    if (!value) return "—";
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function priceDisplay(product) {
    if (product.price === null || product.price === undefined) return "—";
    var value = String(product.price).replace(/\.00$/, "");
    if (product.currency === "BDT") return "৳" + value;
    return value + " " + (product.currency || "");
  }

  function categoryLabel(product) {
    if (product.productType === "vps") return "VPS";
    if (product.category === "minecraft") return "Minecraft";
    return "Web";
  }

  function statusClass(status) {
    switch (status) {
      case "active":
        return "is-success";
      case "inactive":
        return "is-muted";
      case "archived":
        return "is-warning";
      default:
        return "";
    }
  }

  function buildQuery() {
    var params = new URLSearchParams();
    params.set("page", String(state.page));
    params.set("limit", String(state.limit));
    if (state.status) params.set("status", state.status);
    if (state.search) params.set("search", state.search);
    if (state.category) {
      if (state.category === "vps") {
        params.set("productType", "vps");
      } else {
        params.set("productType", "hosting");
        params.set("category", state.category);
      }
    }
    return params.toString();
  }

  function readUrl() {
    var params = new URLSearchParams(window.location.search);
    var page = parseInt(params.get("page") || "1", 10);
    state.page = page > 0 ? page : 1;
    var limit = parseInt(params.get("limit") || "20", 10);
    state.limit = limit > 0 && limit <= 50 ? limit : 20;
    var status = params.get("status") || "";
    state.status = STATUSES.indexOf(status) >= 0 ? status : "";
    var search = params.get("search") || "";
    state.search = search.length > 100 ? search.slice(0, 100) : search;
    var category = params.get("category") || "";
    if (!category) {
      // Legacy API-style URLs (?productType=vps) map onto the category tabs.
      var legacyType = params.get("productType") || "";
      if (legacyType === "vps") category = "vps";
    }
    state.category = CATEGORIES.indexOf(category) >= 0 ? category : "";
    if (filterStatus) filterStatus.value = state.status;
    if (filterSearch) filterSearch.value = state.search;
  }

  function writeUrlState(mode) {
    var params = new URLSearchParams(window.location.search);
    if (state.page > 1) params.set("page", String(state.page));
    else params.delete("page");
    if (state.status) params.set("status", state.status);
    else params.delete("status");
    if (state.search) params.set("search", state.search);
    else params.delete("search");
    if (state.category) params.set("category", state.category);
    else params.delete("category");
    // category tabs are the canonical URL state; drop legacy API-style params.
    params.delete("productType");
    var qs = params.toString();
    var nextSearch = qs ? "?" + qs : "";
    if (window.location.search === nextSearch) return;
    var path = "/admin/products" + nextSearch;
    if (mode === "push") {
      window.history.pushState(null, "", path);
    } else {
      window.history.replaceState(null, "", path);
    }
  }

  function applyUrlState() {
    readUrl();
    updateTabs();
    load();
  }

  function updateTabs() {
    tabButtons.forEach(function (btn) {
      var active = (btn.getAttribute("data-category") || "") === state.category;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      if (active) btn.classList.add("is-active");
      else btn.classList.remove("is-active");
    });
    Object.keys(navLinks).forEach(function (key) {
      var link = navLinks[key];
      if (!link) return;
      if (state.category && state.category === key) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function appendRow(product) {
    if (!tbody) return;
    var tr = document.createElement("tr");
    tr.className = "admin-products-row";

    var tdName = document.createElement("td");
    tdName.setAttribute("data-label", "Product");
    var nameSpan = document.createElement("span");
    nameSpan.className = "admin-product-name";
    nameSpan.textContent = product.name || "—";
    var slugSpan = document.createElement("span");
    slugSpan.className = "admin-product-slug";
    slugSpan.textContent = product.slug || "";
    tdName.appendChild(nameSpan);
    tdName.appendChild(slugSpan);
    tr.appendChild(tdName);

    var tdCategory = document.createElement("td");
    tdCategory.setAttribute("data-label", "Catalog");
    var catBadge = document.createElement("span");
    catBadge.className = "admin-cat-badge admin-cat-" + product.productType +
      (product.category === "minecraft" ? " admin-cat-minecraft" : "");
    catBadge.textContent = categoryLabel(product);
    tdCategory.appendChild(catBadge);
    tr.appendChild(tdCategory);

    var tdPrice = document.createElement("td");
    tdPrice.setAttribute("data-label", "Price");
    tdPrice.textContent = priceDisplay(product);
    tr.appendChild(tdPrice);

    var tdBilling = document.createElement("td");
    tdBilling.setAttribute("data-label", "Billing");
    tdBilling.textContent = titleCase(product.billingCycle);
    tr.appendChild(tdBilling);

    var tdStatus = document.createElement("td");
    tdStatus.setAttribute("data-label", "Status");
    var badge = document.createElement("span");
    badge.className = "status-badge " + statusClass(product.status);
    badge.textContent = titleCase(product.status);
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    var tdPopular = document.createElement("td");
    tdPopular.setAttribute("data-label", "Popular");
    tdPopular.textContent = product.popular ? "Yes" : "—";
    tr.appendChild(tdPopular);

    var tdOrders = document.createElement("td");
    tdOrders.setAttribute("data-label", "Orders");
    tdOrders.textContent = String(product.orderCount || 0);
    tr.appendChild(tdOrders);

    var tdAction = document.createElement("td");
    tdAction.setAttribute("data-label", "Action");

    var editBtn = document.createElement("button");
    editBtn.className = "btn btn-outline btn-sm";
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", function () {
      openEdit(product);
    });
    tdAction.appendChild(editBtn);

    var toggleBtn = document.createElement("button");
    toggleBtn.className = "btn btn-outline btn-sm";
    toggleBtn.type = "button";
    toggleBtn.textContent = product.status === "active" ? "Deactivate" : "Activate";
    toggleBtn.addEventListener("click", function () {
      toggleStatus(product);
    });
    tdAction.appendChild(toggleBtn);

    var deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-outline btn-sm";
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", function () {
      removeProduct(product);
    });
    tdAction.appendChild(deleteBtn);

    tr.appendChild(tdAction);
    tbody.appendChild(tr);
  }

  function emptyMessage(p) {
    var total = p.total || 0;
    if (state.status || state.search) {
      return "No products match the current filters.";
    }
    if (total > 0 && state.page > 1) {
      return (
        "No products on page " +
        state.page +
        " of " +
        p.totalPages +
        ". Use Previous to go back."
      );
    }
    return "No products yet. Add your first product.";
  }

  async function load() {
    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    if (tbody) tbody.textContent = "";
    FA.clearMessage(statusEl);

    try {
      var res = await FA.apiRequest("/api/admin/plans?" + buildQuery(), {
        headers: { Accept: "application/json" },
      });
      if (loadingEl) loadingEl.hidden = true;

      if (FA.redirectIfSignedOut(res.response)) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to load products."),
          "error"
        );
        updatePagination(null);
        return;
      }

      var data = res.body.data || {};
      var products = data.products || [];
      var p = data.pagination || {};

      if (summaryEl) {
        summaryEl.textContent =
          (p.total || 0) + " product" + (p.total === 1 ? "" : "s");
      }

      if (!products.length) {
        if (emptyEl) {
          emptyEl.hidden = false;
          emptyEl.textContent = emptyMessage(p);
        }
      } else {
        products.forEach(appendRow);
      }

      updatePagination(p);
      updateTabs();
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

  function setFieldVisible(field, visible) {
    if (!field) return;
    field.hidden = !visible;
  }

  function applyTypeVisibility() {
    var isVps = typeSelect.value === "vps";
    setFieldVisible(fieldCategory, !isVps);
    setFieldVisible(fieldDomains, !isVps);
    setFieldVisible(fieldEmail, !isVps);
    setFieldVisible(fieldDatabases, !isVps);
    setFieldVisible(fieldSsl, !isVps);
    setFieldVisible(fieldIpv4, isVps);
  }

  function resetEditor() {
    editMode = false;
    editing = null;
    editor.reset();
    typeSelect.disabled = false;
    if (typeHint) typeHint.hidden = false;
    if (typeLockedHint) typeLockedHint.hidden = true;
    statusSelect.querySelectorAll("option[data-dynamic]").forEach(function (opt) {
      opt.remove();
    });
    typeSelect.value = state.category === "vps" ? "vps" : "hosting";
    if (state.category === "web" || state.category === "minecraft") {
      categorySelect.value = state.category;
    } else {
      categorySelect.value = "web";
    }
    statusSelect.value = "active";
    billingSelect.value = "monthly";
    popularInput.checked = false;
    applyTypeVisibility();
    if (formTitle) formTitle.textContent = "Add product";
    if (saveBtn) saveBtn.textContent = "Save product";
  }

  function openCreate() {
    resetEditor();
    FA.clearMessage(statusEl);
    if (formPanel) formPanel.hidden = false;
    if (formPanel) formPanel.scrollIntoView({ block: "nearest" });
    if (nameInput) nameInput.focus();
  }

  function openEdit(product) {
    resetEditor();
    editMode = true;
    editing = product;
    FA.clearMessage(statusEl);

    typeSelect.value = product.productType;
    typeSelect.disabled = true;
    if (typeHint) typeHint.hidden = true;
    if (typeLockedHint) typeLockedHint.hidden = false;
    if (product.productType === "hosting") {
      categorySelect.value = product.category === "minecraft" ? "minecraft" : "web";
    }
    nameInput.value = product.name || "";
    slugInput.value = product.slug || "";
    priceInput.value =
      product.price === null || product.price === undefined ? "" : String(product.price);
    billingSelect.value = product.billingCycle || "monthly";
    displayInput.value =
      product.displayOrder === null || product.displayOrder === undefined
        ? ""
        : String(product.displayOrder);
    popularInput.checked = Boolean(product.popular);
    descriptionInput.value = product.description || "";
    storageInput.value =
      product.storageGb === null || product.storageGb === undefined
        ? ""
        : String(product.storageGb);
    bandwidthInput.value =
      product.bandwidthGb === null || product.bandwidthGb === undefined
        ? ""
        : String(product.bandwidthGb);
    cpuInput.value =
      product.cpuCores === null || product.cpuCores === undefined
        ? ""
        : String(product.cpuCores);
    ramInput.value =
      product.ramMb === null || product.ramMb === undefined
        ? ""
        : String(product.ramMb);
    if (product.productType === "hosting") {
      domainsInput.value =
        product.domains === null || product.domains === undefined
          ? ""
          : String(product.domains);
      emailInput.value =
        product.emailAccounts === null || product.emailAccounts === undefined
          ? ""
          : String(product.emailAccounts);
      databasesInput.value =
        product.databases === null || product.databases === undefined
          ? ""
          : String(product.databases);
      sslSelect.value = product.ssl ? "true" : "false";
    } else {
      ipv4Input.value =
        product.ipv4Addresses === null || product.ipv4Addresses === undefined
          ? ""
          : String(product.ipv4Addresses);
    }

    if (product.status === "archived") {
      var archived = document.createElement("option");
      archived.value = "archived";
      archived.textContent = "Archived";
      archived.setAttribute("data-dynamic", "true");
      archived.disabled = true;
      statusSelect.appendChild(archived);
      statusSelect.value = "archived";
    } else {
      statusSelect.value = product.status === "inactive" ? "inactive" : "active";
    }

    applyTypeVisibility();
    if (formTitle) formTitle.textContent = "Edit product";
    if (saveBtn) saveBtn.textContent = "Save changes";
    if (formPanel) {
      formPanel.hidden = false;
      formPanel.scrollIntoView({ block: "nearest" });
    }
    if (nameInput) nameInput.focus();
  }

  function closeEditor() {
    if (formPanel) formPanel.hidden = true;
    editMode = false;
    editing = null;
  }

  function validateForm() {
    var name = nameInput.value.trim();
    if (!name) return "Name is required.";
    var slug = slugInput.value.trim();
    if (!slug) return "Slug is required.";
    if (!SLUG_PATTERN.test(slug)) {
      return "Slug must contain only lowercase letters, digits, and hyphens.";
    }
    var price = priceInput.value.trim();
    if (!price) return "Price is required.";
    if (!PRICE_PATTERN.test(price)) {
      return "Price must be a non-negative number with up to 2 decimals.";
    }
    var numeric = [
      ["Storage", storageInput.value.trim()],
      ["Bandwidth", bandwidthInput.value.trim()],
      ["vCPU cores", cpuInput.value.trim()],
      ["RAM", ramInput.value.trim()],
      ["Display order", displayInput.value.trim()],
    ];
    if (typeSelect.value === "hosting") {
      numeric.push(
        ["Domains", domainsInput.value.trim()],
        ["Email accounts", emailInput.value.trim()],
        ["Databases", databasesInput.value.trim()]
      );
    } else {
      numeric.push(["IPv4 addresses", ipv4Input.value.trim()]);
    }
    for (var i = 0; i < numeric.length; i++) {
      var label = numeric[i][0];
      var value = numeric[i][1];
      if (value && !INT_PATTERN.test(value)) {
        return label + " must be a whole number.";
      }
    }
    if (descriptionInput.value.length > 500) {
      return "Description must be at most 500 characters.";
    }
    return null;
  }

  function buildPayload() {
    var type = typeSelect.value;
    var payload = {};
    payload.name = nameInput.value.trim();
    payload.slug = slugInput.value.trim();
    payload.price = priceInput.value.trim();
    payload.billingCycle = billingSelect.value;
    payload.popular = popularInput.checked;
    var desc = descriptionInput.value;
    payload.description = desc.trim() === "" ? null : desc;

    if (!(editMode && statusSelect.value === "archived")) {
      payload.status = statusSelect.value;
    }

    var display = displayInput.value.trim();
    if (display) payload.displayOrder = display;

    var storage = storageInput.value.trim();
    if (storage) payload.storageGb = storage;

    var bandwidth = bandwidthInput.value.trim();
    payload.bandwidthGb = bandwidth === "" ? null : bandwidth;

    if (type === "vps") {
      var cpu = cpuInput.value.trim();
      if (cpu) payload.cpuCores = cpu;
      var ram = ramInput.value.trim();
      if (ram) payload.ramMb = ram;
      var ipv4 = ipv4Input.value.trim();
      if (ipv4) payload.ipv4Addresses = ipv4;
    } else {
      payload.category = categorySelect.value;
      payload.cpuCores = cpuInput.value.trim() === "" ? null : cpuInput.value.trim();
      payload.ramMb = ramInput.value.trim() === "" ? null : ramInput.value.trim();
      var domains = domainsInput.value.trim();
      if (domains) payload.domains = domains;
      var email = emailInput.value.trim();
      if (email) payload.emailAccounts = email;
      var databases = databasesInput.value.trim();
      if (databases) payload.databases = databases;
      payload.ssl = sslSelect.value === "true";
    }

    if (!editMode) payload.productType = type;
    return payload;
  }

  async function submitForm(event) {
    event.preventDefault();
    var problem = validateForm();
    if (problem) {
      FA.setStatus(statusEl, problem, "error");
      return;
    }
    var payload = buildPayload();
    if (saveBtn) saveBtn.disabled = true;
    FA.clearMessage(statusEl);

    try {
      var url = "/api/admin/plans";
      var method = "POST";
      if (editMode && editing) {
        url =
          "/api/admin/plans/" +
          editing.productType +
          "/" +
          encodeURIComponent(editing.id);
        method = "PATCH";
      }
      var res = await FA.apiRequest(url, {
        method: method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (saveBtn) saveBtn.disabled = false;

      if (FA.redirectIfSignedOut(res.response)) return;

      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to save product."),
          "error"
        );
        return;
      }

      closeEditor();
      await load();
      FA.setStatus(
        statusEl,
        editMode ? "Product updated." : "Product created.",
        "success"
      );
    } catch (err) {
      if (saveBtn) saveBtn.disabled = false;
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
    }
  }

  async function toggleStatus(product) {
    var next = product.status === "active" ? "inactive" : "active";
    if (
      next === "inactive" &&
      !window.confirm(
        'Deactivate "' +
          product.name +
          '"? Customers will no longer be able to order this product.'
      )
    ) {
      return;
    }
    FA.clearMessage(statusEl);
    try {
      var res = await FA.apiRequest(
        "/api/admin/plans/" +
          product.productType +
          "/" +
          encodeURIComponent(product.id),
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: next }),
        }
      );
      if (FA.redirectIfSignedOut(res.response)) return;
      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to change status."),
          "error"
        );
        return;
      }
      if (editMode && editing && editing.id === product.id) closeEditor();
      await load();
      FA.setStatus(
        statusEl,
        next === "active"
          ? '"' + product.name + '" activated.'
          : '"' + product.name + '" deactivated.',
        "success"
      );
    } catch (err) {
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
    }
  }

  async function removeProduct(product) {
    var orders = product.orderCount || 0;
    var services = product.serviceCount || 0;
    if (orders > 0 || services > 0) {
      FA.setStatus(
        statusEl,
        '"' +
          product.name +
          '" is referenced by ' +
          orders +
          " order(s) and " +
          services +
          " service(s) and cannot be deleted. Deactivate it instead.",
        "error"
      );
      return;
    }
    if (!window.confirm('Delete "' + product.name + '"? This cannot be undone.')) {
      return;
    }
    FA.clearMessage(statusEl);
    try {
      var res = await FA.apiRequest(
        "/api/admin/plans/" +
          product.productType +
          "/" +
          encodeURIComponent(product.id),
        {
          method: "DELETE",
          headers: { Accept: "application/json" },
        }
      );
      if (FA.redirectIfSignedOut(res.response)) return;
      if (!res.response.ok || !res.body || !res.body.success) {
        FA.setStatus(
          statusEl,
          FA.errorFromResponse(res.body, "Unable to delete product."),
          "error"
        );
        return;
      }
      if (editMode && editing && editing.id === product.id) closeEditor();
      await load();
      FA.setStatus(statusEl, '"' + product.name + '" deleted.', "success");
    } catch (err) {
      FA.setStatus(statusEl, "Unable to reach the server.", "error");
    }
  }

  if (filterForm) {
    filterForm.addEventListener("submit", function (event) {
      event.preventDefault();
      state.status = filterStatus ? filterStatus.value : "";
      state.search = filterSearch ? filterSearch.value.trim() : "";
      if (state.search.length > 100) state.search = state.search.slice(0, 100);
      state.page = 1;
      writeUrlState("push");
      load();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      state.status = "";
      state.search = "";
      state.page = 1;
      if (filterStatus) filterStatus.value = "";
      if (filterSearch) filterSearch.value = "";
      writeUrlState("push");
      load();
    });
  }

  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.category = btn.getAttribute("data-category") || "";
      state.page = 1;
      writeUrlState("push");
      load();
    });
  });

  if (prevBtn) {
    prevBtn.addEventListener("click", function () {
      if (state.page > 1) {
        state.page -= 1;
        writeUrlState("push");
        load();
      }
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", function () {
      state.page += 1;
      writeUrlState("push");
      load();
    });
  }

  // Browser back/forward steps through the filter states the admin created.
  window.addEventListener("popstate", applyUrlState);

  if (addBtn) {
    addBtn.addEventListener("click", openCreate);
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", closeEditor);
  }
  if (editor) {
    editor.addEventListener("submit", submitForm);
  }
  if (typeSelect) {
    typeSelect.addEventListener("change", applyTypeVisibility);
  }

  (async function initProducts() {
    var admin = await FA.ensureAdminOrLogin();
    if (!admin) return;
    FA.initShell(admin);
    readUrl();
    writeUrlState("replace");
    updateTabs();
    await load();
  })();
})();
