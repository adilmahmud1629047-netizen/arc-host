/* CDP repro: unauth-visit first (primes 401), then login, then home/refresh. */
const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.CDP_BASE || "http://127.0.0.1:5056";
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "flare-cdp2-"));
const PORT = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
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
        "eval: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)
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
    if (String(u).includes(substr)) return u;
    await sleep(200);
  }
  throw new Error("timeout url " + substr + " last=" + (await cdp.eval("location.href")));
}

async function waitExpr(cdp, expr, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await cdp.eval(expr);
    if (last) return last;
    await sleep(250);
  }
  return last;
}

(async () => {
  const unique = Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
  const email = `cdp2-${unique}@example.com`;
  const password = `Str0ngPass${unique.slice(0, 8)}!`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "CDP", lastName: "Two", email, password }),
  });
  if (reg.status !== 201) throw new Error("reg fail " + reg.status);
  console.log("registered", email);

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

    const dumpMe = () =>
      cdp.events
        .filter(
          (e) =>
            e.method === "Network.responseReceived" &&
            e.params &&
            e.params.response &&
            String(e.params.response.url).includes("/api/auth/me")
        )
        .map((e) => ({
          status: e.params.response.status,
          fromCache:
            !!(e.params.response.fromDiskCache ||
               e.params.response.fromPrefetchCache ||
               e.params.response.fromServiceWorker),
          cc: e.params.response.headers["cache-control"] || null,
        }));

    // STEP 1: unauthenticated dashboard visit (prime 401)
    console.log("--- step1: unauthenticated dashboard ---");
    await cdp.send("Page.navigate", { url: BASE + "/dashboard.html" });
    await waitUrl(cdp, "dashboard.html");
    await sleep(1500);
    console.log("href after unauth:", await cdp.eval("location.href"));
    console.log("me responses:", JSON.stringify(dumpMe()));

    // go to login
    await cdp.send("Page.navigate", { url: BASE + "/login.html" });
    await waitUrl(cdp, "login.html");
    await sleep(400);

    // STEP 2: login
    console.log("--- step2: login ---");
    await cdp.eval(`
      (function(){
        document.getElementById("login-email").value = ${JSON.stringify(email)};
        document.getElementById("login-password").value = ${JSON.stringify(password)};
        document.getElementById("login-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));
        return true;
      })()
    `);
    await waitUrl(cdp, "dashboard.html", 20000);
    const chip1 = await waitExpr(cdp, `!document.getElementById("header-account").hidden`, 10000);
    console.log("after login chip:", !!chip1, "href:", await cdp.eval("location.href"));

    // STEP 3: home then dashboard
    console.log("--- step3: home then dashboard ---");
    await cdp.eval(`window.location.href = "index.html"`);
    await waitUrl(cdp, "index.html");
    await sleep(500);
    await cdp.eval(`window.location.href = "dashboard.html"`);
    await waitUrl(cdp, "dashboard.html");
    await sleep(1500);
    const chip2 = await cdp.eval(`!document.getElementById("header-account").hidden`);
    const href2 = await cdp.eval("location.href");
    const status2 = await cdp.eval(
      `document.getElementById("dashboard-status") ? document.getElementById("dashboard-status").textContent : ""`
    );
    console.log("after home->dashboard: chip=", chip2, "href=", href2, "status=", JSON.stringify(status2));

    // STEP 4: refresh
    console.log("--- step4: refresh ---");
    await cdp.send("Page.reload", { ignoreCache: false });
    await waitUrl(cdp, "dashboard.html");
    await sleep(1500);
    const chip3 = await cdp.eval(`!document.getElementById("header-account").hidden`);
    const href3 = await cdp.eval("location.href");
    console.log("after refresh: chip=", chip3, "href=", href3);

    console.log("all /me responses:", JSON.stringify(dumpMe(), null, 2));

    const cookies = await cdp.send("Network.getCookies", { urls: [BASE + "/"] });
    console.log(
      "cookies:",
      JSON.stringify(
        (cookies.cookies || [])
          .filter((c) => c.name === "fh_session")
          .map((c) => ({ domain: c.domain, secure: c.secure, httpOnly: c.httpOnly, expires: c.expires }))
      )
    );

    const bug = (!chip2 && href2.includes("login")) || (!chip3 && href3.includes("login"));
    console.log(bug ? "BUG REPRODUCED" : "NO BUG: session persisted");

    cdp.close();
  } catch (e) {
    console.error("CDP ERROR:", e.message);
    console.error("chrome stderr:", chromeErr.slice(-500));
    process.exitCode = 1;
  } finally {
    chrome.kill();
    try {
      fs.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {}
  }
})();
