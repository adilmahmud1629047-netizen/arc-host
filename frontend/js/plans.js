(function () {
  "use strict";

  function billingPeriodLabel(cycle) {
    if (cycle === "yearly") return "/yr";
    if (cycle === "quarterly") return "/qtr";
    return "/mo";
  }

  function formatPrice(plan) {
    var currency = plan.currency || "BDT";
    var price = plan.price != null ? String(plan.price) : "0.00";
    if (currency === "BDT") {
      return "৳" + price.replace(/\.00$/, "");
    }
    return currency + " " + price;
  }

  function unlimited(value, suffix) {
    if (value === null || value === undefined) return "Unlimited";
    if (suffix) return value + " " + suffix;
    return String(value);
  }

  function formatRam(ramMb) {
    if (ramMb === null || ramMb === undefined) return "Unlimited";
    if (ramMb >= 1024) {
      var gb = ramMb / 1024;
      return (Number.isInteger(gb) ? gb : gb.toFixed(1)) + " GB";
    }
    return ramMb + " MB";
  }

  function formatBandwidth(bandwidthGb) {
    if (bandwidthGb === null || bandwidthGb === undefined) return "Unlimited";
    return bandwidthGb + " GB / mo";
  }

  function isValidSlug(slug) {
    return (
      typeof slug === "string" &&
      slug.length > 0 &&
      slug.length <= 100 &&
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)
    );
  }

  function isValidType(type) {
    return type === "hosting" || type === "vps";
  }

  async function fetchJson(path) {
    var response = await fetch(path, { headers: { Accept: "application/json" } });
    var body = null;
    try {
      body = await response.json();
    } catch (err) {
      body = null;
    }
    return { ok: response.ok, status: response.status, body: body };
  }

  async function fetchPlans(type, category) {
    if (!isValidType(type)) {
      throw new Error("invalid type");
    }
    var url = "/api/plans/" + type;
    if (category) {
      url += "?category=" + encodeURIComponent(category);
    }
    var result = await fetchJson(url);
    if (!result.ok || !result.body || !result.body.success) {
      throw new Error("request failed");
    }
    return result.body.data;
  }

  async function fetchPlan(type, slug) {
    if (!isValidType(type) || !isValidSlug(slug)) {
      return { ok: false, reason: "invalid" };
    }
    var result = await fetchJson(
      "/api/plans/" + type + "/" + encodeURIComponent(slug)
    );
    if (result.ok && result.body && result.body.success && result.body.data) {
      return { ok: true, plan: result.body.data };
    }
    if (result.status === 400) return { ok: false, reason: "invalid" };
    if (result.status === 404) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "error" };
  }

  function setStatus(el, message, kind) {
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
    el.classList.remove("cx-status-msg--error", "cx-status-msg--empty");
    if (kind === "error") el.classList.add("cx-status-msg--error");
    if (kind === "empty") el.classList.add("cx-status-msg--empty");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function hostingFeatures(plan) {
    return [
      { label: "Websites", value: unlimited(plan.domains) },
      { label: "Storage", value: plan.storageGb + " GB" },
      { label: "Bandwidth", value: formatBandwidth(plan.bandwidthGb) },
      { label: "Email accounts", value: unlimited(plan.emailAccounts) },
      { label: "SSL", value: plan.ssl ? "Included" : "Not included" },
      { label: "Databases", value: unlimited(plan.databases) },
    ];
  }

  function vpsFeatures(plan) {
    return [
      {
        label: "vCPU",
        value:
          plan.cpuCores + (plan.cpuCores === 1 ? " core" : " cores"),
      },
      { label: "RAM", value: formatRam(plan.ramMb) },
      { label: "Storage", value: plan.storageGb + " GB" },
      { label: "Bandwidth", value: formatBandwidth(plan.bandwidthGb) },
      { label: "IPv4 addresses", value: String(plan.ipv4Addresses) },
    ];
  }

  // Purchase CTAs always target checkout directly. auth-nav gates the href:
  // anonymous visitors get /login?next=<encoded target>, signed-in visitors
  // keep the checkout target.
  function purchaseHref(type, slug) {
    return (
      "/checkout?type=" + type + "&plan=" + encodeURIComponent(slug)
    );
  }

  function purchaseCtaHtml(type, slug, caption, extraClass) {
    var target = purchaseHref(type, slug);
    return (
      '<a class="' +
      extraClass +
      '" data-purchase-cta data-purchase-href="' +
      escapeHtml(target) +
      '" href="' +
      escapeHtml(target) +
      '">' +
      caption +
      "</a>"
    );
  }

  function refreshAuthGates() {
    if (
      window.FlareAuthNav &&
      typeof window.FlareAuthNav.refresh === "function"
    ) {
      window.FlareAuthNav.refresh();
    }
  }

  function planCardHtml(plan, type, featured) {
    var features = type === "vps" ? vpsFeatures(plan) : hostingFeatures(plan);
    var featureRows = features
      .map(function (item) {
        return (
          "<li><span>" +
          escapeHtml(item.label) +
          "</span><strong>" +
          escapeHtml(item.value) +
          "</strong></li>"
        );
      })
      .join("");

    var ctaHref = purchaseHref(type, plan.slug);
    var fallbackCaption =
      type === "vps"
        ? "VPS configuration from the catalog."
        : "Web hosting plan from the catalog.";

    return (
      '<article class="cx-plan' +
      (featured ? " cx-plan--featured" : "") +
      '">' +
      (featured ? '<span class="cx-plan-badge">Popular</span>' : "") +
      '<div class="cx-plan-head">' +
      '<h3 class="cx-plan-name">' +
      escapeHtml(plan.name) +
      "</h3>" +
      '<span class="cx-plan-cycle-tag">' +
      escapeHtml(billingPeriodLabel(plan.billingCycle)) +
      "</span>" +
      "</div>" +
      '<p class="cx-plan-desc">' +
      escapeHtml(plan.description || fallbackCaption) +
      "</p>" +
      '<div class="cx-plan-price">' +
      '<span class="cx-plan-amount">' +
      escapeHtml(formatPrice(plan)) +
      "</span>" +
      '<span class="cx-plan-cycle">' +
      escapeHtml(billingPeriodLabel(plan.billingCycle)) +
      "</span>" +
      "</div>" +
      '<ul class="cx-plan-specs">' +
      featureRows +
      "</ul>" +
      '<a class="cx-btn cx-btn--outline cx-btn--block" data-purchase-cta data-purchase-href="' +
      escapeHtml(ctaHref) +
      '" href="' +
      escapeHtml(ctaHref) +
      '">Choose ' +
      escapeHtml(plan.name) +
      "</a>" +
      "</article>"
    );
  }

  function renderCards(container, plans, type) {
    if (!container) return;
    container.innerHTML = plans
      .map(function (plan) {
        // "Popular" is data-driven: the admin flags products with the popular
        // field (no position heuristics).
        var featured = plan.popular === true;
        return planCardHtml(plan, type, featured);
      })
      .join("");
  }

  function renderCompareTable(table, plans, type) {
    if (!table) return;
    var thead = table.querySelector("thead");
    var tbody = table.querySelector("tbody");
    if (!thead || !tbody) return;

    var featureLabel = type === "vps" ? "Specification" : "Feature";

    thead.innerHTML =
      '<tr><th scope="col">' +
      featureLabel +
      "</th>" +
      plans
        .map(function (p) {
          return '<th scope="col">' + escapeHtml(p.name) + "</th>";
        })
        .join("") +
      "</tr>";

    var rows =
      type === "vps"
        ? [
            {
              label: "Price",
              get: function (p) {
                return (
                  formatPrice(p) + " " + billingPeriodLabel(p.billingCycle)
                );
              },
            },
            {
              label: "vCPU cores",
              get: function (p) {
                return String(p.cpuCores);
              },
            },
            {
              label: "RAM",
              get: function (p) {
                return formatRam(p.ramMb);
              },
            },
            {
              label: "Storage",
              get: function (p) {
                return p.storageGb + " GB";
              },
            },
            {
              label: "Bandwidth",
              get: function (p) {
                return formatBandwidth(p.bandwidthGb);
              },
            },
            {
              label: "IPv4 addresses",
              get: function (p) {
                return String(p.ipv4Addresses);
              },
            },
            {
              label: "Get started",
              get: function (p) {
                return purchaseCtaHtml(
                  "vps",
                  p.slug,
                  "Choose",
                  "cx-btn cx-btn--outline cx-btn--sm"
                );
              },
            },
          ]
        : [
            {
              label: "Price",
              get: function (p) {
                return (
                  formatPrice(p) + " " + billingPeriodLabel(p.billingCycle)
                );
              },
            },
            {
              label: "Websites",
              get: function (p) {
                return unlimited(p.domains);
              },
            },
            {
              label: "Storage",
              get: function (p) {
                return p.storageGb + " GB";
              },
            },
            {
              label: "Bandwidth",
              get: function (p) {
                return formatBandwidth(p.bandwidthGb);
              },
            },
            {
              label: "Email accounts",
              get: function (p) {
                return unlimited(p.emailAccounts);
              },
            },
            {
              label: "Databases",
              get: function (p) {
                return unlimited(p.databases);
              },
            },
            {
              label: "SSL",
              get: function (p) {
                return p.ssl ? "Included" : "Not included";
              },
            },
            {
              label: "Get started",
              get: function (p) {
                return purchaseCtaHtml(
                  "hosting",
                  p.slug,
                  "Choose",
                  "cx-btn cx-btn--outline cx-btn--sm"
                );
              },
            },
          ];

    tbody.innerHTML = rows
      .map(function (row) {
        return (
          '<tr><th scope="row">' +
          escapeHtml(row.label) +
          "</th>" +
          plans
            .map(function (p) {
              return "<td>" + row.get(p) + "</td>";
            })
            .join("") +
          "</tr>"
        );
      })
      .join("");
  }

  function renderEmpty(container, statusEl) {
    if (container) container.innerHTML = "";
    setStatus(statusEl, "Plans are currently unavailable.", "empty");
  }

  function renderError(statusEl) {
    setStatus(
      statusEl,
      "Unable to load plans. Please try again later.",
      "error"
    );
  }

  async function loadPlans(type) {
    var grid = document.getElementById("plans-grid");
    var statusEl = document.getElementById("plans-status");
    var table = document.getElementById("plans-compare");
    var root = document.getElementById("plans-root");
    var category = root ? root.getAttribute("data-category") : null;

    setStatus(statusEl, "Loading plans…", "loading");
    if (grid) grid.innerHTML = "";

    try {
      var plans = await fetchPlans(type, category);
      if (!Array.isArray(plans)) {
        renderError(statusEl);
        return;
      }
      if (plans.length === 0) {
        renderEmpty(grid, statusEl);
        if (table) table.hidden = true;
        return;
      }

      setStatus(statusEl, "", null);
      renderCards(grid, plans, type);
      if (table) {
        table.hidden = false;
        renderCompareTable(table, plans, type);
      }
      refreshAuthGates();
    } catch (err) {
      renderError(statusEl);
    }
  }

  window.FlareCatalog = {
    billingPeriodLabel: billingPeriodLabel,
    formatPrice: formatPrice,
    unlimited: unlimited,
    formatRam: formatRam,
    formatBandwidth: formatBandwidth,
    isValidSlug: isValidSlug,
    isValidType: isValidType,
    fetchPlans: fetchPlans,
    fetchPlan: fetchPlan,
  };

  var root = document.getElementById("plans-root");
  if (root) {
    var type = root.getAttribute("data-plan-type") || "hosting";
    loadPlans(type);
  }
})();
