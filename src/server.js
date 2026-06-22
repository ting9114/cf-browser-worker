import express from 'express';
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { resolveAdPatterns } from './ad-patterns.js';
import { solveTurnstile, hasTurnstile } from './cf-solver.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// session id -> { sessionId, browser, context, page, ttl, timer, ... }
const sessions = new Map();

/* ─────────────────────── Session Management ─────────────────────── */

function resetTimer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    console.log(`[session:${sessionId}] TTL expired (${session.ttl}ms)`);
    closeSession(sessionId);
  }, session.ttl);
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.closing) return;
  session.closing = true;
  clearTimeout(session.timer);
  try { await session.browser.close(); } catch {}
  sessions.delete(sessionId);
  console.log(`[session:${sessionId}] closed`);
}

async function createSession(options = {}) {
  const {
    ttl = 30000,
    stealth = true,
    blockAds = false,
    forceHttp = false,
    disableSecurity = false,
    addCSS = '',
    addJS = '',
    proxy = null,
    userAgent = '',
    cookies = [],
    timezone = ''
  } = options;

  const sessionId = randomUUID();
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu-memory-buffer-video-frames',
    '--disable-gpu-memory-buffer-compositor-resources',
    '--disable-background-networking',
    '--mute-audio',
  ];

  if (disableSecurity) {
    args.push(
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--disable-features=SafeBrowsing,LocalNetworkAccessChecks',
      '--disable-hsts',
      '--disable-site-isolation-trials'
    );
  }

  const launchOptions = {
    headless: process.env.HEADED === 'true' ? false : true,
    channel: 'chromium',
    args,
  };

  // Proxy support
  if (proxy && proxy.server) {
    launchOptions.proxy = {
      server: proxy.server,
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    };
  }

  console.log(`[session:${sessionId}] Launching Chrome (proxy: ${proxy?.server || 'none'})...`);
  const browser = await chromium.launch(launchOptions);

  const contextOptions = {
    userAgent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: disableSecurity,
    javaScriptEnabled: true,
    bypassCSP: disableSecurity,
    extraHTTPHeaders: { 'Upgrade-Insecure-Requests': '0' }
  };

  if (timezone) {
    contextOptions.timezoneId = timezone;
  }

  const context = await browser.newContext(contextOptions);

  // CSS Injection
  if (addCSS) {
    await context.addInitScript(({ css }) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.documentElement.appendChild(style);
    }, { css: addCSS });
  }

  // JS Injection
  if (addJS) {
    await context.addInitScript((js) => {
      const script = document.createElement('script');
      script.textContent = js;
      document.documentElement.appendChild(script);
    }, addJS);
  }

  // Stealth
  if (stealth) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
  }

  // Inject cookies at session creation
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
    console.log(`[session:${sessionId}] Injected ${cookies.length} cookies`);
  }

  const page = await context.newPage();
  const forceHttpHosts = Array.isArray(forceHttp) ? new Set(forceHttp) : new Set();

  const sessionObj = {
    sessionId, browser, context, page, ttl,
    blockAds, forceHttp, forceHttpHosts,
    proxy: proxy || null,
    captcha: options.captcha || null
  };
  sessions.set(sessionId, sessionObj);
  resetTimer(sessionId);

  console.log(`[session:${sessionId}] created`);
  return sessionObj;
}

/* ─────────────────────── Route Setup ─────────────────────── */

async function setupRoutes(session) {
  const { context, sessionId, forceHttp, forceHttpHosts, blockAds } = session;
  await context.unroute('**/*');

  const patterns = resolveAdPatterns(blockAds);
  const adBlockingEnabled = patterns !== null;
  const forceHttpActive = forceHttp === true || forceHttpHosts.size > 0;

  if (!forceHttpActive && !adBlockingEnabled) return;

  await context.route('**/*', async (route) => {
    const urlStr = route.request().url();
    const urlLower = urlStr.toLowerCase();

    const isAd = adBlockingEnabled && patterns.some(p => urlLower.includes(p));
    if (isAd) {
      console.log(`[session:${sessionId}] AdBlock: ${urlStr}`);
      return route.abort();
    }

    let url = null;
    try { url = new URL(urlStr); } catch {}
    const hostname = url?.hostname?.toLowerCase();

    const shouldForceHttp = forceHttp === true || (hostname && forceHttpHosts.has(hostname));
    if (shouldForceHttp && url.protocol === 'https:') {
      const httpUrl = urlStr.replace(/^https:/, 'http:');
      try {
        const response = await route.fetch({ url: httpUrl });
        await route.fulfill({ response });
        return;
      } catch {}
    }

    route.continue();
  });
}

/* ─────────────────────── Step Executor ─────────────────────── */

async function executeStep(session, step) {
  const { action, params = {} } = step;
  const { page, context } = session;

  switch (action) {
    case 'goto': {
      try {
        const targetUrl = new URL(params.url);
        if (targetUrl.protocol === 'http:') {
          session.forceHttpHosts.add(targetUrl.hostname.toLowerCase());
        }
        await setupRoutes(session);
      } catch (e) {
        return { error: `Invalid URL: ${params.url}` };
      }
      await page.goto(params.url, {
        waitUntil: params.waitUntil ?? 'domcontentloaded',
        timeout: params.timeout ?? 60000
      });
      return { url: page.url() };
    }
    case 'reload':
      await page.reload({ waitUntil: params.waitUntil ?? 'domcontentloaded' });
      return { url: page.url() };
    case 'getUrl':
      return { url: page.url() };
    case 'getContent':
      return { html: await page.content() };
    case 'click':
      await page.click(params.selector, { timeout: params.timeout ?? 30000 });
      return { clicked: params.selector };
    case 'fill':
      await page.fill(params.selector, params.value);
      return { filled: params.selector };
    case 'type':
      await page.type(params.selector, params.text, { delay: params.delay ?? 30 });
      return { typed: params.selector };
    case 'select':
      await page.selectOption(params.selector, params.value);
      return { selected: params.value };
    case 'check':
      params.state === false
        ? await page.uncheck(params.selector)
        : await page.check(params.selector);
      return { checked: params.selector };
    case 'keyboard':
      await page.keyboard.press(params.key);
      return { pressed: params.key };
    case 'hover':
      await page.hover(params.selector);
      return { hovered: params.selector };
    case 'wait':
      await page.waitForTimeout(params.ms ?? 1000);
      return { waited: params.ms };
    case 'waitForSelector':
      await page.waitForSelector(params.selector, {
        state: params.state ?? 'visible',
        timeout: params.timeout ?? 30000
      });
      return { found: params.selector };
    case 'waitForNavigation':
      await page.waitForLoadState(params.waitUntil ?? 'networkidle');
      return { url: page.url() };
    case 'evaluate':
      return { value: await page.evaluate(params.script) };
    case 'getText':
      return { text: await page.textContent(params.selector) };
    case 'getAttribute':
      return { value: await page.getAttribute(params.selector, params.attr) };
    case 'screenshot': {
      const opts = { type: 'png', fullPage: params.fullPage ?? false };
      const buf = params.selector
        ? await page.locator(params.selector).screenshot(opts)
        : await page.screenshot(opts);
      return { screenshot: buf.toString('base64') };
    }
    case 'getCookies':
      return { cookies: await context.cookies() };
    case 'setCookies':
      await context.addCookies(params.cookies);
      return { set: params.cookies.length };
    case 'getLocalStorage':
      return { value: await page.evaluate((k) => localStorage.getItem(k), params.key) };
    case 'uploadFile':
      await page.setInputFiles(params.selector, params.files);
      return { uploaded: params.files };

    /* ──────── Cloudflare-specific actions ──────── */

    case 'solveTurnstile': {
      if (!session.captcha || !session.captcha.apiKey) {
        throw new Error('captcha config with apiKey required. Add "captcha": {"provider": "2captcha", "apiKey": "..."} to request body.');
      }
      const result = await solveTurnstile(page, session.captcha, session.proxy, params);
      return result;
    }

    case 'detectTurnstile': {
      const detection = await hasTurnstile(page);
      return detection;
    }

    case 'waitForCfClearance': {
      // Wait until cf_clearance cookie appears (after manual or auto solve)
      const maxWait = params.timeout || 60000;
      const pollMs = params.poll || 2000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const cookies = await context.cookies();
        const cf = cookies.find(c => c.name === 'cf_clearance');
        if (cf) return { found: true, cf_clearance: cf.value, elapsed: Date.now() - start };
        await page.waitForTimeout(pollMs);
      }
      return { found: false, elapsed: Date.now() - start };
    }

    default:
      if (typeof page[action] === 'function') {
        const result = await page[action](params);
        return { result };
      }
      throw new Error(`Unknown action: "${action}"`);
  }
}

/* ─────────────────────── HTTP Endpoints ─────────────────────── */

app.post('/execute', async (req, res) => {
  const {
    sessionId,
    ttl,
    stealth = true,
    blockAds = false,
    forceHttp = false,
    disableSecurity = false,
    addCSS = '',
    addJS = '',
    proxy,
    userAgent,
    cookies,
    timezone,
    captcha,
    steps = [],
    stopOnError = true
  } = req.body;

  if (!steps.length) return res.status(400).json({ ok: false, error: 'steps required' });

  let session = sessionId ? sessions.get(sessionId) : null;
  if (sessionId && !session) return res.status(404).json({ ok: false, error: 'Session expired' });

  if (!session) {
    try {
      session = await createSession({
        ttl: ttl || 30000, stealth, blockAds, forceHttp, disableSecurity,
        addCSS, addJS, proxy, userAgent, cookies, timezone, captcha
      });
    } catch (err) {
      return res.status(503).json({ ok: false, error: err.message });
    }
  } else {
    if (ttl) {
      session.ttl = ttl;
      console.log(`[session:${session.sessionId}] TTL updated to ${ttl}ms`);
    }
    // Allow updating captcha config on existing session
    if (captcha) session.captcha = captcha;
  }

  const results = [];
  let error = null;
  for (const step of steps) {
    session.busy = true;
    try {
      console.log(`[session:${session.sessionId}] action: ${step.action}`, step.params || {});
      const result = await executeStep(session, step);
      results.push({ action: step.action, ok: true, result });
    } catch (e) {
      console.error(`[session:${session.sessionId}] error in ${step.action}:`, e.message);
      results.push({ action: step.action, ok: false, error: e.message });
      error = e.message;
      if (stopOnError) break;
    } finally {
      session.busy = false;
    }
  }

  resetTimer(session.sessionId);

  let finalUrl = null;
  try {
    finalUrl = session?.page && !session.page.isClosed() ? session.page.url() : null;
  } catch {}

  res.json({
    ok: !error,
    sessionId: session.sessionId,
    results,
    finalUrl,
    error: error || undefined
  });
});

app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));

app.get('/sessions', (req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    ttl: s.ttl,
    url: s.page.url()
  }));
  res.json({ count: list.length, sessions: list });
});

app.get('/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, sessionId: req.params.id, url: s.page.url(), ttl: s.ttl });
});

app.delete('/sessions/:id', async (req, res) => {
  if (!sessions.has(req.params.id)) return res.status(404).json({ ok: false, error: 'Session not found' });
  await closeSession(req.params.id);
  res.json({ ok: true });
});

/* ─────────────────────── Start ─────────────────────── */

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CF Browser Worker ready on :${PORT}`));

process.on('uncaughtException', (err) => console.error('[FATAL] uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('[FATAL] unhandledRejection:', reason));
process.on('SIGTERM', () => console.error('[PROCESS] SIGTERM received'));
process.on('SIGINT', () => console.error('[PROCESS] SIGINT received'));

setInterval(() => {
  console.log(`[PROCESS] alive sessions=${sessions.size} uptime=${Math.round(process.uptime())}s`);
}, 60000);
