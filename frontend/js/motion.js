(function () {
  "use strict";

  var doc = document.documentElement;
  var reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  function revealAll(scope) {
    var root = scope || document;
    var nodes = root.querySelectorAll("[data-reveal]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.add("is-visible");
    }
  }

  function initReveal() {
    if (reduceQuery.matches) {
      revealAll();
      return;
    }

    doc.classList.add("js-motion");

    var nodes = document.querySelectorAll("[data-reveal]");
    if (!("IntersectionObserver" in window) || nodes.length === 0) {
      revealAll();
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      {
        root: null,
        rootMargin: "0px 0px -8% 0px",
        threshold: 0.12,
      }
    );

    for (var i = 0; i < nodes.length; i++) {
      observer.observe(nodes[i]);
    }
  }

  function initProgress() {
    if (reduceQuery.matches) return;
    if (window.matchMedia("(max-width: 40rem)").matches) return;

    var bar = document.createElement("div");
    bar.className = "scroll-progress";
    bar.setAttribute("aria-hidden", "true");
    bar.setAttribute("data-scroll-progress", "");
    document.body.insertBefore(bar, document.body.firstChild);

    var ticking = false;

    function update() {
      ticking = false;
      var height =
        document.documentElement.scrollHeight - window.innerHeight;
      var ratio = height > 0 ? window.scrollY / height : 0;
      if (ratio < 0) ratio = 0;
      if (ratio > 1) ratio = 1;
      bar.style.transform = "scaleX(" + ratio.toFixed(4) + ")";
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();
  }

  function boot() {
    initReveal();
    initProgress();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  if (typeof reduceQuery.addEventListener === "function") {
    reduceQuery.addEventListener("change", function (event) {
      if (event.matches) {
        doc.classList.remove("js-motion");
        revealAll();
      }
    });
  }
})();
