/**
 * Minecraft hosting page behaviour:
 *   1. Configurator UI (application chips + plan chips + live summary)
 *   2. Pricing cards rendered from the server catalog (no hard-coded prices)
 *
 * Endpoint: GET /api/plans/hosting?category=minecraft
 * Reuses the shared catalog helpers exposed by /js/plans.js (window.FlareCatalog)
 * so price/currency formatting stays consistent with the other product pages.
 */
(function () {
  "use strict";

  var catalog = window.FlareCatalog || null;
  var CATALOG_TYPE = "hosting";
  var CATALOG_CATEGORY = "minecraft";
  var CATALOG_PATH = "/api/plans/hosting?category=minecraft";

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function periodLabel(cycle) {
    if (catalog && catalog.billingPeriodLabel) {
      return catalog.billingPeriodLabel(cycle);
    }
    if (cycle === "yearly") return "/yr";
    if (cycle === "quarterly") return "/qtr";
    return "/mo";
  }

  function formatPrice(plan) {
    if (catalog && catalog.formatPrice) return catalog.formatPrice(plan);
    var currency = plan.currency || "BDT";
    var price = plan.price != null ? String(plan.price) : "0.00";
    if (currency === "BDT") return "৳" + price.replace(/\.00$/, "");
    return currency + " " + price;
  }

  function formatRam(ramMb) {
    if (catalog && catalog.formatRam) return catalog.formatRam(ramMb);
    if (ramMb === null || ramMb === undefined) return "Unlimited";
    if (ramMb >= 1024) {
      var gb = ramMb / 1024;
      return (Number.isInteger(gb) ? gb : gb.toFixed(1)) + " GB";
    }
    return ramMb + " MB";
  }

  function formatBandwidth(value) {
    if (catalog && catalog.formatBandwidth) return catalog.formatBandwidth(value);
    if (value === null || value === undefined) return "Unlimited";
    return value + " GB / mo";
  }

  function unlimited(value) {
    if (value === null || value === undefined) return "Unlimited";
    return String(value);
  }

  function planRows(plan) {
    var rows = [];

    if (typeof plan.cpuCores === "number") {
      rows.push({
        label: "CPU",
        value: plan.cpuCores + (plan.cpuCores === 1 ? " core" : " cores"),
        key: true,
      });
    }
    if (typeof plan.ramMb === "number") {
      rows.push({ label: "RAM", value: formatRam(plan.ramMb), key: true });
    }
    rows.push({
      label: "Storage",
      value:
        plan.storageGb === null || plan.storageGb === undefined
          ? "Unlimited"
          : plan.storageGb + " GB",
      key: true,
    });
    rows.push({
      label: "Bandwidth",
      value: formatBandwidth(plan.bandwidthGb),
      key: true,
    });

    if ("domains" in plan) {
      rows.push({ label: "Websites", value: unlimited(plan.domains) });
    }
    if ("databases" in plan) {
      rows.push({ label: "Databases", value: unlimited(plan.databases) });
    }
    if (typeof plan.ssl === "boolean") {
      rows.push({ label: "SSL", value: plan.ssl ? "Included" : "Not included" });
    }
    if (typeof plan.ipv4Addresses === "number") {
      rows.push({ label: "IPv4", value: String(plan.ipv4Addresses) });
    }

    return rows;
  }

  function resourceSummary(plan) {
    return planRows(plan)
      .filter(function (row) {
        return row.key;
      })
      .map(function (row) {
        return row.label + " " + row.value;
      })
      .join(" · ");
  }

  function ctaHref(plan) {
    return (
      "/checkout?type=" +
      CATALOG_TYPE +
      "&plan=" +
      encodeURIComponent(plan.slug)
    );
  }

  // auth-nav gates purchase CTAs: anonymous visitors get
  // /login?next=<encoded target>, signed-in visitors keep the target.
  function applyPurchaseGate(el, target) {
    if (!el) return;
    el.setAttribute("data-purchase-cta", "");
    el.setAttribute("data-purchase-href", target);
    el.setAttribute("href", target);
    if (
      window.FlareAuthNav &&
      typeof window.FlareAuthNav.refresh === "function"
    ) {
      window.FlareAuthNav.refresh();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Catalog loading                                                     */
  /* ------------------------------------------------------------------ */

  async function loadPlans() {
    if (catalog && typeof catalog.fetchPlans === "function") {
      return await catalog.fetchPlans(CATALOG_TYPE, CATALOG_CATEGORY);
    }
    var response = await fetch(CATALOG_PATH, {
      headers: { Accept: "application/json" },
    });
    var body = null;
    try {
      body = await response.json();
    } catch (err) {
      body = null;
    }
    if (!response.ok || !body || !body.success || !Array.isArray(body.data)) {
      throw new Error("catalog request failed");
    }
    return body.data;
  }

  /* ------------------------------------------------------------------ */
  /* Status messaging                                                    */
  /* ------------------------------------------------------------------ */

  function setStatus(message, kind) {
    var el = document.getElementById("pricing-status");
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
    el.classList.remove("cx-status-msg--error", "cx-status-msg--empty");
    if (kind === "error") el.classList.add("cx-status-msg--error");
    if (kind === "empty") el.classList.add("cx-status-msg--empty");
  }

  /* ------------------------------------------------------------------ */
  /* Pricing cards                                                       */
  /* ------------------------------------------------------------------ */

  function planCardHtml(plan, featured) {
    var rows = planRows(plan)
      .map(function (row) {
        return (
          "<li><span>" +
          escapeHtml(row.label) +
          "</span><strong>" +
          escapeHtml(row.value) +
          "</strong></li>"
        );
      })
      .join("");

    return (
      '<article class="cx-plan' +
      (featured ? " cx-plan--featured" : "") +
      '">' +
      (featured
        ? '<span class="cx-plan-badge">Popular</span>'
        : "") +
      '<div class="cx-plan-head">' +
      '<h3 class="cx-plan-name">' +
      escapeHtml(plan.name) +
      "</h3>" +
      '<span class="cx-plan-cycle-tag">' +
      escapeHtml(periodLabel(plan.billingCycle)) +
      "</span>" +
      "</div>" +
      '<p class="cx-plan-desc">' +
      escapeHtml(plan.description || "Minecraft hosting plan.") +
      "</p>" +
      '<div class="cx-plan-price">' +
      '<span class="cx-plan-amount">' +
      escapeHtml(formatPrice(plan)) +
      "</span>" +
      '<span class="cx-plan-cycle">' +
      escapeHtml(periodLabel(plan.billingCycle)) +
      "</span>" +
      "</div>" +
      '<ul class="cx-plan-specs">' +
      rows +
      "</ul>" +
      '<a class="cx-btn cx-btn--outline cx-btn--block" data-purchase-cta data-purchase-href="' +
      escapeHtml(ctaHref(plan)) +
      '" href="' +
      escapeHtml(ctaHref(plan)) +
      '">Choose ' +
      escapeHtml(plan.name) +
      "</a>" +
      "</article>"
    );
  }

  function renderPricing(plans) {
    var grid = document.getElementById("pricing-grid");
    if (!grid) return;

    var middle = Math.floor(plans.length / 2);
    grid.innerHTML = plans
      .map(function (plan, index) {
        var featured =
          plans.length >= 3
            ? index === middle
            : plans.length === 2
              ? index === 1
              : false;
        return planCardHtml(plan, featured);
      })
      .join("");
  }

  /* ------------------------------------------------------------------ */
  /* Configurator                                                        */
  /* ------------------------------------------------------------------ */

  var selectedPlan = null;

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function updateSummary() {
    var pressed = document.querySelector('#config-apps .cx-chip[aria-pressed="true"]');
    setText(
      "config-summary-app",
      pressed ? pressed.getAttribute("data-app") : "—"
    );

    if (!selectedPlan) return;
    setText("config-summary-plan", selectedPlan.name);
    setText("config-summary-resources", resourceSummary(selectedPlan));
    setText(
      "config-summary-price",
      formatPrice(selectedPlan) + " " + periodLabel(selectedPlan.billingCycle)
    );

    var cta = document.getElementById("config-cta");
    if (cta) {
      applyPurchaseGate(cta, ctaHref(selectedPlan));
      cta.textContent = "Start " + selectedPlan.name;
    }
  }

  function selectPlan(slug, plans) {
    for (var i = 0; i < plans.length; i++) {
      if (plans[i].slug === slug) {
        selectedPlan = plans[i];
        break;
      }
    }
    var chips = document.querySelectorAll("#config-plans .cx-chip");
    for (var j = 0; j < chips.length; j++) {
      chips[j].setAttribute(
        "aria-pressed",
        String(chips[j].getAttribute("data-plan") === slug)
      );
    }
    updateSummary();
  }

  function renderPlanChips(plans) {
    var wrap = document.getElementById("config-plans");
    if (!wrap) return;

    wrap.innerHTML = plans
      .map(function (plan) {
        return (
          '<button type="button" class="cx-chip" aria-pressed="false" data-plan="' +
          escapeHtml(plan.slug) +
          '">' +
          escapeHtml(plan.name) +
          ' <span class="cx-chip-price">' +
          escapeHtml(formatPrice(plan)) +
          "</span></button>"
        );
      })
      .join("");

    wrap.addEventListener("click", function (event) {
      var chip = event.target.closest ? event.target.closest(".cx-chip") : null;
      if (!chip) return;
      selectPlan(chip.getAttribute("data-plan"), plans);
    });

    var hint = document.getElementById("config-plan-hint");
    if (hint) {
      hint.textContent = plans.length + " loaded from catalog";
    }

    selectPlan(plans[0].slug, plans);
  }

  function initApps() {
    var wrap = document.getElementById("config-apps");
    if (!wrap) return;

    wrap.addEventListener("click", function (event) {
      var chip = event.target.closest ? event.target.closest(".cx-chip") : null;
      if (!chip) return;
      var buttons = wrap.querySelectorAll(".cx-chip");
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute(
          "aria-pressed",
          String(buttons[i] === chip)
        );
      }
      updateSummary();
    });
  }

  function initConfigError(message) {
    var wrap = document.getElementById("config-plans");
    if (wrap) {
      wrap.innerHTML = "";
      var note = document.createElement("p");
      note.className = "cx-config-note";
      note.textContent = message;
      wrap.appendChild(note);
    }
    setText("config-summary-plan", "Unavailable");
    setText("config-summary-resources", "—");
    setText("config-summary-price", "—");
    var hint = document.getElementById("config-plan-hint");
    if (hint) hint.textContent = "catalog unavailable";
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    initApps();

    setStatus("Loading plans from the catalog…", null);

    try {
      var plans = await loadPlans();
      if (!Array.isArray(plans)) throw new Error("unexpected payload");

      if (plans.length === 0) {
        setStatus("Plans are currently unavailable.", "empty");
        initConfigError("Plans are currently unavailable.");
        return;
      }

      setStatus("", null);
      renderPricing(plans);
      renderPlanChips(plans);
      if (
        window.FlareAuthNav &&
        typeof window.FlareAuthNav.refresh === "function"
      ) {
        window.FlareAuthNav.refresh();
      }
    } catch (err) {
      setStatus(
        "Unable to load plans right now. Please try again later.",
        "error"
      );
      initConfigError("Plan data could not be loaded.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
