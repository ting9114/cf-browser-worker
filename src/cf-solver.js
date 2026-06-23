/**
 * Cloudflare Solver — Enhanced Edition
 * ====================================
 * Browser-based Cloudflare challenge handler for Playwright/Chromium.
 *
 * Ports the challenge-detection taxonomy from the `cloudscraper` project
 * (VeNoMouS/cloudscraper) onto a real-browser architecture. Because a real
 * Chromium executes Cloudflare's JavaScript automatically, JS challenges
 * (IUAM v1 and the v3 JS-VM challenge) are solved simply by WAITING for the
 * browser to run them and redirect -- no JS interpreter needed. Only the
 * Turnstile CAPTCHA requires an external solver (2captcha), because a human
 * (or a solving service) must produce the token.
 *
 * Challenge types handled:
 *   - iuam        : "Checking your browser" interstitial (v1)        -> wait it out
 *   - v3          : JS-VM challenge (challenge-platform/orchestrate)  -> wait it out
 *   - turnstile   : standalone Turnstile CAPTCHA wall                 -> 2captcha solve
 *   - managed     : Turnstile embedded in app JS (e.g. CF dashboard)  -> best-effort/report
 *   - firewall    : Cloudflare block (1020) / hard deny               -> report, unsolvable
 *   - none        : no Cloudflare challenge present
 *
 * Public actions (wired in server.js):
 *   detectChallenge   -> classify whatever is on the page right now
 *   bypassCloudflare  -> auto: wait out JS challenges, solve Turnstile if present
 *   solveTurnstile    -> (legacy) force the Turnstile/2captcha path
 *   detectTurnstile   -> (legacy) Turnstile-only detection
 */

const POLL_INTERVAL = 5000;    // ms between 2captcha polls
const MAX_POLL_TIME = 120000;  // max wait for a 2captcha solution

/* ----------------------- Challenge classification ----------------------- */
async function classifyChallenge(page) {
  return page.evaluate(() => {
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const bodyText = document.body ? document.body.innerText : '';
    const has = (re) => re.test(html);

    // Standalone Turnstile CAPTCHA wall
    const turnstileMarkup =
      has(/class=["'][^"']*cf-turnstile/) ||
      has(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/) ||
      has(/data-sitekey=["'][0-9A-Za-z_-]{20,}["']/);

    let sitekey = null;
    const skMatch =
      html.match(/data-sitekey=["']([0-9A-Za-z_-]{20,})["']/) ||
      html.match(/sitekey["':\s]+["']?(0x[A-Za-z0-9_-]+)/);
    if (skMatch) sitekey = skMatch[1];

    // IUAM v1 "Checking your browser" interstitial
    const iuam =
      has(/\/cdn-cgi\/images\/trace\/jsch\//) ||
      has(/id=["']challenge-form["']/) ||
      has(/__cf_chl_f_tk=/) ||
      /Checking your browser before accessing/i.test(bodyText) ||
      /Just a moment/i.test(bodyText);

    // v3 JS-VM challenge
    const v3 =
      has(/cdn-cgi\/challenge-platform\/\S+orchestrate\/jsch\/v3/) ||
      has(/window\._cf_chl_ctx\s*=/) ||
      has(/cdn-cgi\/challenge-platform\//);

    // Firewall / hard block (1020)
    const firewall =
      /error code[: ]*1020/i.test(bodyText) ||
      (/Access denied/i.test(bodyText) && has(/cloudflare/i));

    // Managed/embedded Turnstile (no sitekey in HTML, but a CF challenge iframe)
    const cfIframe = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    const verifyText =
      /Verify you are human/i.test(bodyText) ||
      /needs to review the security/i.test(bodyText) ||
      /There was a problem with verification/i.test(bodyText);
    const managed = (cfIframe || verifyText) && !turnstileMarkup;

    let type = 'none';
    if (firewall) type = 'firewall';
    else if (turnstileMarkup) type = 'turnstile';
    else if (iuam) type = 'iuam';
    else if (v3) type = 'v3';
    else if (managed) type = 'managed';

    return {
      type, sitekey,
      signals: { turnstileMarkup, iuam, v3, firewall, managed, cfIframe, verifyText },
      title: document.title || '', url: location.href
    };
  });
}

async function waitOutJsChallenge(page, { timeout = 30000, poll = 2000 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    last = await classifyChallenge(page);
    if (last.type !== 'iuam' && last.type !== 'v3') {
      return { cleared: true, waitedMs: Date.now() - start, final: last };
    }
    try { await page.waitForLoadState('networkidle', { timeout: poll }); }
    catch { await page.waitForTimeout(poll); }
  }
  return { cleared: false, waitedMs: Date.now() - start, final: last };
}

/* ----------------------- Turnstile detection ----------------------- */
async function detectTurnstile(page) {
  return page.evaluate(() => {
    const turnstileDiv = document.querySelector('[class*="cf-turnstile"], [data-sitekey]');
    if (turnstileDiv) {
      const sitekey = turnstileDiv.getAttribute('data-sitekey');
      if (sitekey) return { found: true, sitekey, method: 'data-sitekey' };
    }
    const iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
    for (const iframe of iframes) {
      const m = (iframe.src || '').match(/[?&]k=([^&]+)/);
      if (m) return { found: true, sitekey: m[1], method: 'iframe' };
    }
    const scripts = document.querySelectorAll('script[src*="challenges.cloudflare.com"]');
    for (const s of scripts) {
      const m = (s.src || '').match(/render=([^&]+)/);
      if (m) return { found: true, sitekey: m[1], method: 'script' };
    }
    const html = document.documentElement.innerHTML;
    const r = html.match(/turnstile\.render\([^,]*,\s*\{[^}]*sitekey:\s*['"]([^'"]+)['"]/);
    if (r) return { found: true, sitekey: r[1], method: 'render-call' };
    const hidden = document.querySelector('input[name="cf-turnstile-response"]');
    if (hidden) {
      const el = document.querySelector('[data-sitekey]');
      if (el) return { found: true, sitekey: el.getAttribute('data-sitekey'), method: 'hidden+attr' };
      return { found: true, sitekey: null, method: 'hidden-only' };
    }
    const bt = document.body ? document.body.innerText : '';
    if (/Verify you are human|security verification|Checking your browser/i.test(bt)) {
      return { found: true, sitekey: null, method: 'text-detection' };
    }
    return { found: false };
  });
}

/* ----------------------- 2captcha Turnstile solve ----------------------- */
async function solve2captcha(apiKey, sitekey, pageUrl, proxyConfig) {
  const submit = new URLSearchParams({
    key: apiKey, method: 'turnstile', sitekey, pageurl: pageUrl, json: '1'
  });
  if (proxyConfig && proxyConfig.server) {
    const p = new URL(proxyConfig.server);
    submit.set('proxy', `${proxyConfig.username}:${proxyConfig.password}@${p.hostname}:${p.port}`);
    submit.set('proxytype', 'HTTP');
  }
  console.log(`[cf-solver] 2captcha submit (sitekey ${String(sitekey).slice(0, 16)}...)`);
  const subResp = await fetch(`https://2captcha.com/in.php?${submit}`);
  const sub = await subResp.json();
  if (sub.status !== 1) throw new Error(`2captcha submit failed: ${sub.request || JSON.stringify(sub)}`);
  const id = sub.request;
  const start = Date.now();
  await sleep(15000);
  while (Date.now() - start < MAX_POLL_TIME) {
    const pr = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${id}&json=1`);
    const pd = await pr.json();
    if (pd.status === 1) {
      console.log(`[cf-solver] 2captcha solved in ${Math.round((Date.now() - start) / 1000)}s`);
      return pd.request;
    }
    if (pd.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha error: ${pd.request}`);
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`2captcha timeout after ${MAX_POLL_TIME / 1000}s`);
}

async function injectSolution(page, token) {
  return page.evaluate((tok) => {
    const input = document.querySelector('input[name="cf-turnstile-response"]');
    if (input) input.value = tok;
    if (typeof window.turnstile !== 'undefined' && window.turnstile) {
      try {
        const widgets = document.querySelectorAll('[class*="cf-turnstile"], [data-sitekey]');
        for (const w of widgets) {
          const cb = w.getAttribute('data-callback');
          if (cb && typeof window[cb] === 'function') { window[cb](tok); return { injected: true, method: 'data-callback' }; }
        }
      } catch {}
    }
    const forms = document.querySelectorAll('form');
    for (const f of forms) {
      const i = f.querySelector('input[name="cf-turnstile-response"]');
      if (i) { i.value = tok; f.submit(); return { injected: true, method: 'form-submit' }; }
    }
    const cf = document.querySelector('#challenge-form, form[action*="__cf_chl"]');
    if (cf) { if (input) input.value = tok; cf.submit(); return { injected: true, method: 'challenge-form' }; }
    if (input) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { injected: true, method: 'event-dispatch' };
    }
    return { injected: false, method: 'none' };
  }, token);
}

/* ----------------------- Public: solveTurnstile (legacy) ----------------------- */
export async function solveTurnstile(page, captchaConfig, proxyConfig, params = {}) {
  const waitAfter = params.waitAfter || 5000;
  if (!captchaConfig || !captchaConfig.apiKey) throw new Error('captcha.apiKey is required for solveTurnstile');
  if ((captchaConfig.provider || '2captcha') !== '2captcha') throw new Error('Only "2captcha" provider is supported.');

  let detection = await detectTurnstile(page);
  if (!detection.found) return { solved: false, reason: 'no_turnstile_detected', url: page.url() };

  if (!detection.sitekey) {
    const content = await page.content();
    const m = content.match(/sitekey['":\s]+['"]?(0x[A-Za-z0-9_-]+)/);
    if (m) detection.sitekey = m[1];
    else return { solved: false, reason: 'turnstile_detected_but_no_sitekey', detection, url: page.url() };
  }

  const token = await solve2captcha(captchaConfig.apiKey, detection.sitekey, page.url(), proxyConfig);
  const injection = await injectSolution(page, token);
  await page.waitForTimeout(waitAfter);

  const cookies = await page.context().cookies();
  const cf = cookies.find(c => c.name === 'cf_clearance');
  return {
    solved: true, detection, injection,
    cfClearance: cf ? cf.value : null,
    url: page.url(), cookieCount: cookies.length
  };
}

/* ----------------------- Public: bypassCloudflare (auto) ----------------------- */
export async function bypassCloudflare(page, captchaConfig, proxyConfig, params = {}) {
  const jsTimeout = params.jsTimeout || 30000;
  const initialWait = params.initialWait ?? 2000;

  if (initialWait) await page.waitForTimeout(initialWait);

  let det = await classifyChallenge(page);

  // 1) JS challenges -- wait them out (native browser execution)
  if (det.type === 'iuam' || det.type === 'v3') {
    const waited = await waitOutJsChallenge(page, { timeout: jsTimeout, poll: params.poll || 2000 });
    det = waited.final || await classifyChallenge(page);
    if (det.type === 'none') {
      const cf = (await page.context().cookies()).find(c => c.name === 'cf_clearance');
      return { type: 'js_challenge', solved: true, cfClearance: cf ? cf.value : null, detail: waited, url: page.url() };
    }
  }

  // 2) Turnstile wall -- solve with 2captcha
  if (det.type === 'turnstile') {
    if (!captchaConfig || !captchaConfig.apiKey) {
      return { type: 'turnstile', solved: false, reason: 'captcha_provider_required', detail: det, url: page.url() };
    }
    const r = await solveTurnstile(page, captchaConfig, proxyConfig, params);
    return { type: 'turnstile', solved: !!r.cfClearance, cfClearance: r.cfClearance, detail: r, url: page.url() };
  }

  // 3) Managed/embedded (e.g. CF's own dashboard)
  if (det.type === 'managed') {
    return {
      type: 'managed', solved: false,
      reason: 'managed_challenge_not_solvable_headless',
      hint: 'Sitekey not exposed in page HTML (embedded in app JS). Use interactive headed solve + cf_clearance cookie reuse, or the site owner API.',
      detail: det, url: page.url()
    };
  }

  // 4) Firewall block
  if (det.type === 'firewall') {
    return { type: 'firewall', solved: false, reason: 'cloudflare_block_1020', detail: det, url: page.url() };
  }

  // 5) Nothing to do
  return { type: 'none', solved: true, reason: 'no_challenge_detected', detail: det, url: page.url() };
}

/* ----------------------- Public: detection helpers ----------------------- */
export async function detectChallenge(page) { return classifyChallenge(page); }
export async function hasTurnstile(page) { return detectTurnstile(page); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
