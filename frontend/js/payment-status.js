(function () {
  "use strict";

  var UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var titleEl = document.getElementById("payment-result-title");
  var messageEl = document.getElementById("payment-result-message");
  var eyebrowEl = document.getElementById("payment-result-eyebrow");
  var iconEl = document.getElementById("payment-result-icon");
  var orderEl = document.getElementById("payment-result-order");
  var orderStatusEl = document.getElementById("payment-result-order-status");
  var kind =
    (document.body && document.body.getAttribute("data-payment-result")) ||
    "success";

  var KIND_TITLES = {
    success: "Payment result",
    failed: "Payment failed",
    cancelled: "Payment cancelled",
  };

  var ORDER_STATUS_LABELS = {
    pending: "Pending",
    awaiting_payment: "Awaiting Payment",
    paid: "Paid",
    cancelled: "Cancelled",
    refunded: "Refunded",
    failed: "Failed",
  };

  function titleCase(value) {
    if (!value) return "—";
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function orderStatusLabel(status) {
    return ORDER_STATUS_LABELS[status] || titleCase(status);
  }

  function setText(el, value) {
    if (el) el.textContent = value;
  }

  // tone: "ok" | "warn" | "bad"
  function finish(tone, title, message) {
    setText(titleEl, title);
    if (messageEl) {
      messageEl.textContent = message;
      messageEl.classList.add("form-status");
      messageEl.classList.remove(
        "form-status-success",
        "form-status-error",
        "form-status-loading"
      );
      if (tone === "ok") messageEl.classList.add("form-status-success");
      if (tone === "bad") messageEl.classList.add("form-status-error");
      messageEl.setAttribute("role", "status");
      messageEl.hidden = false;
      messageEl.focus();
    }
    if (iconEl) {
      iconEl.classList.remove(
        "icon-tile-accent",
        "icon-tile-success",
        "icon-tile-danger"
      );
      if (tone === "ok") iconEl.classList.add("icon-tile-success");
      if (tone === "bad") iconEl.classList.add("icon-tile-danger");
      if (tone === "warn") iconEl.classList.add("icon-tile-accent");
      iconEl.textContent = tone === "ok" ? "✓" : tone === "bad" ? "!" : "…";
    }
    setText(eyebrowEl, "Payment verification");
  }

  function showOrder(order) {
    setText(orderEl, order.orderNumber || order.id || "—");
    setText(orderStatusEl, orderStatusLabel(order.status));
  }

  function resolveOrder(status) {
    if (status === "paid") {
      finish("ok", "Payment confirmed", "Payment successful.");
      return;
    }
    if (status === "awaiting_payment") {
      finish(
        "warn",
        "Verifying payment",
        "Payment is still being verified."
      );
      return;
    }
    finish(
      "bad",
      "Order " + orderStatusLabel(status),
      "Order status: " + orderStatusLabel(status) + "."
    );
  }

  var params = new URLSearchParams(window.location.search);
  var orderId = (params.get("order") || "").trim();

  if (!orderId || !UUID_PATTERN.test(orderId)) {
    setText(orderEl, "—");
    setText(orderStatusEl, "—");
    finish("bad", "Payment result", "We couldn't find that order.");
    return;
  }

  setText(orderEl, orderId);
  setText(orderStatusEl, "—");
  finish("warn", KIND_TITLES[kind] || "Payment result", "Checking payment status…");

  fetch("/api/orders/" + encodeURIComponent(orderId), {
    credentials: "include",
    headers: { Accept: "application/json" },
  })
    .then(function (response) {
      if (response.status === 401) {
        window.location.href =
          "/login?return=" + encodeURIComponent("/dashboard");
        return null;
      }
      if (response.status === 404) {
        finish("bad", "Payment result", "We couldn't find that order.");
        return null;
      }
      return response.json().then(
        function (body) {
          if (
            !response.ok ||
            !body ||
            body.success !== true ||
            !body.data ||
            typeof body.data !== "object"
          ) {
            finish(
              "bad",
              KIND_TITLES[kind] || "Payment result",
              "Unable to check the payment status right now. Please try again from your dashboard."
            );
            return null;
          }
          return body.data;
        },
        function () {
          finish(
            "bad",
            KIND_TITLES[kind] || "Payment result",
            "Unable to check the payment status right now. Please try again from your dashboard."
          );
          return null;
        }
      );
    })
    .then(function (order) {
      if (!order) return;
      showOrder(order);
      resolveOrder(order.status);
    })
    .catch(function () {
      finish(
        "bad",
        KIND_TITLES[kind] || "Payment result",
        "Unable to reach the server. Please try again."
      );
    });
})();
