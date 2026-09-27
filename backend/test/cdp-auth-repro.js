/* Headless Chrome CDP reproduction of the reported auth bug. */
const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const CHROME =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.CDP_BASE || "http://127.0.0.1:5056";
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "flare-cdp-"));
const PORT = 9333;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function waitForChrome(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`);
      return list;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome DevTools endpoint did not come up");
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result);
      } else if (data.method) {
        this.events.push(data);
        for (const w of this.eventWaiters.splice(0)) w();
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

  async waitForEvent(name, timeoutMs = 15000) {
    const found = this.events.find((e) => e.method === name);
    if (found) return found;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 200);
        this.eventWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
      const hit = this.events.find((e) => e.method === name);
      if (hit) return hit;
    }
    throw new Error("timeout waiting for " + name);
  }

  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        "eval exception: " +
          JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await cdp.eval("location.href");
    if (String(url).includes(substr)) return url;
    await sleep(200);
  }
  throw new Error("timeout waiting for url containing " + substr + "; last=" + (await cdp.eval("location.href")));
}

async function waitExpr(cdp, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await cdp.eval(expr);
    if (last) return last;
    await sleep(250);
  }
  throw new Error("timeout waiting for expr: " + expr + " last=" + JSON.stringify(last));
}

async function registerViaHttp() {
  const unique = Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
  const email = `cdp-${unique}@example.com`;
  const password = `Str0ngPass${unique.slice(0, 8)}!`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "CDP",
      lastName: "Test",
      email,
      password,
    }),
  });
  if (res.status !== 201) throw new Error("register failed " + res.status);
  return { email, password };
}

(async () => {
  const { email, password } = await registerViaHttp();
  console.log("registered:", email);

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
    console.log("chrome up");

    const targets = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === "page");
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();

    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // ---- A. login page -> submit ----
    await cdp.send("Page.navigate", { url: `${BASE}/login.html` });
    await waitUrl(cdp, "login.html");
    await sleep(500);

    await cdp.eval(`
      (function(){
        document.getElementById("login-email").value = ${JSON.stringify(email)};
        document.getElementById("login-password").value = ${JSON.stringify(password)};
        document.getElementById("login-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));
        return true;
      })()
    `);

    await waitUrl(cdp, "dashboard.html", 20000);
    console.log("A. redirected to dashboard OK");

    // wait for account chip visible (auth gate passed)
    await waitExpr(cdp, `!document.getElementById("header-account").hidden`);
    console.log("A. dashboard account chip visible -> logged in");

    // inspect cookie attributes via CDP
    const cookies = await cdp.send("Network.getCookies", { urls: [BASE + "/"] });
    const fh = (cookies.cookies || []).filter((c) => c.name === "fh_session");
    console.log("A. fh_session cookies:", JSON.stringify(fh.map(c => ({domain:c.domain, path:c.path, secure:c.secure, httpOnly:c.httpOnly, sameSite:c.sameSite, expires:c.expires, size:c.size}))));

    // ---- D. refresh dashboard ----
    await cdp.send("Page.reload", { ignoreCache: false });
    await waitUrl(cdp, "dashboard.html");
    let refreshOutcome = "unknown";
    try {
      await waitExpr(cdp, `!document.getElementById("header-account").hidden`, 8000);
      refreshOutcome = "still-logged-in";
    } catch {
      const href = await cdp.eval("location.href");
      const status = await cdp.eval(
        `document.getElementById("dashboard-status") ? document.getElementById("dashboard-status").textContent : ""`
      );
      refreshOutcome = "LOGGED-OUT href=" + href + " status=" + JSON.stringify(status);
    }
    console.log("D. after refresh:", refreshOutcome);

    // re-login if we got kicked out (to continue later steps from a logged-in state)
    if (refreshOutcome !== "still-logged-in") {
      console.log("BUG REPRODUCED at refresh step");
    }

    // ensure logged in for remaining steps
    let hrefNow = await cdp.eval("location.href");
    if (!hrefNow.includes("dashboard.html")) {
      // got redirected to login — log in again
      await sleep(500);
      await cdp.eval(`
        (function(){
          document.getElementById("login-email").value = ${JSON.stringify(email)};
          document.getElementById("login-password").value = ${JSON.stringify(password)};
          document.getElementById("login-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));
          return true;
        })()
      `);
      await waitUrl(cdp, "dashboard.html", 20000);
      await waitExpr(cdp, `!document.getElementById("header-account").hidden`);
      console.log("(re-logged in for remaining steps)");
    }

    // ---- F/G. home -> back to dashboard ----
    await cdp.eval(`window.location.href = "index.html"`);
    await waitUrl(cdp, "index.html");
    await sleep(400);
    await cdp.eval(`window.location.href = "dashboard.html"`);
    await waitUrl(cdp, "dashboard.html");
    let homeOutcome = "unknown";
    try {
      await waitExpr(cdp, `!document.getElementById("header-account").hidden`, 8000);
      homeOutcome = "still-logged-in";
    } catch {
      const href = await cdp.eval("location.href");
      homeOutcome = "LOGGED-OUT href=" + href;
    }
    console.log("F/G. after Home -> Dashboard:", homeOutcome);
    if (homeOutcome !== "still-logged-in") {
      console.log("BUG REPRODUCED at home-nav step");
    }

    // ---- I/J. another public page -> dashboard ----
    if (homeOutcome !== "still-logged-in") {
      await sleep(500);
      await cdp.eval(`
        (function(){
          document.getElementById("login-email").value = ${JSON.stringify(email)};
          document.getElementById("login-password").value = ${JSON.stringify(password)};
          document.getElementById("login-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));
          return true;
        })()
      `);
      await waitUrl(cdp, "dashboard.html", 20000);
      await waitExpr(cdp, `!document.getElementById("header-account").hidden`);
    }
    await cdp.eval(`window.location.href = "about.html"`);
    await waitUrl(cdp, "about.html");
    await sleep(400);
    await cdp.eval(`window.location.href = "dashboard.html"`);
    await waitUrl(cdp, "dashboard.html");
    let aboutOutcome = "unknown";
    try {
      await waitExpr(cdp, `!document.getElementById("header-account").hidden`, 8000);
      aboutOutcome = "still-logged-in";
    } catch {
      const href = await cdp.eval("location.href");
      aboutOutcome = "LOGGED-OUT href=" + href;
    }
    console.log("I/J. after About -> Dashboard:", aboutOutcome);

    // final cookie dump
    const cookies2 = await cdp.send("Network.getCookies", { urls: [BASE + "/"] });
    console.log(
      "final fh_session cookies:",
      JSON.stringify(
        (cookies2.cookies || [])
          .filter((c) => c.name === "fh_session")
          .map((c) => ({ domain: c.domain, path: c.path, secure: c.secure, expires: c.expires, size: c.size }))
      )
    );

    // capture any Set-Cookie / auth responses seen
    const authEvents = cdp.events.filter(
      (e) =>
        e.method === "Network.responseReceived" &&
        e.params &&
        e.params.response &&
        String(e.params.response.url).includes("/api/auth/")
    );
    for (const ev of authEvents) {
      const r = ev.params.response;
      console.log(
        "saw response:",
        r.status,
        r.url,
        "set-cookie:",
        r.headers["set-cookie"] || "(none)"
      );
    }

    cdp.close();
  } catch (e) {
    console.error("CDP ERROR:", e.message);
    console.error("chrome stderr tail:", chromeErr.slice(-800));
    process.exitCode = 1;
  } finally {
    chrome.kill();
    try {
      fs.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {}
  }
})();
