(function () {
  "use strict";

  var statusEl = document.getElementById("checkout-status");
  var root = document.getElementById("checkout-root");
  var errorCard = document.getElementById("checkout-error");
  var confirmCard = document.getElementById("order-confirm");
  var placeOrderBtn = document.getElementById("place-order");
  var proceedBtn = document.getElementById("proceed-payment");
  var paymentStatusEl = document.getElementById("payment-status");
  var backDashboard = document.getElementById("back-dashboard");
  var backPlans = document.getElementById("back-plans");
  var confirmNoticeEl = document.getElementById("confirm-notice");
  var paymentMethodsEl = document.getElementById("payment-methods");
  var bkashPayBtn = document.getElementById("bkash-pay-btn");
  var bkashCard = document.getElementById("bkash-instructions");
  var bkashCheckBtn = document.getElementById("bkash-check-status");
  var bkashHideBtn = document.getElementById("bkash-hide");
  var manualCard = document.getElementById("manual-payment");
  var manualForm = document.getElementById("manual-payment-form");
  var manualStatusEl = document.getElementById("manual-payment-status");
  var manualReceiverNote = document.getElementById("manual-receiver-note");
  var manualMethodSelect = document.getElementById("manual-method");
  var transactionIdInput = document.getElementById("transaction-id");
  var submitTransactionBtn = document.getElementById("submit-transaction");

  var catalog =
    window.FlareCatalog && typeof window.FlareCatalog === "object"
      ? window.FlareCatalog
      : null;

  var state = {
    authenticated: false,
    type: null,
    plan: null,
    idempotencyKey: null,
    submitting: false,
    paying: false,
    order: null,
    manualLoading: false,
    manualSubmitting: false,
    manualOrderId: null,
    provider: null,
    providerPromise: null,
  };

  function formatMoney(currency, amount) {
    var code = currency || "BDT";
    var value = amount != null ? String(amount) : "";
    if (code === "BDT") {
      return "৳" + value.replace(/\.00$/, "");
    }
    return code + " " + value;
  }

  function setStatus(message, kind) {
    if (!statusEl) return;
    statusEl.hidden = !message;
    statusEl.textContent = message || "";
    statusEl.classList.remove(
      "plan-status-loading",
      "plan-status-empty",
      "plan-status-error"
    );
    if (kind) statusEl.classList.add("plan-status-" + kind);
    if (message) statusEl.focus();
  }

  function showRoot() {
    if (root) root.hidden = false;
    if (errorCard) errorCard.hidden = true;
    if (confirmCard) confirmCard.hidden = true;
  }

  function showError(message) {
    if (root) root.hidden = true;
    if (confirmCard) confirmCard.hidden = true;
    if (errorCard) errorCard.hidden = false;
    var msg = document.getElementById("checkout-error-message");
    if (msg && message) msg.textContent = message;
    setStatus("Unable to load the selected plan.", "error");
  }

  function setPaymentStatus(message, kind) {
    if (!paymentStatusEl) return;
    paymentStatusEl.hidden = !message;
    paymentStatusEl.textContent = message || "";
    paymentStatusEl.classList.remove("form-status-error", "form-status-success");
    if (kind === "error") paymentStatusEl.classList.add("form-status-error");
    if (kind === "success") paymentStatusEl.classList.add("form-status-success");
    paymentStatusEl.setAttribute("role", kind === "error" ? "alert" : "status");
    if (message) paymentStatusEl.focus();
  }

  function showConfirmation(order) {
    if (root) root.hidden = true;
    if (errorCard) errorCard.hidden = true;
    if (confirmCard) confirmCard.hidden = false;

    setText("confirm-order-number", order.orderNumber);
    setText(
      "confirm-amount",
      formatMoney(order.currency, order.amount)
    );
    setText("confirm-status", statusLabel(order.status));
    setText("confirm-plan", order.plan && order.plan.name ? order.plan.name : "—");
    setText(
      "confirm-type",
      order.productType === "vps" ? "VPS Plan" : "Web Hosting Plan"
    );
    setText("confirm-created", formatDate(order.createdAt));

    setPaymentStatus("", null);
    updatePaymentMethods(order.status);

    setStatus("", null);
    if (confirmCard) {
      confirmCard.setAttribute("tabindex", "-1");
      confirmCard.focus();
    }
  }

  // Only an awaiting_payment order shows active payment methods; every other
  // status hides them so no stale instruction lingers on a closed order.
  // When UddoktaPay is the active provider the UI is gateway-only: the hand
  //-off happens inside the Place Order click itself, so the whole payment
  // selection section (including the second "Proceed to Payment" button)
  // stays hidden and the legacy bKash / manual Transaction ID sections stay
  // hidden and disabled.
  function updatePaymentMethods(status) {
    var awaiting = status === "awaiting_payment";
    var gatewayOnly = isUddoktaPay();
    if (paymentMethodsEl) paymentMethodsEl.hidden = !awaiting || gatewayOnly;
    if (proceedBtn) {
      proceedBtn.hidden = !awaiting || gatewayOnly;
      proceedBtn.disabled = false;
      proceedBtn.textContent = "Proceed to Payment";
    }
    if (bkashPayBtn) bkashPayBtn.hidden = !awaiting || gatewayOnly;
    if ((gatewayOnly || !awaiting) && bkashCard) bkashCard.hidden = true;
    if (manualCard) {
      manualCard.hidden = !awaiting || gatewayOnly;
      if (awaiting && !gatewayOnly) {
        loadManualState();
      } else {
        state.manualOrderId = null;
      }
    }
    if (confirmNoticeEl) confirmNoticeEl.hidden = gatewayOnly;
  }

  function setManualStatus(message, kind) {
    if (!manualStatusEl) return;
    manualStatusEl.hidden = !message;
    manualStatusEl.textContent = message || "";
    manualStatusEl.classList.remove("form-status-error", "form-status-success");
    if (kind === "error") manualStatusEl.classList.add("form-status-error");
    if (kind === "success") manualStatusEl.classList.add("form-status-success");
    manualStatusEl.setAttribute(
      "role",
      kind === "error" ? "alert" : "status"
    );
    if (message) manualStatusEl.focus();
  }

  // Receiver values come from the server only. When no receiver is
  // configured the card says so honestly — nothing is ever guessed here.
  function loadManualReceiver() {
    if (!state.order) return;
    fetch(
      "/api/orders/" +
        encodeURIComponent(state.order.id) +
        "/bkash-instructions",
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      }
    )
      .then(function (response) {
        return response.json().then(function (body) {
          return { response: response, body: body };
        });
      })
      .then(function (result) {
        var receiverEl = document.getElementById("manual-receiver");
        if (
          result.response.ok &&
          result.body &&
          result.body.success &&
          result.body.data
        ) {
          if (receiverEl) {
            receiverEl.textContent = result.body.data.receiverNumber;
          }
          if (manualReceiverNote) manualReceiverNote.hidden = true;
          return;
        }
        if (receiverEl) receiverEl.textContent = "Not configured yet";
        if (manualReceiverNote) manualReceiverNote.hidden = false;
      })
      .catch(function () {
        var receiverEl = document.getElementById("manual-receiver");
        if (receiverEl) receiverEl.textContent = "Not configured yet";
        if (manualReceiverNote) manualReceiverNote.hidden = false;
      });
  }

  function applyManualState(data) {
    var status = data ? data.status : "none";
    if (status === "awaiting_verification") {
      if (manualForm) manualForm.hidden = true;
      setManualStatus(
        "Transaction ID submitted. Your payment is awaiting admin verification.",
        "success"
      );
      return;
    }
    if (status === "verified") {
      if (manualForm) manualForm.hidden = true;
      setManualStatus(
        "Payment verified — your order is paid. No further action is needed.",
        "success"
      );
      return;
    }
    if (status === "rejected") {
      if (manualForm) manualForm.hidden = false;
      setManualStatus(
        "Your submitted Transaction ID was rejected. Submit a new Transaction ID to try again.",
        "error"
      );
      return;
    }
    if (manualForm) manualForm.hidden = false;
    setManualStatus("", null);
  }

  // Loads the owner-scoped verification state once per order so a refresh or
  // a "Check order status" click never loses an existing submission.
  async function loadManualState() {
    if (!state.order || state.manualLoading) return;
    if (isUddoktaPay()) return;
    if (state.manualOrderId === state.order.id) return;
    state.manualLoading = true;
    var orderId = state.order.id;

    setText("manual-order-number", state.order.orderNumber);
    setText(
      "manual-amount",
      formatMoney(state.order.currency, state.order.amount)
    );
    loadManualReceiver();

    try {
      var response = await fetch(
        "/api/payments/order/" + encodeURIComponent(orderId),
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        }
      );
      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        var returnTo =
          "/checkout?type=" +
          encodeURIComponent(state.type || "") +
          "&plan=" +
          encodeURIComponent(state.plan ? state.plan.slug : "");
        window.location.href =
          "/login?return=" + encodeURIComponent(returnTo);
        return;
      }

      if (response.ok && body && body.success && body.data) {
        state.manualOrderId = orderId;
        applyManualState(body.data);
        return;
      }

      // No readable state yet — leave the form available.
      state.manualOrderId = orderId;
      if (manualForm) manualForm.hidden = false;
    } catch (err) {
      setManualStatus(
        "Unable to load your payment status. Please try again.",
        "error"
      );
    } finally {
      state.manualLoading = false;
    }
  }

  async function submitTransactionId(event) {
    if (event && event.preventDefault) event.preventDefault();
    if (state.manualSubmitting || !state.order) return;
    if (isUddoktaPay()) return;

    var trx = transactionIdInput ? transactionIdInput.value.trim() : "";
    if (!trx) {
      setManualStatus("Enter your Transaction ID to submit.", "error");
      if (transactionIdInput) transactionIdInput.focus();
      return;
    }

    state.manualSubmitting = true;
    if (submitTransactionBtn) {
      submitTransactionBtn.disabled = true;
      submitTransactionBtn.textContent = "Submitting…";
    }

    try {
      var payload = {
        orderId: state.order.id,
        transactionId: trx,
      };
      if (manualMethodSelect && manualMethodSelect.value) {
        payload.paymentMethod = manualMethodSelect.value;
      }

      var response = await fetch("/api/payments/transaction-id", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        var returnTo =
          "/checkout?type=" +
          encodeURIComponent(state.type || "") +
          "&plan=" +
          encodeURIComponent(state.plan ? state.plan.slug : "");
        window.location.href =
          "/login?return=" + encodeURIComponent(returnTo);
        return;
      }

      if (
        (response.status === 201 || response.status === 200) &&
        body &&
        body.success &&
        body.data
      ) {
        if (manualForm) manualForm.hidden = true;
        state.manualOrderId = state.order.id;
        setManualStatus(
          "Transaction ID submitted. Your payment is awaiting admin verification.",
          "success"
        );
        if (transactionIdInput) transactionIdInput.value = "";
        return;
      }

      var code = body && body.error && body.error.code;
      var message =
        body && body.error && body.error.message
          ? body.error.message
          : "Unable to submit your Transaction ID. Please try again.";
      if (body && body.error && body.error.details && body.error.details.length) {
        message = body.error.details.join(" ");
      }
      if (code === "PAYMENT_SUBMISSION_EXISTS") {
        if (manualForm) manualForm.hidden = true;
        setManualStatus(
          "You already submitted a Transaction ID for this order. Your payment is awaiting admin verification.",
          "success"
        );
        return;
      }
      if (code === "DUPLICATE_TRANSACTION_ID") {
        message =
          "This Transaction ID has already been recorded. Check the value and try again.";
      } else if (code === "ORDER_NOT_PAYABLE") {
        message = "This order is no longer awaiting payment.";
      } else if (code === "ORDER_NOT_FOUND") {
        message = "This order could not be found.";
      }
      setManualStatus(message, "error");
    } catch (err) {
      setManualStatus(
        "Unable to reach the server. Please try again.",
        "error"
      );
    } finally {
      state.manualSubmitting = false;
      if (submitTransactionBtn) {
        submitTransactionBtn.disabled = false;
        submitTransactionBtn.textContent = "Submit Transaction ID";
      }
    }
  }

  async function showBkashInstructions() {
    if (state.paying || !state.order) return;
    if (isUddoktaPay()) return;
    if (bkashPayBtn) bkashPayBtn.disabled = true;
    setPaymentStatus("Loading bKash instructions…", null);

    try {
      var response = await fetch(
        "/api/orders/" +
          encodeURIComponent(state.order.id) +
          "/bkash-instructions",
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        }
      );

      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        var returnTo =
          "/checkout?type=" +
          encodeURIComponent(state.type || "") +
          "&plan=" +
          encodeURIComponent(state.plan ? state.plan.slug : "");
        window.location.href =
          "/login?return=" + encodeURIComponent(returnTo);
        return;
      }

      if (response.ok && body && body.success && body.data) {
        var data = body.data;
        setText("bkash-receiver", data.receiverNumber);
        setText("bkash-amount", formatMoney(data.currency, data.amount));
        setText("bkash-order-number", data.orderNumber);
        if (bkashCard) bkashCard.hidden = false;
        setPaymentStatus("", null);
        return;
      }

      var code = body && body.error && body.error.code;
      var message =
        body && body.error && body.error.message
          ? body.error.message
          : "bKash payment is not available right now. Please try again later.";
      if (code === "PAYMENT_PROVIDER_NOT_CONFIGURED" ||
          code === "BKASH_PAYMENT_NOT_CONFIGURED") {
        message = "bKash payment is not available yet for this order.";
      } else if (code === "ORDER_NOT_AWAITING") {
        message = "This order is no longer awaiting payment.";
      } else if (code === "ORDER_NOT_FOUND") {
        message = "This order could not be found.";
      }
      setPaymentStatus(message, "error");
    } catch (err) {
      setPaymentStatus(
        "Unable to reach the server. Please try again.",
        "error"
      );
    } finally {
      if (bkashPayBtn) bkashPayBtn.disabled = false;
    }
  }

  async function checkOrderStatus() {
    if (!state.order) return;
    if (bkashCheckBtn) bkashCheckBtn.disabled = true;

    try {
      var response = await fetch(
        "/api/orders/" + encodeURIComponent(state.order.id),
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        }
      );
      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        window.location.href = "/login?return=" +
          encodeURIComponent("/checkout?type=" +
            encodeURIComponent(state.type || "") +
            "&plan=" +
            encodeURIComponent(state.plan ? state.plan.slug : ""));
        return;
      }

      if (response.ok && body && body.success && body.data) {
        var order = body.data;
        state.order = order;
        setText("confirm-status", statusLabel(order.status));
        updatePaymentMethods(order.status);
        if (order.status === "awaiting_payment") {
          setPaymentStatus(
            isUddoktaPay()
              ? "Payment is being verified."
              : "Still awaiting payment — the SMS may not have arrived yet. " +
                  "Check again in a minute.",
            null
          );
        } else if (order.status === "paid") {
          setPaymentStatus(
            "Payment received — your order is now paid. No further action is needed.",
            "success"
          );
        } else {
          setPaymentStatus(
            "This order is now " + statusLabel(order.status) + ".",
            null
          );
        }
        return;
      }

      setPaymentStatus("Unable to check the order status. Please try again.", "error");
    } catch (err) {
      setPaymentStatus("Unable to reach the server. Please try again.", "error");
    } finally {
      if (bkashCheckBtn) bkashCheckBtn.disabled = false;
    }
  }

  function statusLabel(status) {
    var map = {
      pending: "Pending",
      awaiting_payment: "Awaiting Payment",
      paid: "Paid",
      cancelled: "Cancelled",
      refunded: "Refunded",
      failed: "Failed",
    };
    return map[status] || status;
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

  function titleCase(value) {
    if (!value) return "—";
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function appendResource(label, value) {
    var list = document.getElementById("checkout-resources");
    if (!list) return;
    var li = document.createElement("li");
    var labelEl = document.createElement("span");
    labelEl.className = "label";
    labelEl.textContent = label;
    var valueEl = document.createElement("span");
    valueEl.className = "value";
    valueEl.textContent = String(value);
    li.appendChild(labelEl);
    li.appendChild(valueEl);
    list.appendChild(li);
  }

  function clearResources() {
    var list = document.getElementById("checkout-resources");
    if (list) list.replaceChildren();
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function readQuery() {
    var params = new URLSearchParams(window.location.search);
    return {
      type: (params.get("type") || "").trim().toLowerCase(),
      plan: (params.get("plan") || "").trim(),
    };
  }

  function updateBackLinks(type) {
    if (!backPlans) return;
    if (type === "vps") {
      backPlans.href = "/vps-hosting";
      backPlans.textContent = "Back to VPS Plans";
    } else if (type === "hosting") {
      backPlans.href = "/web-hosting";
      backPlans.textContent = "Back to Hosting Plans";
    } else {
      backPlans.href = "/web-hosting";
      backPlans.textContent = "Back to Plans";
    }
  }

  function setAuthUi(authenticated) {
    state.authenticated = authenticated;
    var authNote = document.getElementById("auth-note");
    var signInCta = document.getElementById("sign-in-cta");
    if (placeOrderBtn) placeOrderBtn.disabled = !authenticated;
    if (authNote) authNote.hidden = authenticated;
    if (signInCta) signInCta.hidden = authenticated;
    if (placeOrderBtn) placeOrderBtn.hidden = !authenticated;
  }

  function renderPlan(type, plan) {
    clearResources();

    setText(
      "checkout-type-badge",
      type === "vps" ? "VPS Plan" : "Web Hosting Plan"
    );
    setText("checkout-plan-name", plan.name);
    setText("checkout-price", catalog ? catalog.formatPrice(plan) : plan.price);
    setText(
      "checkout-period",
      catalog ? catalog.billingPeriodLabel(plan.billingCycle) : "/mo"
    );
    setText("checkout-description", plan.description || "Plan details from the catalog.");

    if (type === "vps") {
      appendResource(
        "vCPU",
        plan.cpuCores + (plan.cpuCores === 1 ? " core" : " cores")
      );
      appendResource("RAM", catalog ? catalog.formatRam(plan.ramMb) : plan.ramMb);
      appendResource("Storage", plan.storageGb + " GB");
      appendResource(
        "Bandwidth",
        catalog
          ? catalog.formatBandwidth(plan.bandwidthGb)
          : plan.bandwidthGb + " GB / mo"
      );
      appendResource("IPv4 addresses", String(plan.ipv4Addresses));
      appendResource("Billing cycle", titleCase(plan.billingCycle));
    } else {
      appendResource(
        "Websites",
        catalog ? catalog.unlimited(plan.domains) : plan.domains
      );
      appendResource("Storage", plan.storageGb + " GB");
      appendResource(
        "Bandwidth",
        catalog
          ? catalog.formatBandwidth(plan.bandwidthGb)
          : plan.bandwidthGb + " GB / mo"
      );
      appendResource(
        "Email accounts",
        catalog ? catalog.unlimited(plan.emailAccounts) : plan.emailAccounts
      );
      appendResource(
        "Databases",
        catalog ? catalog.unlimited(plan.databases) : plan.databases
      );
      appendResource("SSL", plan.ssl ? "Included" : "Not included");
      appendResource("Billing cycle", titleCase(plan.billingCycle));
    }

    updateBackLinks(type);
    showRoot();
    setStatus("", null);
  }

  function newIdempotencyKey() {
    try {
      if (window.crypto && window.crypto.randomUUID) {
        return window.crypto.randomUUID().replace(/-/g, "");
      }
    } catch (err) {
      // fall through
    }
    var raw =
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10);
    return raw.slice(0, 64);
  }

  // One idempotency key per checkout attempt (type + plan), persisted for
  // this tab only. A refresh while the Place Order request is in flight —
  // or after a failed payment hand-off — reuses the same key, so the server
  // returns the SAME order instead of creating a duplicate. The key is
  // retired only once its order is no longer awaiting payment (placeOrder's
  // stale-key pass), so a later repurchase starts a fresh attempt.
  function idempotencyStorageKey(type, slug) {
    return "flare.order-key." + type + "." + slug;
  }

  function readIdempotencyKey(type, slug) {
    var storageKey = idempotencyStorageKey(type, slug);
    try {
      var stored = window.sessionStorage.getItem(storageKey);
      if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
      var fresh = newIdempotencyKey();
      window.sessionStorage.setItem(storageKey, fresh);
      return fresh;
    } catch (err) {
      return newIdempotencyKey();
    }
  }

  function clearIdempotencyKey(type, slug) {
    try {
      window.sessionStorage.removeItem(idempotencyStorageKey(type, slug));
    } catch (err) {
      // storage unavailable — the next attempt just uses a fresh key
    }
  }

  async function checkAuth() {
    try {
      var response = await fetch("/api/auth/me", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        setAuthUi(false);
        return false;
      }
      if (!response.ok) {
        // Transient API failure — not an auth failure. Keep prior UI state
        // and surface an error instead of treating it as logged-out.
        setStatus(
          "Unable to verify your session. Please try again.",
          "error"
        );
        return state.authenticated;
      }
      setAuthUi(true);
      return true;
    } catch (err) {
      setStatus("Unable to reach the server. Please try again.", "error");
      return false;
    }
  }

  // Active payment provider, read once from the server. The name alone
  // decides the payment UI — never any configuration or credentials. When
  // the server advertises the exact gateway host it trusts for redirects
  // (host only, env-derived), it is kept for the isSafeGatewayUrl guard so
  // browser and server trust rules agree on the same single host.
  // A failed fetch resets the promise so the next caller can retry once;
  // while the provider is unknown, behavior is exactly as before.
  function fetchPaymentProvider() {
    if (!state.providerPromise) {
      state.providerPromise = fetch("/api/payments/provider", {
        credentials: "include",
        headers: { Accept: "application/json" },
      })
        .then(function (response) {
          return response.json().then(function (body) {
            if (
              response.ok &&
              body &&
              body.success &&
              body.data &&
              typeof body.data.provider === "string"
            ) {
              state.provider = body.data.provider;
              var trusted =
                typeof body.data.gatewayHost === "string"
                  ? body.data.gatewayHost.trim().toLowerCase()
                  : "";
              window.__trustedGatewayHost =
                trusted && !/[\s/?#\\]/.test(trusted) ? trusted : null;
            }
          });
        })
        .catch(function () {
          state.providerPromise = null;
        });
    }
    return state.providerPromise;
  }

  function isUddoktaPay() {
    return state.provider === "uddoktapay";
  }

  // Redirect only ever goes to a URL the gateway trust rules allow: an
  // absolute http(s) URL on the exact host the SERVER advertised for the
  // active provider (GET /api/payments/provider — the same env-derived host
  // its own redirect trust check uses), a vendor gateway domain (https),
  // our own origin, or a loopback host (local gateway mock). Anything else
  // (missing, relative, javascript:, foreign host, unparseable) is a safe
  // recoverable error — the browser never navigates to it. The server
  // validates first either way; this guard is the browser's last word.
  function isSafeGatewayUrl(value) {
    if (typeof value !== "string" || !value) return false;
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return false;
      }
      var host = parsed.hostname.toLowerCase();
      var onUddoktapay =
        host === "uddoktapay.com" || host.endsWith(".uddoktapay.com");
      if (onUddoktapay) return parsed.protocol === "https:";
      var onSslcommerz =
        host === "sslcommerz.com" || host.endsWith(".sslcommerz.com");
      if (onSslcommerz) return parsed.protocol === "https:";
      // The advertised gateway host is compared verbatim (never as a
      // pattern), so trust can only ever match this one exact host — and
      // plain http is accepted only exactly where the server accepts it
      // (its own configured base host, never a vendor domain).
      var trusted =
        typeof window !== "undefined" && window.__trustedGatewayHost
          ? window.__trustedGatewayHost
          : "";
      if (trusted && parsed.host === trusted) return true;
      var pageHost =
        typeof window !== "undefined" && window.location
          ? window.location.host
          : "";
      if (pageHost && parsed.host === pageHost) return true;
      return (
        parsed.protocol === "http:" &&
        (host === "127.0.0.1" || host === "localhost" || host === "[::1]")
      );
    } catch (err) {
      return false;
    }
  }

  async function placeOrder() {
    if (state.submitting || !state.authenticated || !state.type || !state.plan) {
      return;
    }

    state.submitting = true;
    if (placeOrderBtn) {
      placeOrderBtn.disabled = true;
      placeOrderBtn.textContent = "Placing Order…";
    }
    setStatus("Creating your order…", "loading");

    try {
      // A failed hand-off earlier in this attempt already created the
      // order: retry against THAT order (the server reuses its open
      // gateway session) — never a second order and never a second button.
      if (state.order && state.order.status === "awaiting_payment") {
        setStatus("Redirecting to secure payment…", "loading");
        await fetchPaymentProvider();
        if (isUddoktaPay()) {
          var retryPay = await proceedToPayment();
          if (retryPay && retryPay.ok) return;
          recoverFromPaymentStart(state.order, retryPay && retryPay.message);
          return;
        }
        showConfirmation(state.order);
        return;
      }

      // At most two passes: the first may discover this tab's idempotency
      // key belongs to an order that is already finished — retire the key
      // and start one fresh attempt (never a loop). An awaiting order is
      // returned as-is and carried straight into payment below.
      for (var orderAttempt = 0; orderAttempt < 2; orderAttempt++) {
        var response = await fetch("/api/orders", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": state.idempotencyKey,
          },
          // Only productType + planSlug — never amount/currency/user/status
          body: JSON.stringify({
            productType: state.type,
            planSlug: state.plan.slug,
          }),
        });

        var body = null;
        try {
          body = await response.json();
        } catch (err) {
          body = null;
        }

        if (response.status === 401) {
          var returnTo =
            "/checkout?type=" +
            encodeURIComponent(state.type) +
            "&plan=" +
            encodeURIComponent(state.plan.slug);
          window.location.href =
            "/login?return=" + encodeURIComponent(returnTo);
          return;
        }

        if ((response.status === 201 || response.status === 200) &&
            body && body.success && body.data) {
          if (
            response.status === 200 &&
            body.data.status !== "awaiting_payment" &&
            orderAttempt === 0
          ) {
            // This key belongs to a finished order — retire it and start
            // one fresh attempt for this same plan.
            clearIdempotencyKey(state.type, state.plan ? state.plan.slug : "");
            state.idempotencyKey = readIdempotencyKey(
              state.type,
              state.plan ? state.plan.slug : ""
            );
            continue;
          }
          state.order = body.data;
          // The key stays while this order still needs payment: a refresh
          // or a retry reuses THIS order instead of creating a duplicate.
          // Resolve the active provider before rendering payment choices (the
          // boot fetch has normally settled already; this retries a failed one).
          await fetchPaymentProvider();
          if (isUddoktaPay() && body.data.status === "awaiting_payment") {
            // UddoktaPay: no intermediate payment-selection or confirmation
            // page — create the payment session in this same click and go
            // straight to the gateway. Only a recoverable failure returns to
            // the form with the truthful error (Place Order itself is the
            // retry against this same order); nothing is ever marked paid.
            setStatus("Redirecting to secure payment…", "loading");
            var payResult = await proceedToPayment();
            if (payResult && payResult.ok) return;
            recoverFromPaymentStart(body.data, payResult && payResult.message);
            return;
          }
          showConfirmation(body.data);
          return;
        }

        var message =
          body && body.error && body.error.message
            ? body.error.message
            : "Unable to create the order. Please try again.";
        if (body && body.error && body.error.details && body.error.details.length) {
          message = body.error.details.join(" ");
        }
        setStatus(message, "error");
        return;
      }
    } catch (err) {
      setStatus("Unable to reach the server. Please try again.", "error");
    } finally {
      state.submitting = false;
      if (placeOrderBtn && confirmCard && confirmCard.hidden) {
        placeOrderBtn.disabled = false;
        placeOrderBtn.textContent = "Place Order";
      } else if (placeOrderBtn && root && root.hidden) {
        // confirmation shown — leave button hidden/disabled path alone
        placeOrderBtn.textContent = "Place Order";
      }
    }
  }

  // Recoverable payment-start failure: the order already exists, so stay on
  // the checkout form with the truthful error — the Place Order button IS
  // the retry (it reuses this order and the server's open gateway session).
  // No second "Proceed to Payment" button, no duplicate order, no duplicate
  // gateway session, and nothing is ever marked paid here.
  function recoverFromPaymentStart(order, message) {
    state.order = order;
    setStatus(
      message || "We couldn't start the payment session. Please try again.",
      "error"
    );
  }

  // Creates the payment session for state.order and, when the server returns
  // a trusted gateway URL, redirects the browser there. Returns { ok, message }
  // so the Place Order flow can decide between redirect and recovery.
  async function proceedToPayment() {
    if (state.paying || !state.authenticated || !state.order) {
      return {
        ok: false,
        message: "We couldn't start the payment session. Please try again.",
      };
    }

    state.paying = true;
    if (proceedBtn) {
      proceedBtn.disabled = true;
      proceedBtn.textContent = "Starting Payment…";
    }
    setPaymentStatus("Starting payment…", null);

    try {
      // Make sure the server-advertised trusted gateway host is known
      // before any URL passes the guard (the boot fetch may have failed).
      await fetchPaymentProvider();
      // Only the order id — amount/currency/status are server-side only.
      var response = await fetch("/api/payments", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ orderId: state.order.id }),
      });

      var body = null;
      try {
        body = await response.json();
      } catch (err) {
        body = null;
      }

      if (response.status === 401) {
        var returnTo =
          "/checkout?type=" +
          encodeURIComponent(state.type || "") +
          "&plan=" +
          encodeURIComponent(state.plan ? state.plan.slug : "");
        window.location.href =
          "/login?return=" + encodeURIComponent(returnTo);
        return { ok: true };
      }

      if (
        (response.status === 201 || response.status === 200) &&
        body &&
        body.success &&
        body.data
      ) {
        if (body.data.gatewayUrl) {
          // Redirect only to the server-provided payment gateway URL, and
          // only when it is an absolute http(s) address.
          if (!isSafeGatewayUrl(body.data.gatewayUrl)) {
            var unsafe =
              "We couldn't start the payment session. Please try again.";
            setPaymentStatus(unsafe, "error");
            return { ok: false, message: unsafe };
          }
          window.location.href = body.data.gatewayUrl;
          return { ok: true };
        }
        if (isUddoktaPay()) {
          var noUrl =
            "We couldn't start the payment session. Please try again.";
          setPaymentStatus(noUrl, "error");
          return { ok: false, message: noUrl };
        }
        setPaymentStatus(
          "Payment session created. This order is still awaiting payment.",
          "success"
        );
        return { ok: true };
      }

      var code = body && body.error && body.error.code;
      var message =
        body && body.error && body.error.message
          ? body.error.message
          : "We couldn't start the payment session. Please try again.";
      if (code === "PAYMENT_PROVIDER_NOT_CONFIGURED") {
        message = "Payment processing is not available yet.";
      } else if (code === "PAYMENT_PROVIDER_ERROR") {
        message = "We couldn't start the payment session. Please try again.";
      } else if (code === "PAYMENT_SESSION_EXPIRED") {
        message = "The payment session has expired. Please try again.";
      }
      if (body && body.error && body.error.details && body.error.details.length) {
        message = body.error.details.join(" ");
      }
      setPaymentStatus(message, "error");
      return { ok: false, message: message };
    } catch (err) {
      var offline = "Unable to reach the server. Please try again.";
      setPaymentStatus(offline, "error");
      return { ok: false, message: offline };
    } finally {
      state.paying = false;
      if (proceedBtn) {
        proceedBtn.disabled = false;
        proceedBtn.textContent = "Proceed to Payment";
      }
    }
  }

  async function boot() {
    if (!catalog) {
      showError("Unable to load the selected plan. Please try again later.");
      return;
    }

    var query = readQuery();

    if (!catalog.isValidType(query.type)) {
      showError(
        "Invalid product type. Choose a hosting or VPS plan from the dashboard."
      );
      return;
    }

    if (!catalog.isValidSlug(query.plan)) {
      showError("Invalid plan selection. Choose a plan from the catalog.");
      return;
    }

    state.type = query.type;
    state.idempotencyKey = readIdempotencyKey(query.type, query.plan);
    fetchPaymentProvider();

    setStatus("Loading plan…", "loading");
    updateBackLinks(query.type);

    await checkAuth();

    try {
      var result = await catalog.fetchPlan(query.type, query.plan);
      if (!result.ok || !result.plan) {
        if (result.reason === "not_found") {
          showError(
            "That plan is not available. It may have been renamed or removed."
          );
        } else {
          showError("Unable to load the selected plan. Please try again.");
        }
        return;
      }

    // keep sign-in link pointed at this checkout with return URL
    var signInLink = document.getElementById("sign-in-link");
    var signInCta = document.getElementById("sign-in-cta");
    var returnTo =
      "/checkout?type=" +
      encodeURIComponent(state.type || query.type || "") +
      "&plan=" +
      encodeURIComponent(state.plan ? state.plan.slug : query.plan || "");
    if (signInLink) {
      signInLink.href =
        "/login?return=" + encodeURIComponent(returnTo);
    }
    if (signInCta) {
      signInCta.href = "/login?return=" + encodeURIComponent(returnTo);
    }

      // Canonical data comes only from the API
      state.plan = result.plan;
      renderPlan(query.type, result.plan);
    } catch (err) {
      showError("Unable to reach the server. Please try again later.");
    }
  }

  if (placeOrderBtn) {
    placeOrderBtn.addEventListener("click", placeOrder);
  }

  if (proceedBtn) {
    proceedBtn.addEventListener("click", proceedToPayment);
  }

  if (bkashPayBtn) {
    bkashPayBtn.addEventListener("click", showBkashInstructions);
  }

  if (bkashCheckBtn) {
    bkashCheckBtn.addEventListener("click", checkOrderStatus);
  }

  if (bkashHideBtn) {
    bkashHideBtn.addEventListener("click", function () {
      if (bkashCard) bkashCard.hidden = true;
    });
  }

  if (manualForm) {
    manualForm.addEventListener("submit", submitTransactionId);
  }

  if (backDashboard) {
    backDashboard.addEventListener("click", function (event) {
      // allow default navigation
    });
  }

  boot();
})();
