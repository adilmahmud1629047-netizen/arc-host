(function () {
  "use strict";

  async function apiRequest(path, options) {
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

  async function fetchAdminMe() {
    const { response, body } = await apiRequest("/api/admin/me", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok || !body || !body.success) return null;
    const admin = body.data && body.data.admin;
    if (!admin || admin.role !== "admin") return null;
    return admin;
  }

  async function ensureAdminOrLogin() {
    try {
      const admin = await fetchAdminMe();
      if (admin) return admin;
    } catch (err) {
      // fall through
    }
    window.location.replace("/admin/login");
    return null;
  }

  async function ensureAnonOrDashboard() {
    try {
      const admin = await fetchAdminMe();
      if (admin) {
        window.location.replace("/admin/dashboard");
        return;
      }
    } catch (err) {
      // stay on login
    }
  }

  // Session lost or permission revoked while a page is open: 401/403 mean the
  // admin can no longer act here, so return to the sign-in gate instead of
  // rendering an error they cannot resolve.
  function redirectIfSignedOut(response) {
    if (!response) return false;
    if (response.status === 401 || response.status === 403) {
      window.location.replace("/admin/login");
      return true;
    }
    return false;
  }

  function setStatus(el, text, type) {
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    showMessage(el, text, type || "error");
  }

  // Shared shell: header identity, logout, mobile menu — runs on every admin page.
  function initShell(admin) {
    const nameEl = document.getElementById("admin-user-name");
    const emailEl = document.getElementById("admin-user-email");
    const idEl = document.getElementById("admin-user-id");
    const roleEl = document.getElementById("admin-user-role");
    const logoutBtn = document.getElementById("admin-logout-button");
    const menuToggle = document.getElementById("admin-menu-toggle");
    const sidebar = document.getElementById("admin-sidebar");

    if (admin) {
      if (nameEl) {
        nameEl.textContent =
          [admin.firstName, admin.lastName].filter(Boolean).join(" ") ||
          admin.email;
      }
      if (emailEl) emailEl.textContent = admin.email || "";
      if (idEl) idEl.textContent = admin.id || "";
      if (roleEl) roleEl.textContent = admin.role || "admin";
    }

    if (logoutBtn && !logoutBtn.dataset.bound) {
      logoutBtn.dataset.bound = "1";
      logoutBtn.addEventListener("click", async function () {
        try {
          await apiRequest("/api/auth/logout", { method: "POST" });
        } catch (err) {
          // still leave
        }
        window.location.replace("/admin/login");
      });
    }

    if (menuToggle && sidebar && !menuToggle.dataset.bound) {
      menuToggle.dataset.bound = "1";
      menuToggle.addEventListener("click", function () {
        const open = sidebar.classList.toggle("is-open");
        menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
  }

  window.FlareAdmin = {
    apiRequest,
    showMessage,
    clearMessage,
    errorFromResponse,
    fetchAdminMe,
    ensureAdminOrLogin,
    ensureAnonOrDashboard,
    redirectIfSignedOut,
    setStatus,
    initShell,
  };

  const loginForm = document.getElementById("admin-login-form");
  if (loginForm) {
    const statusEl = document.getElementById("admin-login-status");
    const submitBtn = loginForm.querySelector('[type="submit"]');

    ensureAnonOrDashboard();

    loginForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      clearMessage(statusEl);

      const email = document.getElementById("admin-login-email").value.trim();
      const password = document.getElementById("admin-login-password").value;

      submitBtn.disabled = true;
      try {
        const { response, body } = await apiRequest("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        if (response.ok) {
          const admin = await fetchAdminMe();
          if (admin) {
            showMessage(statusEl, "Signed in. Redirecting…", "success");
            window.location.replace("/admin/dashboard");
            return;
          }

          await apiRequest("/api/auth/logout", { method: "POST" });
          showMessage(
            statusEl,
            "This account does not have administrator access.",
            "error"
          );
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

  // Non-login admin pages: gate + shell.
  if (!loginForm && document.querySelector(".admin-topbar")) {
    (async function initAdminPage() {
      const admin = await ensureAdminOrLogin();
      if (!admin) return;
      initShell(admin);
      document.documentElement.setAttribute("data-admin-ready", "1");
    })();
  }
})();
