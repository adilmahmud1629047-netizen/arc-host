(function () {
  "use strict";

  var header = document.querySelector(".site-header");
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("primary-nav");

  function setNavOpen(open) {
    if (!header || !toggle) return;
    header.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  }

  if (header && toggle && nav) {
    toggle.addEventListener("click", function () {
      setNavOpen(!header.classList.contains("nav-open"));
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        setNavOpen(false);
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && header.classList.contains("nav-open")) {
        setNavOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener("click", function (event) {
      if (
        header.classList.contains("nav-open") &&
        !header.contains(event.target)
      ) {
        setNavOpen(false);
      }
    });

    window.addEventListener("resize", function () {
      if (window.matchMedia("(min-width: 62.01rem)").matches) {
        setNavOpen(false);
      }
    });
  }

  var accordionTriggers = document.querySelectorAll(".accordion-trigger");

  accordionTriggers.forEach(function (trigger) {
    trigger.addEventListener("click", function () {
      var panelId = trigger.getAttribute("aria-controls");
      var panel = panelId ? document.getElementById(panelId) : null;
      var isExpanded = trigger.getAttribute("aria-expanded") === "true";

      trigger.setAttribute("aria-expanded", String(!isExpanded));
      if (panel) {
        panel.hidden = isExpanded;
      }
    });
  });

  var contactForm = document.querySelector("[data-contact-form]");

  if (contactForm) {
    contactForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (!contactForm.checkValidity()) {
        contactForm.reportValidity();
        return;
      }

      var status = contactForm.querySelector("[data-form-status]");
      if (status) {
        status.hidden = false;
        status.textContent =
          "This form is not connected to a backend yet — your message was not sent. Form submission will be implemented in a future step.";
        status.focus();
      }
    });
  }

  document.querySelectorAll("[data-current-year]").forEach(function (node) {
    node.textContent = String(new Date().getFullYear());
  });
})();
