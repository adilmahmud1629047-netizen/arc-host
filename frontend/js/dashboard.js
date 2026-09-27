(function () {
  "use strict";

  var VALID_SECTIONS = [
    "overview",
    "hosting",
    "vps",
    "account",
    "services",
    "orders",
    "billing",
    "support",
  ];

  var root = document.getElementById("dashboard-root");
  if (!root) return;

  var statusEl = document.getElementById("dashboard-status");
  var headerAccount = document.getElementById("header-account");
  var headerName = document.getElementById("header-user-name");
  var headerEmail = document.getElementById("header-user-email");
  var menuToggle = document.getElementById("dashboard-menu-toggle");
  var sidebar = document.getElementById("dashboard-sidebar");

  var catalog =
    window.FlareCatalog && typeof window.FlareCatalog === "object"
      ? window.FlareCatalog
      : null;

  function formatMoney(currency, amount) {
    var code = currency || "BDT";
    var value = amount != null ? String(amount) : "";
    if (code === "BDT") {
      return "৳" + value.replace(/\.00$/, "");
    }
    return code + " " + value;
  }

  function showStatus(message, kind) {
    if (!statusEl) return;
    statusEl.hidden = !message;
    statusEl.textContent = message || "";
    statusEl.classList.remove("form-status-error", "form-status-success");
    if (kind === "error") statusEl.classList.add("form-status-error");
    if (kind === "success") statusEl.classList.add("form-status-success");
    statusEl.setAttribute("role", kind === "error" ? "alert" : "status");
    if (message) statusEl.focus();
  }

  function hideStatus() {
    if (!statusEl) return;
    statusEl.hidden = true;
    statusEl.textContent = "";
  }

  function formatDate(value) {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch (err) {
      return "—";
    }
  }

  function titleCase(value) {
    if (!value) return "—";
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function setNavCurrent(sectionId) {
    document.querySelectorAll("[data-nav-section]").forEach(function (link) {
      var id = link.getAttribute("data-nav-section");
      if (id === sectionId) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function showSection(sectionId) {
    var id = VALID_SECTIONS.indexOf(sectionId) >= 0 ? sectionId : "overview";

    document.querySelectorAll("[data-section]").forEach(function (section) {
      var match = section.getAttribute("data-section") === id;
      section.hidden = !match;
    });

    setNavCurrent(id);
    closeSidebar();

    if (id === "hosting") loadPlanSection("hosting");
    if (id === "vps") loadPlanSection("vps");
    if (id === "services") loadServices();
    if (id === "orders") loadOrders(ordersState.page);
    if (id === "billing") loadPayments(paymentsState.page);
  }

  function currentSectionFromHash() {
    var hash = (window.location.hash || "").replace(/^#/, "");
    return VALID_SECTIONS.indexOf(hash) >= 0 ? hash : "overview";
  }

  function openSidebar() {
    if (!sidebar || !menuToggle) return;
    sidebar.classList.add("is-open");
    menuToggle.setAttribute("aria-expanded", "true");
  }

  function closeSidebar() {
    if (!sidebar || !menuToggle) return;
    sidebar.classList.remove("is-open");
    menuToggle.setAttribute("aria-expanded", "false");
  }

  function toggleSidebar() {
    if (!sidebar) return;
    if (sidebar.classList.contains("is-open")) closeSidebar();
    else openSidebar();
  }

  if (menuToggle && sidebar) {
    menuToggle.addEventListener("click", toggleSidebar);

    sidebar.addEventListener("click", function (event) {
      if (event.target.closest("a")) closeSidebar();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
        closeSidebar();
        menuToggle.focus();
      }
    });
  }

  window.addEventListener("hashchange", function () {
    showSection(currentSectionFromHash());
  });

  // ---------- account ----------

  function populateAccount(user) {
    var fullName =
      (user.firstName || "") + " " + (user.lastName || "").trim();

    if (headerName) headerName.textContent = fullName.trim() || "Customer";
    if (headerEmail) headerEmail.textContent = user.email || "";
    if (headerAccount) headerAccount.hidden = false;

    var greeting = document.getElementById("overview-greeting");
    if (greeting) {
      greeting.textContent =
        "Signed in as " +
        (fullName.trim() || user.email || "you") +
        ". Here is your account snapshot.";
    }

    setText("account-first-name", user.firstName || "—");
    setText("account-last-name", user.lastName || "—");
    setText("account-email", user.email || "—");
    setText("account-status", titleCase(user.status));
    setText(
      "account-email-verified",
      user.emailVerified ? "Verified" : "Not verified yet"
    );
    setText("account-created", formatDate(user.createdAt));

    setText("stat-account-status", titleCase(user.status));
    setText(
      "stat-email-verified",
      user.emailVerified ? "Email verified" : "Email not verified"
    );
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // ---------- plan sections ----------

  var plansLoaded = { hosting: false, vps: false };

  function setStatusEl(el, message, kind) {
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
    el.classList.remove(
      "plan-status-loading",
      "plan-status-empty",
      "plan-status-error"
    );
    if (kind) el.classList.add("plan-status-" + kind);
  }

  function selectPlanHref(type, slug) {
    return (
      "/checkout?type=" +
      encodeURIComponent(type) +
      "&plan=" +
      encodeURIComponent(slug)
    );
  }

  function renderPlanCard(plan, type) {
    var card = document.createElement("article");
    card.className = "plan-card";

    var top = document.createElement("div");
    top.className = "plan-card-top";
    var name = document.createElement("h3");
    name.className = "plan-name";
    name.textContent = plan.name;
    var badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Demo";
    top.appendChild(name);
    top.appendChild(badge);

    var price = document.createElement("div");
    price.className = "plan-price";
    var amount = document.createElement("span");
    amount.className = "amount";
    amount.textContent = catalog
      ? catalog.formatPrice(plan)
      : String(plan.price || "");
    var period = document.createElement("span");
    period.className = "period";
    period.textContent = catalog
      ? catalog.billingPeriodLabel(plan.billingCycle)
      : "/mo";
    price.appendChild(amount);
    price.appendChild(period);

    var caption = document.createElement("p");
    caption.className = "plan-caption";
    caption.textContent = plan.description || "Plan details from the catalog.";

    var list = document.createElement("ul");
    list.className = "plan-features";

    var rows =
      type === "vps"
        ? [
            ["vCPU", plan.cpuCores + (plan.cpuCores === 1 ? " core" : " cores")],
            ["RAM", catalog ? catalog.formatRam(plan.ramMb) : plan.ramMb + " MB"],
            ["Storage", plan.storageGb + " GB"],
            [
              "Bandwidth",
              catalog
                ? catalog.formatBandwidth(plan.bandwidthGb)
                : plan.bandwidthGb + " GB / mo",
            ],
            ["IPv4 addresses", String(plan.ipv4Addresses)],
            ["Billing cycle", titleCase(plan.billingCycle)],
          ]
        : [
            [
              "Websites",
              catalog ? catalog.unlimited(plan.domains) : String(plan.domains),
            ],
            ["Storage", plan.storageGb + " GB"],
            [
              "Bandwidth",
              catalog
                ? catalog.formatBandwidth(plan.bandwidthGb)
                : plan.bandwidthGb + " GB / mo",
            ],
            [
              "Email accounts",
              catalog
                ? catalog.unlimited(plan.emailAccounts)
                : String(plan.emailAccounts),
            ],
            [
              "Databases",
              catalog ? catalog.unlimited(plan.databases) : String(plan.databases),
            ],
            ["SSL", plan.ssl ? "Included" : "Not included"],
            ["Billing cycle", titleCase(plan.billingCycle)],
          ];

    rows.forEach(function (pair) {
      var li = document.createElement("li");
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = pair[0];
      var value = document.createElement("span");
      value.className = "value";
      value.textContent = String(pair[1]);
      li.appendChild(label);
      li.appendChild(value);
      list.appendChild(li);
    });

    var cta = document.createElement("a");
    cta.className = "btn btn-primary btn-block";
    cta.href = selectPlanHref(type, plan.slug);
    cta.textContent = "Select Plan";
    cta.setAttribute("data-select-plan", plan.slug);

    card.appendChild(top);
    card.appendChild(price);
    card.appendChild(caption);
    card.appendChild(list);
    card.appendChild(cta);
    return card;
  }

  async function loadPlanSection(type) {
    if (plansLoaded[type]) return;
    if (!catalog) {
      var gridMissing = document.getElementById(type + "-plan-grid");
      if (gridMissing) gridMissing.innerHTML = "";
      setStatusEl(
        document.getElementById(type + "-status"),
        "Unable to load plans. Please try again later.",
        "error"
      );
      return;
    }

    var grid = document.getElementById(type + "-plan-grid");
    var status = document.getElementById(type + "-status");
    setStatusEl(status, "Loading plans…", "loading");
    if (grid) grid.replaceChildren();

    try {
      var plans = await catalog.fetchPlans(type);
      if (!Array.isArray(plans) || plans.length === 0) {
        setStatusEl(status, "Plans are currently unavailable.", "empty");
        return;
      }
      setStatusEl(status, "", null);
      if (grid) {
        plans.forEach(function (plan) {
          grid.appendChild(renderPlanCard(plan, type));
        });
      }
      plansLoaded[type] = true;
    } catch (err) {
      setStatusEl(
        status,
        "Unable to load plans. Please try again later.",
        "error"
      );
    }
  }

  // ---------- services ----------

  var SERVICE_STATUS_MESSAGES = {
    provisioning: "Provisioning your service...",
    active: "Service active.",
    suspended: "Service suspended.",
    terminated: "Service terminated.",
    failed: "Provisioning failed — support is required.",
  };

  var SERVICE_STATUS_CLASSES = {
    provisioning: "order-status-awaiting",
    active: "order-status-paid",
    suspended: "order-status-pending",
    terminated: "order-status-cancelled",
    failed: "order-status-failed",
  };

  var SERVICE_TYPE_LABELS = {
    hosting: "Web Hosting",
    vps: "VPS",
  };

  var servicesState = {
    list: [],
    byOrderId: {},
    loading: false,
    loaded: false,
    failed: false,
  };

  function serviceStatusLabel(service) {
    return (
      SERVICE_STATUS_MESSAGES[service.status] ||
      titleCase(service.status) ||
      "—"
    );
  }

  function serviceStatusClass(service) {
    return SERVICE_STATUS_CLASSES[service.status] || "";
  }

  function updateActiveServicesStat() {
    var el = document.getElementById("stat-active-services");
    if (!el) return;
    var active = 0;
    servicesState.list.forEach(function (service) {
      if (service.status === "active") active += 1;
    });
    el.textContent = String(active);
    var hint = el.parentElement
      ? el.parentElement.querySelector(".stat-hint")
      : null;
    if (hint) {
      hint.textContent = servicesState.failed
        ? "Unavailable"
        : servicesState.list.length === 0
          ? "None yet"
          : "From services API";
    }
  }

  // Paid orders show the matching service state. While the services API has
  // not been loaded (or failed), no service claim is made at all.
  function paidOrderServiceMessage(order) {
    if (!order || order.status !== "paid") return null;
    if (servicesState.failed || !servicesState.loaded) return null;
    var service = servicesState.byOrderId[order.id];
    if (!service) return "Payment received — service provisioning pending.";
    return SERVICE_STATUS_MESSAGES[service.status] || null;
  }

  function renderServiceCard(service) {
    var card = document.createElement("article");
    card.className = "order-card";

    var top = document.createElement("div");
    top.className = "order-card-top";

    var title = document.createElement("h3");
    title.className = "order-number";
    title.textContent =
      SERVICE_TYPE_LABELS[service.serviceType] ||
      titleCase(service.serviceType) ||
      "Service";

    var badge = document.createElement("span");
    badge.textContent = serviceStatusLabel(service);
    badge.className = "order-status " + serviceStatusClass(service);

    top.appendChild(title);
    top.appendChild(badge);

    var meta = document.createElement("div");
    meta.className = "order-meta";

    var orderEl = document.createElement("span");
    orderEl.className = "order-plan";
    orderEl.textContent = service.orderNumber || "";

    var stateEl = document.createElement("span");
    stateEl.className = "order-service-state";
    stateEl.textContent =
      SERVICE_STATUS_MESSAGES[service.status] ||
      titleCase(service.status) ||
      "";

    meta.appendChild(orderEl);
    meta.appendChild(stateEl);

    card.appendChild(top);
    card.appendChild(meta);
    return card;
  }

  async function loadServices() {
    var list = document.getElementById("services-list");
    var empty = document.getElementById("services-empty");
    var status = document.getElementById("services-status");

    if (servicesState.loading) return;
    servicesState.loading = true;

    setStatusEl(status, "Loading services…", "loading");
    if (list) list.replaceChildren();
    if (empty) empty.hidden = true;

    try {
      var response = await fetch("/api/services?page=1&limit=50", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        window.location.replace(
          "/login?return=" + encodeURIComponent("/dashboard#services")
        );
        return;
      }

      if (
        !response.ok ||
        !body ||
        !body.success ||
        !body.data ||
        !Array.isArray(body.data.services)
      ) {
        servicesState.failed = true;
        setStatusEl(
          status,
          "Unable to load services. Please try again.",
          "error"
        );
        updateActiveServicesStat();
        return;
      }

      servicesState.list = body.data.services;
      servicesState.byOrderId = {};
      servicesState.list.forEach(function (service) {
        if (service.orderId) {
          servicesState.byOrderId[service.orderId] = service;
        }
      });
      servicesState.failed = false;
      servicesState.loaded = true;
      updateActiveServicesStat();

      setStatusEl(status, "", null);
      if (servicesState.list.length === 0) {
        if (empty) empty.hidden = false;
        if (list) list.replaceChildren();
        return;
      }

      var wrapper = document.createElement("div");
      wrapper.className = "order-list";
      servicesState.list.forEach(function (service) {
        wrapper.appendChild(renderServiceCard(service));
      });
      if (list) list.appendChild(wrapper);
    } catch (err) {
      servicesState.failed = true;
      setStatusEl(
        status,
        "Unable to reach the server. Please try again.",
        "error"
      );
      updateActiveServicesStat();
    } finally {
      servicesState.loading = false;
    }
  }

  function ensureServicesLoaded() {
    if (servicesState.loaded || servicesState.loading) {
      return Promise.resolve();
    }
    return loadServices();
  }

  // ---------- orders ----------

  var ORDER_STATUS_LABELS = {
    pending: "Pending",
    awaiting_payment: "Awaiting Payment",
    paid: "Paid",
    cancelled: "Cancelled",
    refunded: "Refunded",
    failed: "Failed",
  };

  var ORDER_STATUS_CLASSES = {
    pending: "order-status-pending",
    awaiting_payment: "order-status-awaiting",
    paid: "order-status-paid",
    cancelled: "order-status-cancelled",
    refunded: "order-status-refunded",
    failed: "order-status-failed",
  };

  var ordersState = {
    page: 1,
    total: 0,
    totalPages: 1,
    limit: 5,
    loading: false,
  };
  var ordersLoadedOnce = false;

  function orderStatusLabel(status) {
    return ORDER_STATUS_LABELS[status] || titleCase(status) || "—";
  }

  function orderStatusClass(status) {
    return ORDER_STATUS_CLASSES[status] || "";
  }

  function setStatusBadge(el, status) {
    if (!el) return;
    el.textContent = orderStatusLabel(status);
    el.className = "order-status " + orderStatusClass(status);
  }

  function orderDetailHref(order) {
    return (
      "/dashboard?order=" +
      encodeURIComponent(order.id) +
      "#orders"
    );
  }

  function renderOrderCard(order) {
    var card = document.createElement("article");
    card.className = "order-card";

    var top = document.createElement("div");
    top.className = "order-card-top";

    var number = document.createElement("h3");
    number.className = "order-number";
    number.textContent = order.orderNumber;

    var badge = document.createElement("span");
    setStatusBadge(badge, order.status);

    top.appendChild(number);
    top.appendChild(badge);

    var meta = document.createElement("div");
    meta.className = "order-meta";

    var planEl = document.createElement("span");
    planEl.className = "order-plan";
    var planName =
      order.plan && order.plan.name ? order.plan.name : "Plan unavailable";
    planEl.textContent =
      (order.productType === "vps" ? "VPS · " : "Hosting · ") + planName;

    var amountEl = document.createElement("span");
    amountEl.className = "order-amount";
    amountEl.textContent =
      formatMoney(order.currency, order.amount) +
      (catalog
        ? " " + catalog.billingPeriodLabel(order.billingCycle)
        : "");

    var dateEl = document.createElement("time");
    dateEl.className = "order-date";
    dateEl.dateTime = order.createdAt || "";
    dateEl.textContent = formatDate(order.createdAt);

    meta.appendChild(planEl);
    meta.appendChild(amountEl);
    meta.appendChild(dateEl);

    var serviceMessage = paidOrderServiceMessage(order);

    var view = document.createElement("a");
    view.className = "btn btn-outline btn-sm";
    view.href = orderDetailHref(order);
    view.textContent = "View Order";
    view.setAttribute("data-view-order", order.id);

    card.appendChild(top);
    card.appendChild(meta);
    if (serviceMessage) {
      var serviceLine = document.createElement("p");
      serviceLine.className = "order-service-state";
      serviceLine.textContent = serviceMessage;
      card.appendChild(serviceLine);
    }
    card.appendChild(view);
    return card;
  }

  function updateOrdersPagination() {
    var nav = document.getElementById("orders-pagination");
    var info = document.getElementById("orders-page-info");
    var prev = document.getElementById("orders-prev");
    var next = document.getElementById("orders-next");
    if (!nav) return;

    if (ordersState.total <= ordersState.limit) {
      nav.hidden = true;
      return;
    }

    nav.hidden = false;
    if (info) {
      info.textContent =
        "Page " + ordersState.page + " of " + ordersState.totalPages;
    }
    if (prev) prev.disabled = ordersState.page <= 1;
    if (next) next.disabled = ordersState.page >= ordersState.totalPages;
  }

  async function loadOrders(page) {
    var list = document.getElementById("orders-list");
    var empty = document.getElementById("orders-empty");
    var status = document.getElementById("orders-status");
    var detail = document.getElementById("order-detail");

    if (detail) detail.hidden = true;

    ordersState.page = Math.max(1, Math.floor(Number(page) || 1));
    if (ordersState.loading) return;
    ordersState.loading = true;

    setStatusEl(status, "Loading orders…", "loading");
    if (list) list.replaceChildren();
    if (empty) empty.hidden = true;

    try {
      var url =
        "/api/orders?page=" +
        ordersState.page +
        "&limit=" +
        (ordersState.limit || 5);
      var response = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        var returnTo = "/dashboard#orders";
        window.location.replace(
          "/login?return=" + encodeURIComponent(returnTo)
        );
        return;
      }

      if (
        !response.ok ||
        !body ||
        !body.success ||
        !body.data ||
        !Array.isArray(body.data.orders)
      ) {
        setStatusEl(status, "Unable to load orders. Please try again.", "error");
        return;
      }

      var orders = body.data.orders;
      var pagination = body.data.pagination || {};
      ordersState.total = pagination.total || 0;
      ordersState.totalPages = pagination.totalPages || 1;
      ordersState.page = pagination.page || ordersState.page;
      ordersState.limit = pagination.limit || ordersState.limit || 5;

      // Service lines on paid orders need the services API first; if that
      // fetch failed, cards render without any service claim (never a guess).
      await ensureServicesLoaded();

      if (orders.length === 0) {
        setStatusEl(status, "", null);
        if (empty) empty.hidden = false;
        if (list) list.replaceChildren();
        updateOrdersPagination();
        updatePendingOrdersStat(0);
        ordersLoadedOnce = true;
        return;
      }

      setStatusEl(status, "", null);
      var wrapper = document.createElement("div");
      wrapper.className = "order-list";
      orders.forEach(function (order) {
        wrapper.appendChild(renderOrderCard(order));
      });
      if (list) list.appendChild(wrapper);
      updateOrdersPagination();
      updatePendingOrdersStat(ordersState.total);
      ordersLoadedOnce = true;
    } catch (err) {
      setStatusEl(status, "Unable to reach the server. Please try again.", "error");
    } finally {
      ordersState.loading = false;
    }
  }

  function updatePendingOrdersStat(total) {
    var el = document.getElementById("stat-pending-orders");
    if (!el) return;
    el.textContent = String(total);
    var hint = el.parentElement
      ? el.parentElement.querySelector(".stat-hint")
      : null;
    if (hint) hint.textContent = total === 0 ? "None yet" : "All orders";
  }

  var currentDetailOrderId = null;
  var AWAITING_NOTE =
    "This order has not been paid yet — no service is provisioned until " +
    "the admin verifies your payment.";

  var MANUAL_PAYMENT_LABELS = {
    none: "No Transaction ID submitted yet",
    awaiting_verification: "Awaiting admin verification",
    verified: "Verified — payment received",
    rejected: "Rejected — submit a new Transaction ID",
  };

  // Owner-scoped verification state for the open order detail. Read-only:
  // this page never submits or verifies anything.
  function loadManualPaymentState(order) {
    var el = document.getElementById("detail-payment-state");
    if (!el) return;
    el.textContent = "—";
    if (!order || !order.id) return;

    fetch("/api/payments/order/" + encodeURIComponent(order.id), {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { response: response, body: body };
        });
      })
      .then(function (result) {
        if (
          !result.response.ok ||
          !result.body ||
          !result.body.success ||
          !result.body.data
        ) {
          return;
        }
        var label = MANUAL_PAYMENT_LABELS[result.body.data.status];
        el.textContent = label || "—";
      })
      .catch(function () {
        el.textContent = "—";
      });
  }

  function loadOrderDetail(orderId) {
    var detail = document.getElementById("order-detail");
    var dl = document.getElementById("order-detail-dl");
    var status = document.getElementById("order-detail-status");
    var note = document.getElementById("order-detail-note");
    if (!detail) return;

    currentDetailOrderId = orderId;
    detail.hidden = false;
    if (dl) dl.hidden = true;
    if (note) note.hidden = true;
    var paymentState = document.getElementById("detail-payment-state");
    if (paymentState) paymentState.textContent = "—";
    hideDashBkash();
    setStatusEl(status, "Loading order…", "loading");
    detail.setAttribute("tabindex", "-1");
    detail.focus();

    fetch("/api/orders/" + encodeURIComponent(orderId), {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { response: response, body: body };
        });
      })
      .then(function (result) {
        if (
          !result.response.ok ||
          !result.body ||
          !result.body.success ||
          !result.body.data
        ) {
          setStatusEl(status, "Order not found.", "error");
          return;
        }
        var order = result.body.data;
        setStatusEl(status, "", null);
        setText("detail-order-number", order.orderNumber);
        setStatusBadge(document.getElementById("detail-status"), order.status);
        setText(
          "detail-product-type",
          order.productType === "vps" ? "VPS Plan" : "Web Hosting Plan"
        );
        setText(
          "detail-plan",
          order.plan && order.plan.name
            ? order.plan.name +
                (order.plan.slug ? " (" + order.plan.slug + ")" : "")
            : "Plan unavailable"
        );
        setText(
          "detail-amount",
          formatMoney(order.currency, order.amount)
        );
        setText("detail-billing", titleCase(order.billingCycle));
        setText("detail-created", formatDate(order.createdAt));
        if (dl) dl.hidden = false;
        if (note) {
          if (order.status === "awaiting_payment") {
            note.textContent = AWAITING_NOTE;
            note.hidden = false;
          } else {
            note.hidden = true;
          }
        }
        loadManualPaymentState(order);
        loadDashBkash(order);
      })
      .catch(function () {
        setStatusEl(status, "Unable to reach the server. Please try again.", "error");
      });
  }

  function hideDashBkash() {
    var card = document.getElementById("dash-bkash-instructions");
    if (card) card.hidden = true;
  }

  // Instruction card is shown only for an awaiting_payment order and only
  // with values returned by the server; any fetch problem hides it instead
  // of showing stale or guessed values. There is no mark-paid control.
  function loadDashBkash(order) {
    var card = document.getElementById("dash-bkash-instructions");
    var note = document.getElementById("order-detail-note");
    if (!card) return;
    if (!order || order.status !== "awaiting_payment" || !order.id) {
      card.hidden = true;
      return;
    }

    var statusEl = document.getElementById("dash-bkash-status");
    setStatusEl(statusEl, "", null);
    setText("dash-bkash-receiver", "—");
    setText("dash-bkash-amount", formatMoney(order.currency, order.amount));
    setText("dash-bkash-order-number", order.orderNumber);
    card.hidden = false;

    fetch("/api/orders/" + encodeURIComponent(order.id) + "/bkash-instructions", {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { response: response, body: body };
        });
      })
      .then(function (result) {
        var body = result.body;
        if (
          result.response.ok &&
          body &&
          body.success &&
          body.data
        ) {
          setText("dash-bkash-receiver", body.data.receiverNumber);
          setStatusEl(statusEl, "", null);
          return;
        }
        var code = body && body.error && body.error.code;
        var message =
          body && body.error && body.error.message
            ? body.error.message
            : "bKash payment is not available right now.";
        if (
          code === "PAYMENT_PROVIDER_NOT_CONFIGURED" ||
          code === "BKASH_PAYMENT_NOT_CONFIGURED"
        ) {
          message = "bKash payment is not available yet for this order.";
        }
        card.hidden = true;
        if (note && note.hidden === false) note.textContent = message;
      })
      .catch(function () {
        card.hidden = true;
        if (note && note.hidden === false) {
          note.textContent =
            "Unable to load bKash instructions. Please try again.";
        }
      });
  }

  function maybeLoadOrderFromQuery() {
    var params = new URLSearchParams(window.location.search);
    var orderId = params.get("order");
    if (orderId && currentSectionFromHash() === "orders") {
      loadOrderDetail(orderId);
    }
  }

  var ordersPrev = document.getElementById("orders-prev");
  var ordersNext = document.getElementById("orders-next");
  var orderDetailClose = document.getElementById("order-detail-close");

  if (ordersPrev) {
    ordersPrev.addEventListener("click", function () {
      if (ordersState.page > 1) loadOrders(ordersState.page - 1);
    });
  }
  if (ordersNext) {
    ordersNext.addEventListener("click", function () {
      if (ordersState.page < ordersState.totalPages) {
        loadOrders(ordersState.page + 1);
      }
    });
  }
  if (orderDetailClose) {
    orderDetailClose.addEventListener("click", function () {
      var detail = document.getElementById("order-detail");
      if (detail) detail.hidden = true;
      hideDashBkash();
      currentDetailOrderId = null;
      if (window.location.search) {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + "#orders"
        );
      }
      var list = document.getElementById("orders-list");
      if (list) list.focus && list.focus();
    });
  }

  var dashBkashCheck = document.getElementById("dash-bkash-check-status");
  var dashBkashHide = document.getElementById("dash-bkash-hide");

  if (dashBkashCheck) {
    dashBkashCheck.addEventListener("click", function () {
      if (currentDetailOrderId) loadOrderDetail(currentDetailOrderId);
    });
  }
  if (dashBkashHide) {
    dashBkashHide.addEventListener("click", hideDashBkash);
  }

  var paymentsPrev = document.getElementById("payments-prev");
  var paymentsNext = document.getElementById("payments-next");

  if (paymentsPrev) {
    paymentsPrev.addEventListener("click", function () {
      if (paymentsState.page > 1) loadPayments(paymentsState.page - 1);
    });
  }
  if (paymentsNext) {
    paymentsNext.addEventListener("click", function () {
      if (paymentsState.page < paymentsState.totalPages) {
        loadPayments(paymentsState.page + 1);
      }
    });
  }

  // ---------- payments (billing) ----------

  var PAYMENT_STATUS_LABELS = {
    initiated: "Initiated",
    pending: "Pending",
    successful: "Successful",
    failed: "Failed",
    cancelled: "Cancelled",
    expired: "Expired",
    refunded: "Refunded",
  };

  var PAYMENT_STATUS_CLASSES = {
    initiated: "order-status-awaiting",
    pending: "order-status-pending",
    successful: "order-status-paid",
    failed: "order-status-failed",
    cancelled: "order-status-cancelled",
    expired: "order-status-cancelled",
    refunded: "order-status-refunded",
  };

  var paymentsState = {
    page: 1,
    total: 0,
    totalPages: 1,
    limit: 5,
    loading: false,
  };

  function paymentStatusLabel(status) {
    return PAYMENT_STATUS_LABELS[status] || titleCase(status) || "—";
  }

  function paymentStatusClass(status) {
    return PAYMENT_STATUS_CLASSES[status] || "";
  }

  function renderPaymentCard(payment) {
    var card = document.createElement("article");
    card.className = "order-card payment-card";

    var top = document.createElement("div");
    top.className = "order-card-top";

    var number = document.createElement("h3");
    number.className = "order-number";
    number.textContent = payment.orderNumber || payment.orderId || "Payment";

    var badge = document.createElement("span");
    badge.textContent = paymentStatusLabel(payment.status);
    badge.className = "order-status " + paymentStatusClass(payment.status);

    top.appendChild(number);
    top.appendChild(badge);

    var meta = document.createElement("div");
    meta.className = "payment-meta";

    var provider = document.createElement("span");
    provider.className = "payment-provider";
    provider.textContent = "Provider: " + titleCase(payment.provider);

    var amount = document.createElement("span");
    amount.className = "order-amount";
    amount.textContent = formatMoney(payment.currency, payment.amount);

    var date = document.createElement("time");
    date.className = "order-date";
    var when = payment.initiatedAt || payment.createdAt || "";
    date.dateTime = when;
    date.textContent = formatDate(when);

    meta.appendChild(provider);
    meta.appendChild(amount);
    meta.appendChild(date);

    var view = document.createElement("a");
    view.className = "btn btn-outline btn-sm";
    view.href =
      "/dashboard?order=" +
      encodeURIComponent(payment.orderId) +
      "#orders";
    view.textContent = "View Order";

    card.appendChild(top);
    card.appendChild(meta);
    card.appendChild(view);
    return card;
  }

  function updatePaymentsPagination() {
    var nav = document.getElementById("payments-pagination");
    var info = document.getElementById("payments-page-info");
    var prev = document.getElementById("payments-prev");
    var next = document.getElementById("payments-next");
    if (!nav) return;

    if (paymentsState.total <= paymentsState.limit) {
      nav.hidden = true;
      return;
    }

    nav.hidden = false;
    if (info) {
      info.textContent =
        "Page " + paymentsState.page + " of " + paymentsState.totalPages;
    }
    if (prev) prev.disabled = paymentsState.page <= 1;
    if (next) next.disabled = paymentsState.page >= paymentsState.totalPages;
  }

  async function loadPayments(page) {
    var list = document.getElementById("payments-list");
    var empty = document.getElementById("payments-empty");
    var status = document.getElementById("billing-status");

    paymentsState.page = Math.max(1, Math.floor(Number(page) || 1));
    if (paymentsState.loading) return;
    paymentsState.loading = true;

    setStatusEl(status, "Loading payments…", "loading");
    if (list) list.replaceChildren();
    if (empty) empty.hidden = true;

    try {
      var url =
        "/api/payments?page=" +
        paymentsState.page +
        "&limit=" +
        (paymentsState.limit || 5);
      var response = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        window.location.replace(
          "/login?return=" + encodeURIComponent("/dashboard#billing")
        );
        return;
      }

      if (
        !response.ok ||
        !body ||
        !body.success ||
        !body.data ||
        !Array.isArray(body.data.payments)
      ) {
        setStatusEl(
          status,
          "Unable to load payments. Please try again.",
          "error"
        );
        return;
      }

      var payments = body.data.payments;
      var pagination = body.data.pagination || {};
      paymentsState.total = pagination.total || 0;
      paymentsState.totalPages = pagination.totalPages || 1;
      paymentsState.page = pagination.page || paymentsState.page;
      paymentsState.limit = pagination.limit || paymentsState.limit || 5;

      setStatusEl(status, "", null);

      if (payments.length === 0) {
        if (empty) empty.hidden = false;
        if (list) list.replaceChildren();
        updatePaymentsPagination();
        return;
      }

      var wrapper = document.createElement("div");
      wrapper.className = "payment-list";
      payments.forEach(function (payment) {
        wrapper.appendChild(renderPaymentCard(payment));
      });
      if (list) list.appendChild(wrapper);
      updatePaymentsPagination();
    } catch (err) {
      setStatusEl(
        status,
        "Unable to reach the server. Please try again.",
        "error"
      );
    } finally {
      paymentsState.loading = false;
    }
  }

  // ---------- logout ----------

  async function handleLogout(event) {
    var btn = event.currentTarget;
    btn.disabled = true;
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      // best effort — redirect regardless
    }
    window.location.href = "/login";
  }

  var logoutBtn = document.getElementById("logout-button");
  var sidebarLogout = document.getElementById("sidebar-logout");
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
  if (sidebarLogout) sidebarLogout.addEventListener("click", handleLogout);

  // ---------- auth gate ----------

  async function boot() {
    hideStatus();
    try {
      var response = await fetch("/api/auth/me", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        var returnTo = "/dashboard";
        if (window.location.hash) {
          returnTo += window.location.hash;
        }
        window.location.replace(
          "/login?return=" + encodeURIComponent(returnTo)
        );
        return;
      }

      if (!response.ok || !body || !body.success || !body.data || !body.data.user) {
        showStatus(
          "Unable to load your account. Please try again.",
          "error"
        );
        return;
      }

      populateAccount(body.data.user);
      root.hidden = false;
      ensureServicesLoaded();
      showSection(currentSectionFromHash());
      maybeLoadOrderFromQuery();
    } catch (err) {
      showStatus("Unable to reach the server. Please try again.", "error");
    }
  }

  boot();
})();
