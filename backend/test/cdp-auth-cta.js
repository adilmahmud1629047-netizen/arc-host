/* CDP: auth-aware homepage Get Started CTA — register vs dashboard routing. */
const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.CDP_BASE || "http://127.0.0.1:5056";
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "flare-cta-"));
const PORT = 9335;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForChrome(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      return await httpGetJson(`http://127.0.0.1:${PORT}/json/list`);
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
      throw new Error(
        "eval: " +
          JSON.stringify(
            r.exceptionDetails.exception?.description || r.exceptionDetails
          )
      );
    }
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitUrl(cdp, substr, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const u = await cdp.eval("location.href");
    const pathname = String(await cdp.eval("location.pathname"));
    const ok =
      substr === "/"
        ? pathname === "/" || pathname === "/index.html"
        : String(u).includes(substr);
    if (ok) return u;
    await sleep(200);
  }
  throw new Error(
    "timeout url " + substr + " last=" + (await cdp.eval("location.href"))
  );
}

async function waitExpr(cdp, expr, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await cdp.eval(expr);
    if (last) return last;
    await sleep(250);
  }
  return last;
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log("PASS:", name, detail ? detail : "");
  } else {
    fail += 1;
    console.log("FAIL:", name, detail ? detail : "");
  }
}

function logoutCalls(cdp) {
  return cdp.events.filter(
    (e) =>
      e.method === "Network.requestWillBeSent" &&
      e.params &&
      e.params.request &&
      String(e.params.request.url).includes("/api/auth/logout")
  ).length;
}

function meStatuses(cdp) {
  return cdp.events
    .filter(
      (e) =>
        e.method === "Network.responseReceived" &&
        e.params &&
        e.params.response &&
        String(e.params.response.url).includes("/api/auth/me")
    )
    .map((e) => e.params.response.status);
}

(async () => {
  const unique = Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
  const email = `cta-${unique}@example.com`;
  const password = `Str0ngPass${unique.slice(0, 8)}!`;

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=" + PORT,
      "--user-data-dir=" + USER_DATA,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let chromeErr = "";
  chrome.stderr.on("data", (d) => (chromeErr += d));

  try {
    await waitForChrome();
    const targets = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === "page");
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // A. Anonymous: Home Get Started → register
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await waitUrl(cdp, "/");
    await sleep(1200);
    const anonHref = await cdp.eval(
      `document.querySelector('[data-auth-cta="get-started"]')?.getAttribute('href')`
    );
    check(
      "A1 anon CTA href=/register",
      anonHref === "/register",
      String(anonHref)
    );
    const anonMe = meStatuses(cdp);
    check("A2 anon /me 401", anonMe.includes(401), JSON.stringify(anonMe));

    await cdp.eval(
      `document.querySelector('.hero-actions [data-auth-cta="get-started"]').click()`
    );
    await waitUrl(cdp, "/register", 15000);
    check("A3 anon click → /register", true);

    // D. Register + login
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "CTA", lastName: "Test", email, password }),
    });
    check("D1 register 201", reg.status === 201, String(reg.status));

    await cdp.send("Page.navigate", { url: BASE + "/login" });
    await waitUrl(cdp, "/login");
    await sleep(500);
    await cdp.eval(`
      (function(){
        document.getElementById("login-email").value = ${JSON.stringify(email)};
        document.getElementById("login-password").value = ${JSON.stringify(password)};
        document.getElementById("login-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));
        return true;
      })()
    `);
    await waitUrl(cdp, "/dashboard", 20000);
    check("D2 login → dashboard", true);

    // E/F. Navigate Home, CTA should be dashboard
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await waitUrl(cdp, "/");
    await waitExpr(
      cdp,
      `document.querySelector('[data-auth-cta="get-started"]')?.getAttribute('href') === '/dashboard'`,
      10000
    );
    const loginHref = await cdp.eval(
      `document.querySelector('[data-auth-cta="get-started"]')?.getAttribute('href')`
    );
    check(
      "F1 logged-in CTA href=/dashboard",
      loginHref === "/dashboard",
      String(loginHref)
    );
    const loginMe = meStatuses(cdp).filter((s) => s === 200);
    check("F2 logged-in /me 200", loginMe.length > 0, JSON.stringify(meStatuses(cdp)));

    await cdp.eval(
      `document.querySelector('.hero-actions [data-auth-cta="get-started"]').click()`
    );
    await waitUrl(cdp, "/dashboard", 15000);
    check("F3 logged-in click → /dashboard", true);

    // Refresh Home while logged in
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await waitUrl(cdp, "/");
    await cdp.send("Page.reload", { ignoreCache: false });
    await waitUrl(cdp, "/");
    await waitExpr(
      cdp,
      `document.querySelector('[data-auth-cta="get-started"]')?.getAttribute('href') === '/dashboard'`,
      10000
    );
    const refreshHref = await cdp.eval(
      `document.querySelector('[data-auth-cta="get-started"]')?.getAttribute('href')`
    );
    check(
      "R1 refresh Home still dashboard",
      refreshHref === "/dashboard",
      String(refreshHref)
    );

    // Home → Minecraft → Back → Get Started
    await cdp.send("Page.navigate", { url: BASE + "/minecraft-hosting" });
    await waitUrl(cdp, "/minecraft-hosting");
    await sleep(800);
    // product page CTAs stay static register
    const mcCta = await cdp.eval(
      `document.querySelector('.hero-actions a[href="/register"], a.btn-mc[href="/register"]')?.getAttribute('href')`
    );
    check(
      "M1 MC product CTA stays register",
      mcCta === "/register",
      String(mcCta)
    );

    await cdp.send("Page.navigate", { url: BASE + "/" });
    await waitUrl(cdp, "/");
    await waitExpr(
      cdp,
      `document.querySelector('[data-auth-cta="get-started"]')?.getAttribute('href') === '/dashboard'`,
      10000
    );
    await cdp.eval(
      `document.querySelector('.hero-actions [data-auth-cta="get-started"]').click()`
    );
    await waitUrl(cdp, "/dashboard", 15000);
    check("N1 back Home → Get Started → dashboard", true);

    // Nav regression: logged-in header shows Dashboard link
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await waitUrl(cdp, "/");
    await waitExpr(
      cdp,
      `!document.querySelector('[data-auth-user]')?.hidden`,
      10000
    );
    const navUserVisible = await cdp.eval(
      `!document.querySelector('[data-auth-user]')?.hidden && !!document.querySelector('[data-auth-user] a[href="/dashboard"]')`
    );
    const navAnonHidden = await cdp.eval(
      `!!document.querySelector('[data-auth-anon]')?.hidden`
    );
    check("N2 logged-in nav shows Dashboard", !!navUserVisible);
    check("N3 anon block hidden", !!navAnonHidden);

    // CTA never called logout
    check("L1 no /api/auth/logout calls", logoutCalls(cdp) === 0, String(logoutCalls(cdp)));

    // Console errors (ignore favicon)
    const consoleErrors = cdp.events
      .filter((e) => e.method === "Runtime.consoleAPICalled")
      .filter((e) => e.params?.type === "error")
      .map((e) =>
        (e.params.args || [])
          .map((a) => a.value || a.description || "")
          .join(" ")
      )
      .filter((m) => !/favicon/i.test(m));
    check("E1 no console errors", consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 5)));

    // Network error path: block /me, CTA stays register (safe default)
    await cdp.send("Network.setBlockedURLs", { urls: ["*://*/api/auth/me*"] });
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await waitUrl(cdp, "/");
    await sleep(1500);
    // clear cookies first for true anon default? Use Network.clearBrowserCookies
    await cdp.send("Network.clearBrowserCookies");
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await waitUrl(cdp, "/");
    await sleep(1500);
    const netFailHref = await cdp.eval(
      `document.querySelector('[data-auth-cta="get-started"]')?.getAttribute('href')`
    );
    check(
      "X1 network/5xx fail keeps register default",
      netFailHref === "/register",
      String(netFailHref)
    );
    const stillOnHome = await cdp.eval("location.href");
    const stillPath = String(await cdp.eval("location.pathname"));
    check(
      "X2 no auto-redirect on /me failure",
      stillPath === "/" || stillPath === "/index.html",
      stillPath
    );
    await cdp.send("Network.setBlockedURLs", { urls: [] });

    console.log("\n=== SUMMARY ===");
    console.log(`pass=${pass} fail=${fail}`);
    if (fail > 0) process.exitCode = 1;

    cdp.close();
  } catch (e) {
    console.error("CDP ERROR:", e.message);
    console.error("chrome stderr:", chromeErr.slice(-800));
    process.exitCode = 1;
  } finally {
    chrome.kill();
    try {
      fs.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {}
  }
})();
