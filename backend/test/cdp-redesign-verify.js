const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const CDP_PORT = 9334;
const BASE = process.env.CDP_BASE || "http://127.0.0.1:5000";
const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function request(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function get(url) {
  return request("GET", url);
}

async function waitForDevtools(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await get(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.status === 200) return JSON.parse(r.data);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("CDP not ready");
}

async function newTab(url) {
  const target = `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`;
  let r = await request("PUT", target);
  if (r.status !== 200 || !r.data.trim().startsWith("{")) {
    r = await get(target);
  }
  if (r.status !== 200 || !r.data.trim().startsWith("{")) {
    r = await request("PUT", `http://127.0.0.1:${CDP_PORT}/json/new`);
  }
  if (!r.data.trim().startsWith("{")) {
    throw new Error(`new tab failed: ${r.status} ${r.data.slice(0, 200)}`);
  }
  return JSON.parse(r.data);
}

function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    const listeners = [];
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        on(fn) {
          listeners.push(fn);
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        listeners.forEach((fn) => fn(msg));
      }
    });
    ws.addEventListener("error", reject);
  });
}

async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text || "eval failed");
  }
  return r.result.value;
}

async function navigate(cdp, url, waitMs = 1200) {
  await cdp.send("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, waitMs));
  for (let i = 0; i < 25; i++) {
    try {
      const r = await cdp.send("Runtime.evaluate", {
        expression: "!!document.documentElement && document.readyState !== 'loading'",
        returnByValue: true,
      });
      if (r.result && r.result.value) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function setViewport(cdp, width, height, mobile) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile: !!mobile,
  });
}

async function main() {
  const profile = path.join(
    process.env.TEMP || ".",
    `flare-redesign-cdp-${Date.now()}`
  );
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  try {
    await waitForDevtools();
    const tab = await newTab(`${BASE}/`);
    const cdp = await connectWebSocket(tab.webSocketDebuggerUrl);
    const consoleErrors = [];
    cdp.on((msg) => {
      if (msg.method === "Runtime.consoleAPICalled") {
        if (msg.params.type === "error") {
          consoleErrors.push(
            msg.params.args
              .map((a) => a.value || a.description || "")
              .join(" ")
          );
        }
      }
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(
          msg.params.exceptionDetails?.text || "exceptionThrown"
        );
      }
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const results = [];
    const check = (name, ok, detail = "") => {
      results.push({ name, ok, detail });
      console.log(
        `${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`
      );
    };

    const viewports = [
      [320, 640, true],
      [375, 812, true],
      [768, 1024, true],
      [1024, 768, false],
      [1440, 900, false],
    ];

    const pages = [
      "/",
      "/web-hosting",
      "/vps-hosting",
      "/minecraft-hosting",
      "/about",
      "/faq",
      "/contact",
      "/login",
      "/register",
      "/checkout",
      "/payment-success",
      "/payment-failed",
      "/payment-cancelled",
    ];

    // Homepage structure + currency
    await setViewport(cdp, 1440, 900, false);
    await navigate(cdp, `${BASE}/`);
    const home = await evalIn(
      cdp,
      `(() => {
        const bodyText = document.body.innerText;
        const sections = [...document.querySelectorAll('main > section')].map(s => ({
          id: s.id || null,
          cls: s.className.split(' ').slice(0,3).join('.')
        }));
        return {
          h1: document.querySelector('h1')?.textContent?.replace(/\\s+/g,' ').trim(),
          heroLabel: document.querySelector('.cx-hero .cx-eyebrow')?.textContent?.replace(/\\s+/g,' ').trim(),
          heroVisual: !!document.querySelector('.cx-hero-visual'),
          trustItems: document.querySelectorAll('.cx-trust-item').length,
          why: !!document.getElementById('why'),
          features: !!document.getElementById('features'),
          featureTiles: document.querySelectorAll('.cx-feature-grid .cx-card').length,
          cta: !!document.querySelector('.cx-cta'),
          usd: /\\$\\d/.test(bodyText),
          authNav: !!document.querySelector('[data-auth-nav]'),
          anon: !!document.querySelector('[data-auth-anon]:not([hidden])'),
          userHidden: !!document.querySelector('[data-auth-user][hidden]'),
          inlineStyle: !!document.querySelector('style') ||
            [...document.querySelectorAll('[style]')].some(
              el => !el.hasAttribute('data-scroll-progress')
            ),
          sections,
          getStarted: !!document.querySelector('.cx-hero-actions [data-auth-cta="get-started"]'),
          ctas: [...document.querySelectorAll('.cx-hero-actions .cx-btn')].map(b => b.textContent.trim()),
        };
      })()`
    );
    check(
      "Home: hero heading",
      home.h1 === "Minecraft server hosting that scales as you play",
      home.h1
    );
    check(
      "Home: hero label",
      /premium/i.test(home.heroLabel || "") && /minecraft/i.test(home.heroLabel || ""),
      home.heroLabel
    );
    check("Home: hero visual mock", home.heroVisual);
    check("Home: trust strip items", home.trustItems >= 4, `items=${home.trustItems}`);
    check("Home: why section", home.why);
    check("Home: features section", home.features);
    check("Home: varied feature tiles", home.featureTiles >= 6, `tiles=${home.featureTiles}`);
    check("Home: final CTA", home.cta);
    check("Home: no USD prices", home.usd === false);
    check("Home: auth-nav present", home.authNav);
    check("Home: anon visible", home.anon);
    check("Home: user hidden", home.userHidden);
    check("Home: no inline style attrs", home.inlineStyle === false);
    check("Home: Get Started CTA", home.getStarted, JSON.stringify(home.ctas));
    check(
      "Home: Compare plans CTA",
      home.ctas.some((t) => /compare plans/i.test(t)),
      JSON.stringify(home.ctas)
    );

    // formatPrice BDT
    const priceFmt = await evalIn(
      cdp,
      `(() => {
        if (!window.FlareCatalog) return { ok: false, reason: 'no catalog' };
        return {
          ok: true,
          bdt: window.FlareCatalog.formatPrice({ currency: 'BDT', price: '299.00' }),
          bdt2: window.FlareCatalog.formatPrice({ currency: 'BDT', price: '1499.00' }),
        };
      })()`
    );
    // load plans.js on web-hosting for formatPrice check
    await navigate(cdp, `${BASE}/web-hosting`);
    await new Promise((r) => setTimeout(r, 700));
    const priceFmt2 = await evalIn(
      cdp,
      `(() => {
        if (!window.FlareCatalog) return { ok: false };
        return {
          ok: true,
          bdt: window.FlareCatalog.formatPrice({ currency: 'BDT', price: '299.00' }),
          bdt2: window.FlareCatalog.formatPrice({ currency: 'BDT', price: '1499.00' }),
          usd: window.FlareCatalog.formatPrice({ currency: 'USD', price: '9.00' }),
        };
      })()`
    );
    check("formatPrice: BDT → ৳299", priceFmt2.ok && priceFmt2.bdt === "৳299", JSON.stringify(priceFmt2));
    check("formatPrice: BDT → ৳1499", priceFmt2.ok && priceFmt2.bdt2 === "৳1499", JSON.stringify(priceFmt2));
    check(
      "formatPrice: non-BDT keeps code",
      priceFmt2.ok && priceFmt2.usd === "USD 9.00",
      JSON.stringify(priceFmt2)
    );

    // web/vps catalog cards use ৳ after API load
    const readCatalog = () =>
      evalIn(
        cdp,
        `(() => {
          const amounts = [...document.querySelectorAll('#plans-grid .cx-plan-amount')].map(a => a.textContent.trim());
          const usd = amounts.some(a => /\\$/.test(a));
          const bdt = amounts.some(a => /৳/.test(a));
          return { amounts, usd, bdt, count: amounts.length };
        })()`
      );
    const waitForCatalog = async () => {
      let last = { amounts: [], usd: false, bdt: false, count: 0 };
      for (let i = 0; i < 10; i++) {
        last = await readCatalog();
        if (last.count > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return last;
    };

    await navigate(cdp, `${BASE}/web-hosting`);
    const catalog = await waitForCatalog();
    check("Web catalog: BDT amounts", catalog.count > 0 && catalog.bdt && !catalog.usd, JSON.stringify(catalog));

    await navigate(cdp, `${BASE}/vps-hosting`);
    const vpsCatalog = await waitForCatalog();
    check("VPS catalog: BDT amounts", vpsCatalog.count > 0 && vpsCatalog.bdt && !vpsCatalog.usd, JSON.stringify(vpsCatalog));

    // Minecraft page copy
    await navigate(cdp, `${BASE}/minecraft-hosting`);
    const mc = await evalIn(
      cdp,
      `(() => ({
        h1: document.querySelector('h1')?.textContent?.replace(/\\s+/g,' ').trim(),
        current: document.querySelector('.primary-nav a[aria-current="page"]')?.getAttribute('href'),
        plans: document.querySelectorAll('#pricing-grid .cx-plan').length,
        types: document.querySelectorAll('#config-apps .cx-chip').length,
      }))()`
    );
    check(
      "MC page: heading",
      mc.h1 === "Choose your setup. We handle the server.",
      mc.h1
    );
    check("MC page: aria-current", mc.current === "/minecraft-hosting", String(mc.current));
    check("MC page: plans from catalog", mc.plans >= 1, `plans=${mc.plans}`);
    check("MC page: application choices", mc.types >= 5, `types=${mc.types}`);

    // Viewport overflow checks across pages
    for (const [w, h, mobile] of viewports) {
      await setViewport(cdp, w, h, mobile);
      for (const page of ["/", "/minecraft-hosting", "/web-hosting", "/vps-hosting"]) {
        await navigate(cdp, `${BASE}${page}`);
        const ov = await evalIn(
          cdp,
          `(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))()`
        );
        check(
          `Overflow ${w}px ${page}`,
          ov.sw <= ov.cw + 2,
          `sw=${ov.sw} cw=${ov.cw}`
        );
      }
    }

    // Mobile nav toggle + grid stacking
    await setViewport(cdp, 375, 812, true);
    await navigate(cdp, `${BASE}/`);
    const mobileNav = await evalIn(
      cdp,
      `(() => {
        const toggle = document.querySelector('.nav-toggle');
        const visible = toggle && getComputedStyle(toggle).display !== 'none';
        const grid = document.querySelector('.cx-feature-grid');
        const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
        return { visible, cols };
      })()`
    );
    check("Mobile: nav toggle visible", mobileNav.visible);
    check("Mobile: home feature grid 1 col", mobileNav.cols === 1, `cols=${mobileNav.cols}`);

    await navigate(cdp, `${BASE}/minecraft-hosting`);
    const mcGridCols = await evalIn(
      cdp,
      `(() => {
        const grid = document.querySelector('#pricing-grid');
        return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
      })()`
    );
    check("Mobile: mc plans 1 col", mcGridCols === 1, `cols=${mcGridCols}`);

    // All public pages load + auth-nav + no $
    await setViewport(cdp, 1440, 900, false);
    for (const page of pages) {
      await navigate(cdp, `${BASE}${page}`);
      const info = await evalIn(
        cdp,
        `(() => {
          const t = document.body.innerText;
          return {
            auth: !!document.querySelector('[data-auth-nav]'),
            authScript: [...document.scripts].some(s => (s.getAttribute('src')||'').includes('auth-nav.js')),
            usd: /\\$\\d/.test(t),
            path: location.pathname,
          };
        })()`
      );
      if (page !== "/dashboard") {
        check(`Page ${page}: auth-nav`, info.auth && info.authScript);
      }
      check(`Page ${page}: no $ prices`, info.usd === false);
    }

    // Accordion interaction
    await navigate(cdp, `${BASE}/faq`);
    await evalIn(
      cdp,
      `document.querySelector('.accordion-trigger').click(); true`
    );
    await new Promise((r) => setTimeout(r, 200));
    const acc = await evalIn(
      cdp,
      `(() => {
        const btn = document.querySelector('.accordion-trigger');
        if (!btn) return { expanded: null, hidden: null };
        const panel = document.getElementById(btn.getAttribute('aria-controls'));
        return { expanded: btn.getAttribute('aria-expanded'), hidden: panel ? panel.hasAttribute('hidden') : null };
      })()`
    );
    check("FAQ accordion opens", acc.expanded === "true" && acc.hidden === false, JSON.stringify(acc));

    const realErrors = consoleErrors.filter((e) => e && !/favicon/i.test(e));
    check("No console errors (excl. favicon)", realErrors.length === 0, realErrors.join(" | "));

    const fails = results.filter((r) => !r.ok);
    console.log("\n=== SUMMARY ===");
    console.log(`pass=${results.length - fails.length} fail=${fails.length}`);
    if (fails.length) {
      fails.forEach((f) => console.log("FAIL", f.name, f.detail));
      process.exitCode = 1;
    }

    cdp.close();
  } finally {
    try {
      chrome.kill();
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
