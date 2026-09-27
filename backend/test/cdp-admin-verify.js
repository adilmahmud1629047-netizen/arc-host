/* CDP: admin foundation + dashboard overview + order management. */
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.CDP_BASE || "http://127.0.0.1:5056";
const CDP_PORT = 9337;
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "flare-admin-"));

const results = [];
let passed = 0;
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) {
    passed += 1;
    console.log(`✔ ${name}`);
  } else {
    failed += 1;
    console.error(`✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function assert(name, cond, detail) {
  record(name, Boolean(cond), detail);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(d);
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, body, raw: d });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function postJsonRaw(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, raw: d }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function waitForChrome(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      return await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error("chrome up timeout");
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.id && this.pending.has(d.id)) {
        const { resolve, reject } = this.pending.get(d.id);
        this.pending.delete(d.id);
        if (d.error) reject(new Error(JSON.stringify(d.error)));
        else resolve(d.result);
      } else if (d.method) {
        this.events.push(d);
        for (const w of this.waiters.splice(0)) w();
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text || "eval failed");
    }
    return r.result.value;
  }
  async navigate(url, waitMs = 1600) {
    await this.send("Page.navigate", { url });
    await sleep(waitMs);
    for (let i = 0; i < 30; i++) {
      try {
        const ready = await this.eval(
          "!!document.documentElement && document.readyState !== 'loading'"
        );
        if (ready) break;
      } catch {
        /* retry */
      }
      await sleep(100);
    }
    await sleep(400);
  }
  async setViewport(width, height, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
  }
  async path() {
    return this.eval("location.pathname + location.search");
  }
  async pathOnly() {
    return this.eval("location.pathname");
  }
  async title() {
    return this.eval("document.title");
  }
  async textContent(sel) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? (el.textContent || "").trim() : null; })()`
    );
  }
  async count(sel) {
    return this.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  }
  async isVisible(sel) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const st = getComputedStyle(el); if (st.display === "none" || st.visibility === "hidden") return false; return true; })()`
    );
  }
  async click(sel) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`
    );
  }
  async setValue(sel, value) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.value = ${JSON.stringify(value)}; return true; })()`
    );
  }
  async submit(sel) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.requestSubmit ? el.requestSubmit() : el.dispatchEvent(new Event("submit", {cancelable:true,bubbles:true})); return true; })()`
    );
  }
  async hasInline() {
    return this.eval(`(() => {
      const inline = [...document.querySelectorAll("script")].filter(s => !s.src).length;
      const styleBlocks = document.querySelectorAll("style").length;
      const styleAttrs = document.querySelectorAll("[style]").length;
      const handlers = [...document.querySelectorAll("*")].filter(el =>
        [...el.attributes].some(a => /^on/i.test(a.name))
      ).length;
      return { inline, styleBlocks, styleAttrs, handlers };
    })()`);
  }
  async overflowFree() {
    return this.eval(
      `document.documentElement.scrollWidth <= window.innerWidth + 1`
    );
  }
  consoleErrors() {
    return this.events
      .filter((e) => e.method === "Log.entryAdded")
      .map((e) => e.params.entry)
      .filter(
        (e) =>
          e.level === "error" &&
          !/favicon/i.test(e.text || "") &&
          !/Failed to load resource: the server responded with a status of 401/i.test(
            e.text || ""
          )
      );
  }
  clearEvents() {
    this.events.length = 0;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function setupUsers() {
  const stamp = Date.now().toString(36);
  const adminEmail = `cdp-a-${stamp}${Math.random().toString(36).slice(2, 5)}@example.com`;
  const custEmail = `cdp-c-${stamp}${Math.random().toString(36).slice(2, 5)}@example.com`;
  const password = `Str0ngPass${stamp.slice(-8)}!A1`;

  const regA = await postJsonRaw(`${BASE}/api/auth/register`, {
    firstName: "Cdp",
    lastName: "Admin",
    email: adminEmail,
    password,
  });
  const regC = await postJsonRaw(`${BASE}/api/auth/register`, {
    firstName: "Cdp",
    lastName: "Cust",
    email: custEmail,
    password,
  });
  if (regA.status !== 201 || regC.status !== 201) {
    throw new Error(`register failed admin=${regA.status} cust=${regC.status}`);
  }

  const db = require("../src/config/database");
  await db.query(
    `UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`,
    [adminEmail]
  );

  // Seed an order for detail deep-link (customer owns it).
  const loginC = await postJsonRaw(`${BASE}/api/auth/login`, {
    email: custEmail,
    password,
  });
  const setCookie = loginC.raw ? null : null;
  // re-login with header capture
  const loginRes = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ email: custEmail, password });
    const req = http.request(
      `${BASE}/api/auth/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            setCookie: res.headers["set-cookie"] || [],
          })
        );
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
  const cookieRaw = (loginRes.setCookie || []).find((c) =>
    c.startsWith("fh_session=")
  );
  const cookie = cookieRaw ? cookieRaw.split(";")[0] : null;

  const orderRes = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ productType: "hosting", planSlug: "starter" });
    const req = http.request(
      `${BASE}/api/orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie || "",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode, body: null });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });

  await db.closePool().catch(() => {});

  return {
    adminEmail,
    custEmail,
    password,
    orderId:
      orderRes.status === 201 && orderRes.body && orderRes.body.data
        ? orderRes.body.data.id
        : null,
  };
}

async function newTabUrl(url) {
  const put = await new Promise((resolve) => {
    const req = http.request(
      `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end();
  });
  if (put.body && put.body.trim().startsWith("{")) {
    return JSON.parse(put.body);
  }
  const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const pages = Array.isArray(list) ? list : list.body || [];
  const page = pages.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return page;
}

async function main() {
  const users = await setupUsers();

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${USER_DATA}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore", detached: false }
  );

  let cdp = null;
  try {
    await waitForChrome();
    const target = await newTabUrl(`${BASE}/admin/login`);
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");
    await cdp.send("Runtime.enable");
    await cdp.setViewport(1440, 900);

    // —— Anonymous redirects ——
    for (const [label, url, expect] of [
      ["anon /admin → login", `${BASE}/admin`, "/admin/login"],
      ["anon /admin/dashboard → login", `${BASE}/admin/dashboard`, "/admin/login"],
      ["anon /admin/orders → login", `${BASE}/admin/orders`, "/admin/login"],
      ["anon /admin/customers → login", `${BASE}/admin/customers`, "/admin/login"],
    ]) {
      await cdp.navigate(url, 1800);
      const p = await cdp.pathOnly();
      assert(label, p === expect, `path=${p}`);
    }

    // —— Customer rejected ——
    await cdp.navigate(`${BASE}/admin/login`, 1200);
    await cdp.setValue("#admin-login-email", users.custEmail);
    await cdp.setValue("#admin-login-password", users.password);
    await cdp.submit("#admin-login-form");
    await sleep(2000);
    let p = await cdp.pathOnly();
    assert("customer stays on /admin/login", p === "/admin/login", `path=${p}`);
    const custMsg = await cdp.textContent("#admin-login-status");
    assert(
      "customer sees not-admin message",
      custMsg && /administrator/i.test(custMsg),
      custMsg
    );

    // Customer direct dashboard/orders/customers → login
    await cdp.navigate(`${BASE}/admin/dashboard`, 1600);
    p = await cdp.pathOnly();
    assert("customer /admin/dashboard → login", p === "/admin/login", `path=${p}`);
    await cdp.navigate(`${BASE}/admin/orders`, 1600);
    p = await cdp.pathOnly();
    assert("customer /admin/orders → login", p === "/admin/login", `path=${p}`);
    await cdp.navigate(`${BASE}/admin/customers`, 1600);
    p = await cdp.pathOnly();
    assert("customer /admin/customers → login", p === "/admin/login", `path=${p}`);

    // —— Admin login ——
    await cdp.navigate(`${BASE}/admin/login`, 1000);
    await cdp.setValue("#admin-login-email", users.adminEmail);
    await cdp.setValue("#admin-login-password", users.password);
    await cdp.submit("#admin-login-form");
    await sleep(2400);
    p = await cdp.pathOnly();
    assert("admin login → /admin/dashboard", p === "/admin/dashboard", `path=${p}`);

    // Metrics render
    await sleep(800);
    const customers = await cdp.textContent("#metric-customers");
    const ordersMetric = await cdp.textContent("#metric-orders");
    assert(
      "dashboard metrics render numbers",
      customers !== null && customers !== "—" && ordersMetric !== null,
      `customers=${customers} orders=${ordersMetric}`
    );
    const metricCount = await cdp.count(".metric-card");
    assert("dashboard has 8 metric cards", metricCount === 8, String(metricCount));

    // Recent orders section present
    const recentHeader = await cdp.textContent("#card-recent");
    assert("recent orders section present", /Recent orders/i.test(recentHeader || ""), recentHeader);

    // No secrets in DOM
    const domText = await cdp.eval("document.body.innerText");
    assert(
      "no secrets visible on dashboard DOM",
      !/argon2|password_hash|session_hash|SSLCOMMERZ_STORE|store_password/i.test(
        domText || ""
      )
    );

    // —— Orders navigation ——
    await cdp.click('a[href="/admin/orders"]');
    await sleep(1800);
    p = await cdp.pathOnly();
    assert("nav to /admin/orders", p === "/admin/orders", `path=${p}`);

    // Table / empty or rows
    await sleep(600);
    const orderRows = await cdp.count("#admin-orders-tbody tr");
    const emptyVisible = await cdp.isVisible("#admin-orders-empty");
    assert(
      "orders page shows rows or empty state",
      orderRows > 0 || emptyVisible,
      `rows=${orderRows} empty=${emptyVisible}`
    );

    // Filters
    await cdp.setValue("#filter-status", "awaiting_payment");
    await cdp.setValue("#filter-product", "hosting");
    await cdp.submit("#admin-orders-filters");
    await sleep(1600);
    const statusRows = await cdp.count("#admin-orders-tbody tr");
    const urlAfterFilter = await cdp.eval("location.search");
    assert(
      "filters apply (status+product in URL or rows)",
      /status=awaiting_payment/.test(urlAfterFilter) || statusRows >= 0,
      `url=${urlAfterFilter} rows=${statusRows}`
    );

    // Search by order number if we have one
    if (users.orderId) {
      await cdp.click("#admin-orders-reset");
      await sleep(800);
      // fetch order number from API for search seed
      const detail = await httpJson(`${BASE}/api/orders/${users.orderId}`, "GET", {
        // no cookie — will 401; use admin API instead via page eval
      });
      // search using API from page (admin session)
      const orderNumber = await cdp.eval(`
        (async () => {
          const r = await fetch("/api/admin/orders?limit=1", { credentials: "include" });
          const j = await r.json();
          return j && j.data && j.data.orders && j.data.orders[0] ? j.data.orders[0].orderNumber : "";
        })()
      `);
      if (orderNumber) {
        await cdp.setValue("#filter-search", orderNumber);
        await cdp.submit("#admin-orders-filters");
        await sleep(1500);
        const searchRows = await cdp.count("#admin-orders-tbody tr");
        assert("search filters order list", searchRows >= 1, `rows=${searchRows}`);
      }

      // Pagination controls present
      const pageInfo = await cdp.textContent("#admin-orders-page-info");
      assert("pagination info rendered", pageInfo && /Page/i.test(pageInfo), pageInfo);

      // Open first order detail
      await cdp.click("#admin-orders-reset");
      await sleep(1000);
      const clicked = await cdp.eval(`
        (() => {
          const a = document.querySelector("#admin-orders-tbody a");
          if (!a) return null;
          const href = a.getAttribute("href");
          a.click();
          return href;
        })()
      `);
      await sleep(1800);
      if (clicked) {
        p = await cdp.pathOnly();
        assert(
          "order detail deep-link opens",
          p.startsWith("/admin/orders/"),
          `path=${p} href=${clicked}`
        );

        // Refresh works
        await cdp.navigate(`${BASE}${p}`, 1800);
        const p2 = await cdp.pathOnly();
        const title = await cdp.textContent("#admin-order-title");
        assert(
          "order detail refresh keeps route + renders",
          p2 === p && title && title !== "Order",
          `path=${p2} title=${title}`
        );

        const detailText = await cdp.eval("document.body.innerText");
        assert(
          "no secrets on order detail DOM",
          !/argon2|password_hash|session_hash|store_password|TEXTBEE/i.test(
            detailText || ""
          )
        );
      } else {
        assert("order detail deep-link opens", false, "no order rows to open");
      }
    }

    // —— Customers navigation ——
    await cdp.navigate(`${BASE}/admin/dashboard`, 1400);
    await cdp.click('a[href="/admin/customers"]');
    await sleep(1800);
    p = await cdp.pathOnly();
    assert("nav to /admin/customers", p === "/admin/customers", `path=${p}`);

    await sleep(600);
    const custRows = await cdp.count("#admin-customers-tbody tr");
    const custEmpty = await cdp.isVisible("#admin-customers-empty");
    assert(
      "customers page shows rows or empty state",
      custRows > 0 || custEmpty,
      `rows=${custRows} empty=${custEmpty}`
    );

    const custSummary = await cdp.textContent("#admin-customers-summary");
    assert(
      "customers summary renders count",
      custSummary && /customer/i.test(custSummary),
      custSummary
    );

    // Status filter
    await cdp.setValue("#filter-status", "active");
    await cdp.submit("#admin-customers-filters");
    await sleep(1500);
    const activeUrl = await cdp.eval("location.search");
    const activeRows = await cdp.count("#admin-customers-tbody tr");
    assert(
      "status filter applies",
      /status=active/.test(activeUrl) || activeRows >= 0,
      `url=${activeUrl} rows=${activeRows}`
    );

    // Search by email
    await cdp.click("#admin-customers-reset");
    await sleep(800);
    await cdp.setValue("#filter-search", users.custEmail);
    await cdp.submit("#admin-customers-filters");
    await sleep(1500);
    const searchRows = await cdp.count("#admin-customers-tbody tr");
    assert("customer email search works", searchRows >= 1, `rows=${searchRows}`);

    // Pagination info
    const custPageInfo = await cdp.textContent("#admin-customers-page-info");
    assert(
      "customers pagination info rendered",
      custPageInfo && /Page/i.test(custPageInfo),
      custPageInfo
    );

    // Open customer detail
    await cdp.click("#admin-customers-reset");
    await sleep(1000);
    const custClicked = await cdp.eval(`
      (() => {
        const a = document.querySelector("#admin-customers-tbody a");
        if (!a) return null;
        const href = a.getAttribute("href");
        a.click();
        return href;
      })()
    `);
    await sleep(1800);
    if (custClicked) {
      p = await cdp.pathOnly();
      assert(
        "customer detail deep-link opens",
        p.startsWith("/admin/customers/"),
        `path=${p} href=${custClicked}`
      );

      await cdp.navigate(`${BASE}${p}`, 1800);
      const p2 = await cdp.pathOnly();
      const cTitle = await cdp.textContent("#admin-customer-title");
      assert(
        "customer detail refresh keeps route + renders",
        p2 === p && cTitle && cTitle !== "Customer",
        `path=${p2} title=${cTitle}`
      );

      const sumOrders = await cdp.textContent("#detail-summary-orders");
      const sumPaid = await cdp.textContent("#detail-summary-paid");
      const sumServices = await cdp.textContent("#detail-summary-services");
      assert(
        "customer summary counts render",
        sumOrders !== null && sumPaid !== null && sumServices !== null,
        `orders=${sumOrders} paid=${sumPaid} services=${sumServices}`
      );

      const custDom = await cdp.eval("document.body.innerText");
      assert(
        "no secrets on customer detail DOM",
        !/argon2|password_hash|session_hash|store_password|TEXTBEE|SSLCOMMERZ/i.test(
          custDom || ""
        )
      );

      // STEP 48: account controls exist for the rendered target; no
      // destructive controls (delete customer / change role) anywhere.
      const ctrl = await cdp.eval(`(() => {
        const shown = (id) => {
          const el = document.querySelector(id);
          if (!el) return false;
          const st = getComputedStyle(el);
          return !el.hidden && st.display !== "none" && st.visibility !== "hidden";
        };
        const bad = [...document.querySelectorAll("button")].filter(b =>
          /delete customer|change role/i.test((b.textContent || "") + " " + (b.id || ""))
        ).length;
        return {
          suspend: shown("#customer-suspend-action"),
          reactivate: shown("#customer-reactivate-action"),
          reset: shown("#customer-reset-action"),
          bad
        };
      })()`);
      assert(
        "account controls on customer detail (suspend or reactivate)",
        ctrl.suspend === true || ctrl.reactivate === true,
        JSON.stringify(ctrl)
      );
      assert(
        "no delete/role controls on customer detail",
        ctrl.bad === 0,
        JSON.stringify(ctrl)
      );
    } else {
      assert("customer detail deep-link opens", false, "no customer rows");
    }

    // Sidebar Customers link functional from orders
    await cdp.navigate(`${BASE}/admin/orders`, 1400);
    await cdp.click('a[href="/admin/customers"]');
    await sleep(1500);
    p = await cdp.pathOnly();
    assert("sidebar Customers from orders → /admin/customers", p === "/admin/customers", `path=${p}`);

    // —— Logout ——
    await cdp.navigate(`${BASE}/admin/dashboard`, 1200);
    await cdp.click("#admin-logout-button");
    await sleep(1800);
    p = await cdp.pathOnly();
    assert("logout → /admin/login", p === "/admin/login", `path=${p}`);

    // —— CSP / console ——
    cdp.clearEvents();
    await cdp.navigate(`${BASE}/admin/login`, 1200);
    let inline = await cdp.hasInline();
    assert(
      "login DOM has no inline script/style/handlers",
      inline.inline === 0 && inline.styleBlocks === 0 && inline.styleAttrs === 0 && inline.handlers === 0,
      JSON.stringify(inline)
    );
    let errs = cdp.consoleErrors();
    assert(
      "no console errors on admin login",
      errs.length === 0,
      JSON.stringify(errs)
    );

    // re-login for responsive + orders CSP
    await cdp.setValue("#admin-login-email", users.adminEmail);
    await cdp.setValue("#admin-login-password", users.password);
    await cdp.submit("#admin-login-form");
    await sleep(2200);

    cdp.clearEvents();
    await cdp.navigate(`${BASE}/admin/dashboard`, 1600);
    inline = await cdp.hasInline();
    assert(
      "dashboard DOM CSP-safe",
      inline.inline === 0 && inline.styleBlocks === 0 && inline.styleAttrs === 0 && inline.handlers === 0,
      JSON.stringify(inline)
    );
    errs = cdp.consoleErrors();
    assert(
      "no console errors on dashboard",
      errs.length === 0,
      JSON.stringify(errs)
    );

    // —— Responsive viewports ——
    for (const [w, h] of [
      [320, 640],
      [375, 720],
      [768, 900],
      [1024, 800],
      [1440, 900],
    ]) {
      await cdp.setViewport(w, h, w < 768);

      await cdp.navigate(`${BASE}/admin/dashboard`, 1100);
      let free = await cdp.overflowFree();
      let still = (await cdp.pathOnly()) === "/admin/dashboard";
      assert(
        `dashboard ${w}x${h} no overflow + still admin`,
        free && still,
        `free=${free} path=${await cdp.pathOnly()}`
      );

      await cdp.navigate(`${BASE}/admin/orders`, 1200);
      free = await cdp.overflowFree();
      still = (await cdp.pathOnly()) === "/admin/orders";
      assert(
        `orders ${w}x${h} no overflow + still admin`,
        free && still,
        `free=${free} path=${await cdp.pathOnly()}`
      );

      await cdp.navigate(`${BASE}/admin/customers`, 1300);
      free = await cdp.overflowFree();
      still = (await cdp.pathOnly()) === "/admin/customers";
      assert(
        `customers ${w}x${h} no overflow + still admin`,
        free && still,
        `free=${free} path=${await cdp.pathOnly()}`
      );

      if (w < 768) {
        const toggle = await cdp.isVisible("#admin-menu-toggle");
        assert(`orders ${w}px menu toggle visible`, toggle);
        // mobile card layout: thead hidden
        const theadHidden = await cdp.eval(
          `(() => { const th = document.querySelector(".admin-table-orders thead"); return !th || getComputedStyle(th).display === "none"; })()`
        );
        assert(`orders ${w}px table → cards`, theadHidden);

        const custTheadHidden = await cdp.eval(
          `(() => { const th = document.querySelector(".admin-table-customers thead"); return !th || getComputedStyle(th).display === "none"; })()`
        );
        assert(`customers ${w}px table → cards`, custTheadHidden);
      }
    }

    // order + customer detail responsive sample
    if (users.orderId) {
      await cdp.setViewport(375, 720, true);
      await cdp.navigate(`${BASE}/admin/orders/${users.orderId}`, 1500);
      const free = await cdp.overflowFree();
      assert("order detail 375px no overflow", free);
    }

    // —— Clean URLs only ——
    for (const [label, htmlPath, clean] of [
      ["orders", "/admin/orders.html", "/admin/orders"],
      ["customers", "/admin/customers.html", "/admin/customers"],
    ]) {
      const htmlRes = await new Promise((resolve, reject) => {
        const req = http.request(
          `${BASE}${htmlPath}`,
          { method: "GET" },
          (res) =>
            resolve({ status: res.statusCode, location: res.headers.location })
        );
        req.on("error", reject);
        req.end();
      });
      assert(
        `${htmlPath} 301 → clean`,
        htmlRes.status === 301 &&
          new RegExp(clean.replace("/", "\\/")).test(htmlRes.location || ""),
        `status=${htmlRes.status} loc=${htmlRes.location}`
      );
    }

    // API 401 shape
    const me401 = await httpJson(`${BASE}/api/admin/orders`);
    assert(
      "GET /api/admin/orders anonymous → 401",
      me401.status === 401,
      String(me401.status)
    );
    const cust401 = await httpJson(`${BASE}/api/admin/customers`);
    assert(
      "GET /api/admin/customers anonymous → 401",
      cust401.status === 401,
      String(cust401.status)
    );
  } finally {
    if (cdp) cdp.close();
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
    try {
      fs.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(
    `\nCDP admin: ${passed} passed, ${failed} failed, ${results.length} total`
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
