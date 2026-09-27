const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const CDP_PORT = 9333;
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:5000';
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function request(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function get(url) {
  return request('GET', url);
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
  throw new Error('CDP not ready');
}

async function newTab(url) {
  const target = `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`;
  let r = await request('PUT', target);
  if (r.status !== 200 || !r.data.trim().startsWith('{')) {
    r = await get(target);
  }
  if (r.status !== 200 || !r.data.trim().startsWith('{')) {
    r = await request('PUT', `http://127.0.0.1:${CDP_PORT}/json/new`);
  }
  if (!r.data.trim().startsWith('{')) {
    throw new Error(`new tab failed: ${r.status} ${r.data.slice(0, 200)}`);
  }
  const tab = JSON.parse(r.data);
  // ensure it points at requested url
  if (url && tab.id) {
    await request('GET', `http://127.0.0.1:${CDP_PORT}/json/activate/${tab.id}`);
  }
  return tab;
}

function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    const listeners = [];
    ws.addEventListener('open', () => {
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
    ws.addEventListener('message', (ev) => {
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
    ws.addEventListener('error', reject);
  });
}

async function evalIn(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text || 'eval failed');
  }
  return r.result.value;
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 1400));
}

async function main() {
  const profile = path.join(
    process.env.TEMP || '.',
    `flare-mc-cdp-${Date.now()}`
  );
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    await waitForDevtools();
    const tab = await newTab(`${BASE}/`);
    const cdp = await connectWebSocket(tab.webSocketDebuggerUrl);
    const consoleErrors = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        if (msg.params.type === 'error') {
          consoleErrors.push(
            msg.params.args
              .map((a) => a.value || a.description || '')
              .join(' ')
          );
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          msg.params.exceptionDetails?.text || 'exceptionThrown'
        );
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const results = [];
    const check = (name, ok, detail = '') => {
      results.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
    };

    // 1) Homepage Minecraft section + nav
    await navigate(cdp, `${BASE}/`);
    await new Promise((r) => setTimeout(r, 600));
    const home = await evalIn(
      cdp,
      `(() => {
        const nav = document.querySelector('.primary-nav a[href="/minecraft-hosting"]');
        const sec = document.getElementById('minecraft');
        const plans = document.querySelectorAll('.mc-plans-grid .mc-plan-card').length;
        const anon = document.querySelector('[data-auth-anon]');
        const user = document.querySelector('[data-auth-user]');
        return {
          nav: !!nav,
          section: !!sec,
          plans,
          anonVisible: !!anon && !anon.hasAttribute('hidden'),
          userHidden: !!user && user.hasAttribute('hidden'),
          title: document.title,
        };
      })()`
    );
    check('Home: Minecraft nav link', home.nav);
    check('Home: Minecraft section', home.section);
    check('Home: 4 MC plan cards', home.plans === 4, `plans=${home.plans}`);
    check('Home: anon auth UI visible', home.anonVisible);
    check('Home: user auth UI hidden', home.userHidden);

    // 2) Navigate to minecraft-hosting via nav
    await evalIn(
      cdp,
      `document.querySelector('.primary-nav a[href="/minecraft-hosting"]').click(); true`
    );
    await new Promise((r) => setTimeout(r, 900));
    const mc = await evalIn(
      cdp,
      `(() => {
        const cur = document.querySelector('.primary-nav a[aria-current="page"]');
        const plans = document.querySelectorAll('#plans .mc-plan-card').length;
        const types = document.querySelectorAll('.mc-type-card').length;
        const feats = document.querySelectorAll('#features .mc-feature').length;
        const faq = document.querySelectorAll('#faq .accordion-item').length;
        const scripts = [...document.scripts].map(s => s.getAttribute('src'));
        const authNav = scripts.some(s => (s||'').includes('js/auth-nav.js'));
        const hooks = !!document.querySelector('[data-auth-nav]');
        return {
          path: location.pathname,
          current: cur ? cur.getAttribute('href') : null,
          plans, types, feats, faq, authNav, hooks,
          h1: document.querySelector('h1')?.textContent?.trim(),
          scripts,
        };
      })()`
    );
    check('MC page: path', mc.path === '/minecraft-hosting', mc.path);
    check('MC page: aria-current', mc.current === '/minecraft-hosting', String(mc.current));
    check('MC page: 4 plans', mc.plans === 4, `plans=${mc.plans}`);
    check('MC page: 5 server types', mc.types === 5, `types=${mc.types}`);
    check('MC page: 6 features', mc.feat === 6 || mc.feats === 6, `feats=${mc.feats}`);
    check('MC page: 4 FAQ items', mc.faq === 4, `faq=${mc.faq}`);
    check('MC page: auth-nav script', mc.authNav);
    check('MC page: auth-nav hooks', mc.hooks);

    // 3) FAQ accordion keyboard/click
    await evalIn(
      cdp,
      `document.querySelector('#faq .accordion-trigger').click(); true`
    );
    await new Promise((r) => setTimeout(r, 200));
    const acc = await evalIn(
      cdp,
      `(() => {
        const btn = document.querySelector('#faq .accordion-trigger');
        const panel = document.getElementById(btn.getAttribute('aria-controls'));
        return { expanded: btn.getAttribute('aria-expanded'), hidden: panel.hasAttribute('hidden') };
      })()`
    );
    check('MC FAQ opens', acc.expanded === 'true' && acc.hidden === false);

    // 4) Desktop horizontal overflow
    const overflowDesk = await evalIn(
      cdp,
      `(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))()`
    );
    check(
      'No desktop horizontal overflow',
      overflowDesk.sw <= overflowDesk.cw + 2,
      `sw=${overflowDesk.sw} cw=${overflowDesk.cw}`
    );

    // 5) Mobile viewport
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await navigate(cdp, `${BASE}/`);
    await new Promise((r) => setTimeout(r, 700));
    const mobile = await evalIn(
      cdp,
      `(() => {
        const grid = document.querySelector('.mc-plans-grid');
        const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
        const toggle = document.querySelector('.nav-toggle');
        const toggleVisible = toggle && getComputedStyle(toggle).display !== 'none';
        return {
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
          cols,
          toggleVisible,
          section: !!document.getElementById('minecraft'),
        };
      })()`
    );
    check(
      'Mobile: no horizontal overflow',
      mobile.sw <= mobile.cw + 2,
      `sw=${mobile.sw} cw=${mobile.cw}`
    );
    check('Mobile: plans 1 column', mobile.cols === 1, `cols=${mobile.cols}`);
    check('Mobile: nav toggle visible', mobile.toggleVisible);
    check('Mobile: Minecraft section present', mobile.section);

    // tablet
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 768,
      height: 1024,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await navigate(cdp, `${BASE}/minecraft-hosting`);
    await new Promise((r) => setTimeout(r, 700));
    const tablet = await evalIn(
      cdp,
      `(() => {
        const grid = document.querySelector('.mc-plans-grid');
        const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
        return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, cols };
      })()`
    );
    check(
      'Tablet: no horizontal overflow',
      tablet.sw <= tablet.cw + 2,
      `sw=${tablet.sw} cw=${tablet.cw}`
    );
    check('Tablet: plans 2 columns', tablet.cols === 2, `cols=${tablet.cols}`);

    // reset metrics
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // 6) auth-nav still works (anonymous stays anon)
    await navigate(cdp, `${BASE}/`);
    await new Promise((r) => setTimeout(r, 900));
    const auth = await evalIn(
      cdp,
      `(() => {
        const anon = document.querySelector('[data-auth-anon]');
        const user = document.querySelector('[data-auth-user]');
        return {
          path: location.pathname,
          anonVisible: !!anon && !anon.hasAttribute('hidden'),
          userHidden: !user || user.hasAttribute('hidden'),
        };
      })()`
    );
    check('Auth-nav: stays on index', auth.path === '/' || auth.path === '/index.html', auth.path);
    check('Auth-nav: anon UI after load', auth.anonVisible);
    check('Auth-nav: user UI hidden', auth.userHidden);

    // 7) reduced-motion friendly — standard MC cards have no infinite animation;
    // only the featured/popular card may have a subtle glow
    const anim = await evalIn(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('.mc-plan-card')];
        const bad = cards
          .filter(c => !c.classList.contains('mc-plan-featured'))
          .map(c => {
            const s = getComputedStyle(c);
            return { name: s.animationName, duration: s.animationDuration };
          })
          .filter(a => a.name && a.name !== 'none' && a.duration !== '0s');
        const featured = document.querySelector('.mc-plan-card.mc-plan-featured');
        const f = featured ? getComputedStyle(featured) : null;
        return { bad, featuredAnim: f ? f.animationName : null };
      })()`
    );
    check(
      'MC cards: no infinite animation on non-featured',
      anim.bad.length === 0,
      JSON.stringify(anim)
    );

    // console errors — filter favicon 404 noise
    const realErrors = consoleErrors.filter(
      (e) => e && !/favicon/i.test(e)
    );
    check('No console errors (excl. favicon)', realErrors.length === 0, realErrors.join(' | '));

    const fails = results.filter((r) => !r.ok);
    console.log('\n=== SUMMARY ===');
    console.log(`pass=${results.length - fails.length} fail=${fails.length}`);
    if (fails.length) {
      fails.forEach((f) => console.log('FAIL', f.name, f.detail));
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
