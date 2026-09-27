/**
 * Client branding + public site configuration.
 * ---------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for the client brand.
 * Change the values in window.CLIENT_BRAND below and every brand touchpoint on
 * the public pages (navbar, footer, document title, canonical URL) follows.
 *
 * The HTML contains the same placeholder values only as a no-JS fallback —
 * edit them here, not in the markup.
 */
(function () {
  "use strict";

  window.CLIENT_BRAND = {
    // Display name shown in the navbar / footer.
    name: "ARC HOST",
    // Short form used where space is tight (initials, compact labels).
    shortName: "ARC",
    // Marketing tagline used in the footer + meta description fallbacks.
    tagline: "Minecraft, web, and VPS hosting on one platform",
    /**
     * Absolute origin of the deployed site, e.g. "https://example.com".
     * Leave empty ("") while the final domain is undecided — canonical tags
     * then stay relative to the current origin (no invented domain, no
     * inherited third-party domain). Set it once here when the real domain is
     * supplied and every page picks it up.
     */
    origin: ""
  };

  function applyBrand() {
    var brand = window.CLIENT_BRAND || {};
    var name = brand.name || "";
    var shortName = brand.shortName || name;
    var tagline = brand.tagline || "";
    var initial = (shortName || name).trim().charAt(0).toUpperCase() || "C";

    var nodes = document.querySelectorAll(
      "[data-brand-name], [data-brand-short], [data-brand-tagline], [data-brand-initial]"
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.hasAttribute("data-brand-name")) el.textContent = name;
      if (el.hasAttribute("data-brand-short")) el.textContent = shortName;
      if (el.hasAttribute("data-brand-tagline")) el.textContent = tagline;
      if (el.hasAttribute("data-brand-initial")) el.textContent = initial;
    }

    // Accessible labels that embed the brand.
    var labelNodes = document.querySelectorAll("[data-brand-label]");
    for (var j = 0; j < labelNodes.length; j++) {
      labelNodes[j].setAttribute(
        "aria-label",
        labelNodes[j].getAttribute("data-brand-label").replace("{brand}", name)
      );
    }

    // Document title: "<page title> | <brand>".
    var page = document.body && document.body.getAttribute("data-page-title");
    if (page) {
      document.title = page + " | " + name;
    }

    // Canonical URL — relative unless an origin has been configured above.
    var canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      var origin = (brand.origin || "").replace(/\/+$/, "");
      if (origin) {
        canonical.setAttribute(
          "href",
          origin + (window.location.pathname || "/")
        );
      } else {
        canonical.setAttribute(
          "href",
          window.location.pathname || "/"
        );
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyBrand);
  } else {
    applyBrand();
  }
})();
