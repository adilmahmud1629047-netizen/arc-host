(function () {
  "use strict";

  async function apiRequest(path, options) {
    // Explicit credentials so the session Set-Cookie is always processed
    // and the cookie is always sent, even if the page origin ever changes.
    const response = await fetch(path, { credentials: "include", ...options });
    let body = null;
    try {
      body = await response.json();
    } catch (err) {
      body = null;
    }
    return { response, body };
  }

  function showMessage(container, text, type) {
    if (!container) return;
    container.hidden = false;
    container.textContent = text;
    container.classList.remove("form-status-error", "form-status-success");
    container.classList.add(
      type === "success" ? "form-status-success" : "form-status-error"
    );
    container.setAttribute("role", type === "success" ? "status" : "alert");
    container.focus();
  }

  function clearMessage(container) {
    if (!container) return;
    container.hidden = true;
    container.textContent = "";
  }

  function errorFromResponse(body, fallback) {
    if (!body || !body.error) return fallback;
    const details =
      body.error.details && body.error.details.length
        ? body.error.details.join(" ")
        : "";
    if (details) return details;
    return body.error.message || fallback;
  }

  // Same-origin clean path only: must start with a single "/", no protocol,
  // no host (//evil), no backslash tricks, no whitespace/control characters.
  // Query strings and hashes are allowed so /checkout?type=..&plan=.. and
  // /dashboard#services survive the sign-in round trip.
  function isSafeReturnPath(value) {
    if (typeof value !== "string" || !value || value.length > 2048) {
      return false;
    }
    if (value.charAt(0) !== "/" || value.charAt(1) === "/") return false;
    if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return false;
    return true;
  }

  // Resolve the post-auth destination from the current URL. Accepts the
  // primary ?next= param, the legacy ?return= param (clean form, legacy
  // .html form), and the legacy /register?plan=..&type=.. handoff, which
  // now maps onto /checkout so purchase context is never lost.
  function targetFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("next") || params.get("return");
      if (raw) {
        if (isSafeReturnPath(raw)) return raw;
        // legacy destination form: dashboard.html#x -> /dashboard#x
        const legacy = raw.match(/^([A-Za-z0-9_-]+)\.html(#[A-Za-z0-9_-]*)?$/);
        if (legacy) return "/" + legacy[1] + (legacy[2] || "");
      }
      const plan = params.get("plan");
      const type = params.get("type");
      if (
        plan &&
        type &&
        /^[A-Za-z0-9_-]+$/.test(plan) &&
        /^[A-Za-z][A-Za-z-]*$/.test(type)
      ) {
        return (
          "/checkout?type=" +
          encodeURIComponent(type) +
          "&plan=" +
          encodeURIComponent(plan)
        );
      }
      return "";
    } catch (err) {
      return "";
    }
  }

  function safeReturnPath() {
    return targetFromUrl() || "/dashboard";
  }

  // Keep the purchase/return context on cross-links between the auth pages
  // (login <-> register) so a visitor never falls back to a bare form.
  function carryNextOnAuthLinks() {
    const target = targetFromUrl();
    if (!target) return;
    const links = document.querySelectorAll(
      'a[href^="/login"], a[href^="/register"]'
    );
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const queryAt = href.indexOf("?");
      const base = queryAt >= 0 ? href.slice(0, queryAt) : href;
      link.setAttribute(
        "href",
        base + "?next=" + encodeURIComponent(target)
      );
    }
  }

  carryNextOnAuthLinks();

  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    const statusEl = document.getElementById("login-status");
    const submitBtn = loginForm.querySelector('[type="submit"]');

    loginForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      clearMessage(statusEl);

      const email = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value;

      submitBtn.disabled = true;
      try {
        const { response, body } = await apiRequest("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        if (response.ok) {
          showMessage(statusEl, "Signed in. Redirecting…", "success");
          window.location.href = safeReturnPath();
          return;
        }

        showMessage(
          statusEl,
          errorFromResponse(body, "Unable to sign in. Please try again."),
          "error"
        );
      } catch (err) {
        showMessage(
          statusEl,
          "Unable to reach the server. Please try again.",
          "error"
        );
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  const registerForm = document.getElementById("register-form");
  if (registerForm) {
    const statusEl = document.getElementById("register-status");
    const submitBtn = registerForm.querySelector('[type="submit"]');

    registerForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      clearMessage(statusEl);

      const email = document.getElementById("register-email").value.trim();
      const password = document.getElementById("register-password").value;
      const payload = {
        firstName: document.getElementById("register-first-name").value.trim(),
        lastName: document.getElementById("register-last-name").value.trim(),
        email,
        password,
      };

      submitBtn.disabled = true;
      try {
        const { response, body } = await apiRequest("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.status === 201) {
          const target = targetFromUrl();
          const returnTo = target || "/dashboard";

          // Auto sign-in so the purchase context (?next= or legacy
          // plan/type handoff) continues without a second form submission.
          let signedIn = false;
          try {
            const loginRes = await apiRequest("/api/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password }),
            });
            signedIn = loginRes.response.ok;
          } catch (err) {
            signedIn = false;
          }

          if (signedIn) {
            showMessage(statusEl, "Account created. Signing in…", "success");
            window.location.href = returnTo;
            return;
          }

          if (target) {
            window.location.href =
              "/login?next=" + encodeURIComponent(target);
            return;
          }

          showMessage(
            statusEl,
            "Account created. You can now sign in.",
            "success"
          );
          registerForm.reset();
          return;
        }

        showMessage(
          statusEl,
          errorFromResponse(body, "Unable to create the account."),
          "error"
        );
      } catch (err) {
        showMessage(
          statusEl,
          "Unable to reach the server. Please try again.",
          "error"
        );
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // Already signed-in visitors should not sit on the auth forms: send them
  // straight to the return target (purchase context, else dashboard). Uses
  // the auth-nav session probe; pages without it (dashboard) are unaffected.
  if (window.FlareAuthNav && (loginForm || registerForm)) {
    window.FlareAuthNav.ready().then(function () {
      if (window.FlareAuthNav.isLoggedIn()) {
        window.location.replace(safeReturnPath());
      }
      // Re-apply after the auth state settles so nav CTAs rewritten by
      // auth-nav still carry the return context.
      carryNextOnAuthLinks();
    });
  }
})();
