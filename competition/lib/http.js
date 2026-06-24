'use strict';
// HTTP transport: rate limiting + retrying JSON client used by every API wrapper.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token-bucket-ish limiter: spaces calls at most `rps` per second.
function createRateLimiter(rps) {
  if (!rps || rps <= 0) return async () => {};
  const intervalMs = 1000 / rps;
  let nextSlot = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;
    if (slot - now > 0) await sleep(slot - now);
  };
}

async function reqOnce(method, url, body, headers = {}) {
  let resp, text;
  try {
    resp = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await resp.text();
  } catch (err) {
    return { ok: false, httpStatus: 0, headers: null, body: { error: { code: 'NETWORK_ERROR', message: String(err) } }, text: '' };
  }
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { ok: resp.ok, httpStatus: resp.status, headers: resp.headers, body: parsed, text };
}

function parseRetryAfter(h) {
  if (!h) return null;
  const s = Number(h); if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const w = Date.parse(h); return Number.isFinite(w) ? Math.max(0, w - Date.now()) : null;
}

// Retries 429 / 5xx / network errors with exponential backoff + jitter (or Retry-After).
async function req(rl, method, url, body, headers, maxRetries) {
  let attempt = 0;
  while (true) {
    await rl();
    const resp = await reqOnce(method, url, body, headers);
    const retryable = resp.httpStatus === 429 || (resp.httpStatus >= 500 && resp.httpStatus <= 599) || resp.httpStatus === 0;
    if (!retryable || attempt >= maxRetries) return resp;
    const ra = resp.headers ? parseRetryAfter(resp.headers.get('retry-after')) : null;
    await sleep(ra != null ? ra : Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
    attempt++;
  }
}

const postJson = (rl, url, body, headers, mr) => req(rl, 'POST', url, body, headers, mr);
const getJson  = (rl, url, headers, mr) => req(rl, 'GET', url, undefined, headers, mr);

module.exports = { sleep, createRateLimiter, req, postJson, getJson };
