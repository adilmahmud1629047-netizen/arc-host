(function () {
  "use strict";

  var initialized = false;
  var authResolved = false;
  var authInflight = null;
  var lastAuth = false;

  function purchaseTarget(el) {
    return el.getAttribute("data-purchase-href") || "";
  }

  function purchaseHref(el, loggedIn) {
    var target = purchaseTarget(el);
    if (!target) return el.getAttribute("href") || "/register";
    if (loggedIn) return target;
    return "/login?next=" + encodeURIComponent(target);
  }

  function applyPurchaseCta(loggedIn) {
    var hooks = document.querySelectorAll("[data-purchase-cta]");
    for (var i = 0; i < hooks.length; i++) {
      hooks[i].setAttribute("href", purchaseHref(hooks[i], loggedIn));
    }
  }

  function applyAuthCta(loggedIn) {
    lastAuth = loggedIn;
    var hooks = document.querySelectorAll('[data-auth-cta="get-started"]');
    var href = loggedIn ? "/dashboard" : "/register";
    for (var i = 0; i < hooks.length; i++) {
      hooks[i].setAttribute("href", href);
    }
    applyPurchaseCta(loggedIn);
  }

  function followAnchor(href) {
    var link = document.createElement("a");
    link.href = href;
    link.click();
  }

  function syncAuthNav() {
    if (initialized) return authInflight;
    initialized = true;

    var container = document.querySelector("[data-auth-nav]");
    var hasCta = document.querySelector(
      '[data-auth-cta="get-started"], [data-purchase-cta]'
    );

    if (!container && !hasCta) {
      authResolved = true;
      return Promise.resolve();
    }

    var anon = container ? container.querySelector("[data-auth-anon]") : null;
    var user = container ? container.querySelector("[data-auth-user]") : null;

    authInflight = (async function () {
      try {
        var response = await fetch("/api/auth/me", {
          credentials: "include",
          headers: { Accept: "application/json" },
        });

        // Only an explicit 200 may switch the public navbar to authenticated UI.
        // 401, 5xx, and other statuses leave the anonymous controls unchanged
        // and keep the safe signup CTA destination (register.html).
        if (response.status === 200) {
          if (anon) anon.hidden = true;
          if (user) user.hidden = false;
          applyAuthCta(true);
        } else {
          applyAuthCta(false);
        }
      } catch (err) {
        // Network failure is not proof of logout. Keep anonymous UI.
        // Safe default signup destination remains register.html.
        // No redirect, no logout, no cookie changes.
        applyAuthCta(false);
      } finally {
        authResolved = true;
      }
    })();

    return authInflight;
  }

  // If the user clicks before /me resolves, wait then follow the updated href
  // so we never briefly land on register.html while authenticated. Purchase
  // CTAs additionally route anonymous visitors through the login gate with a
  // safe same-origin next target, so purchase context survives sign-in.
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var cta = target.closest(
      '[data-auth-cta="get-started"], [data-purchase-cta]'
    );
    if (!cta) return;
    var isPurchase = cta.hasAttribute("data-purchase-cta");

    if (!authResolved) {
      event.preventDefault();
      var pending = authInflight || syncAuthNav();
      pending.then(function () {
        followAnchor(
          isPurchase
            ? purchaseHref(cta, lastAuth)
            : cta.getAttribute("href") || "/register"
        );
      });
      return;
    }

    if (isPurchase && !lastAuth && purchaseTarget(cta)) {
      event.preventDefault();
      followAnchor(purchaseHref(cta, false));
    }
  });

  // Pages that render CTAs after this script (plan cards, configurator) call
  // refresh() so rest-state hrefs match the resolved auth state.
  window.FlareAuthNav = {
    ready: function () {
      if (!initialized) syncAuthNav();
      return authInflight || Promise.resolve();
    },
    isLoggedIn: function () {
      return lastAuth;
    },
    refresh: function () {
      if (authResolved) applyAuthCta(lastAuth);
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncAuthNav);
  } else {
    syncAuthNav();
  }
})();
