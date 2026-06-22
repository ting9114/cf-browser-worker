# CF Browser Worker

Extended browser-worker with Cloudflare Turnstile solving via 2captcha API.

**Same API as browser-worker** — drop-in compatible with all existing n8n workflows. Adds 3 new actions for Cloudflare bypass.

## Quick Start

```bash
docker compose up -d --build
```

Default: port `3002`, headed mode with Xvfb.

## New Features (vs browser-worker)

### 1. Proxy Support
Pass proxy config in the request body — routed through Playwright:
```json
{
  "proxy": {
    "server": "http://proxy:port",
    "username": "user",
    "password": "pass"
  }
}
```

### 2. Cookie Injection at Session Creation
Pre-inject cookies (e.g., `cf_clearance` from a previous solve):
```json
{
  "cookies": [
    { "name": "cf_clearance", "value": "...", "domain": ".cloudflare.com", "path": "/" }
  ]
}
```

### 3. Custom User-Agent
Match the UA used by the CAPTCHA solver:
```json
{
  "userAgent": "Mozilla/5.0 ..."
}
```

### 4. Timezone
```json
{
  "timezone": "America/New_York"
}
```

## New Actions

### `solveTurnstile`
Detects and solves Cloudflare Turnstile CAPTCHA via 2captcha.

**Requires** `captcha` config in the request body.

```json
{
  "captcha": { "provider": "2captcha", "apiKey": "YOUR_2CAPTCHA_KEY" },
  "proxy": { "server": "http://proxy:port", "username": "u", "password": "p" },
  "steps": [
    { "action": "goto", "params": { "url": "https://dash.cloudflare.com/login" } },
    { "action": "wait", "params": { "ms": 3000 } },
    { "action": "solveTurnstile", "params": { "timeout": 120000 } },
    { "action": "wait", "params": { "ms": 5000 } },
    { "action": "screenshot", "params": { "fullPage": true } }
  ]
}
```

**Result:**
```json
{
  "solved": true,
  "detection": { "found": true, "sitekey": "0x4AAAA...", "method": "data-sitekey" },
  "injection": { "injected": true, "method": "challenge-form" },
  "cfClearance": "abc123...",
  "url": "https://dash.cloudflare.com/...",
  "cookieCount": 5
}
```

### `detectTurnstile`
Non-solving detection — checks if Turnstile is present.

```json
{ "action": "detectTurnstile" }
```

### `waitForCfClearance`
Polls cookies until `cf_clearance` appears (useful after manual solve in headed mode).

```json
{ "action": "waitForCfClearance", "params": { "timeout": 60000, "poll": 2000 } }
```

## Full Cloudflare Login Example

```json
{
  "captcha": { "provider": "2captcha", "apiKey": "YOUR_KEY" },
  "proxy": { "server": "http://res.proxy-seller.com:10002", "username": "user", "password": "pass" },
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
  "timezone": "America/New_York",
  "stealth": true,
  "disableSecurity": true,
  "ttl": 300000,
  "steps": [
    { "action": "goto", "params": { "url": "https://dash.cloudflare.com/login" } },
    { "action": "wait", "params": { "ms": 3000 } },
    { "action": "solveTurnstile", "params": { "timeout": 120000 } },
    { "action": "wait", "params": { "ms": 5000 } },
    { "action": "screenshot" },
    { "action": "fill", "params": { "selector": "input[type=email]", "value": "user@example.com" } },
    { "action": "fill", "params": { "selector": "input[type=password]", "value": "password123" } },
    { "action": "click", "params": { "selector": "button[type=submit]" } },
    { "action": "wait", "params": { "ms": 8000 } },
    { "action": "screenshot" },
    { "action": "goto", "params": { "url": "https://dash.cloudflare.com/profile/api-tokens" } },
    { "action": "wait", "params": { "ms": 5000 } },
    { "action": "screenshot" }
  ]
}
```

## Compatibility

100% backward-compatible with the original browser-worker. All existing actions work unchanged.
The new actions (`solveTurnstile`, `detectTurnstile`, `waitForCfClearance`) are additive.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | Server port (different from browser-worker's 3001 to allow parallel) |
| `HEADED` | `true` | `true` = Xvfb headed mode, `false` = headless |
