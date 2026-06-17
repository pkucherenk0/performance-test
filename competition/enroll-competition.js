#!/usr/bin/env node
// Generate ETH wallets, authenticate each one against NeoDax (challenge / verify),
// then enroll each in a yellow-pro-hub competition using its own JWT.
//
// After each wallet enrolls it can optionally be faucetted (USDT + ETH) and run a
// short loop of random buy/sell spot MARKET orders to generate competition volume.
//
// Usage:
//   node enroll-competition.js                              # defaults below
//   node enroll-competition.js --count 50
//   node enroll-competition.js --competition edition-1 --count 25 --concurrency 4
//   node enroll-competition.js --count 10 --orders 5        # enroll + volume (default)
//   node enroll-competition.js --count 10 --no-volume       # enroll only
//
// Enrollment flags:
//   --base / --auth-base / --competition / --count / --concurrency
//   --rps 4        (global cap across workers, before retries)
//   --max-retries 5 (per request; honours Retry-After on 429)
//   --delay 0      (ms between requests in a worker)
//   --terms true   (set false to test the 422 TERMS_NOT_ACCEPTED path)
//
// Volume flags (all envs MUST match --base/--auth-base):
//   --volume true | --no-volume        (default: on)
//   --trading-base   https://api.uat.yellow.pro.neodax.app
//   --faucet-url     https://faucet.uat.yellow.pro.neodax.app/api/deposit
//   --market         ETHUSDT
//   --orders         5            (random market orders per account)
//   --faucet-usdt    200          (USDT credited per account)
//   --faucet-eth     0.1          (ETH credited per account)
//   --min-notional 5 / --max-notional 20   (per-order USD notional range)
//   --fallback-price 3000         (used if orderbook/ticker price unavailable)
//
// NOTE: market orders only produce real volume if the book already has opposing
// liquidity; rejected / zero-fill orders are logged but are not fatal.
//
// Output:
//   ./enrollments-<competition>-<ts>.json — enrollment + volume results (no private keys)
//   ./wallet-jwts-<competition>-<ts>.json — { address, jwt } pairs

const fs = require('fs');
const path = require('path');
const { Wallet } = require('ethers');

const DEFAULTS = {
  base: 'https://hub.uat.yellow.pro.neodax.app',
  authBase: 'https://auth.uat.yellow.pro.neodax.app',
  competition: 'pablo-12',
  //base: 'https://hub.staging.yellow.pro.neodax.app',
  //authBase: 'https://auth.staging.yellow.pro.neodax.app',
  //competition: 'edition-1',
  count: 20,
  concurrency: 2,
  rps: 4,
  maxRetries: 5,
  delay: 0,
  terms: true,

  // --- Volume generation (faucet + random spot market orders) ---
  // NOTE: tradingBase / faucetUrl MUST be the same environment as base/authBase,
  // since the auth JWT and the spot account are env-scoped.
  volume: true,                                                   // run faucet+trading after each enroll
  tradingBase: 'https://api.uat.yellow.pro.neodax.app',           // Trading API (spot orders, orderbook, ticker)
  faucetUrl: 'https://faucet.uat.yellow.pro.neodax.app/api/deposit',
  market: 'ETHUSDT',          // spot market to trade
  orders: 5,                  // random market orders per account
  faucetUsdt: '200',          // USDT credited per account (funds buys)
  faucetEth: '0.1',           // ETH credited per account (funds sells)
  minNotional: 5,             // min USD notional per order
  maxNotional: 20,            // max USD notional per order
  stepSize: 0.001,            // ETHUSDT LOT_SIZE step_size (amount granularity)
  minQty: 0.001,              // ETHUSDT LOT_SIZE min_qty
  fallbackPrice: 1700,        // used to size orders if orderbook/ticker price is unavailable (~current ETHUSDT)
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--base':         out.base = next; i++; break;
      case '--auth-base':    out.authBase = next; i++; break;
      case '--competition':  out.competition = next; i++; break;
      case '--count':        out.count = parseInt(next, 10); i++; break;
      case '--concurrency':  out.concurrency = parseInt(next, 10); i++; break;
      case '--rps':          out.rps = parseFloat(next); i++; break;
      case '--max-retries':  out.maxRetries = parseInt(next, 10); i++; break;
      case '--delay':        out.delay = parseInt(next, 10); i++; break;
      case '--terms':        out.terms = next !== 'false'; i++; break;
      case '--volume':       out.volume = next !== 'false'; i++; break;
      case '--no-volume':    out.volume = false; break;
      case '--trading-base': out.tradingBase = next; i++; break;
      case '--faucet-url':   out.faucetUrl = next; i++; break;
      case '--market':       out.market = next; i++; break;
      case '--orders':       out.orders = parseInt(next, 10); i++; break;
      case '--faucet-usdt':  out.faucetUsdt = next; i++; break;
      case '--faucet-eth':   out.faucetEth = next; i++; break;
      case '--min-notional': out.minNotional = parseFloat(next); i++; break;
      case '--max-notional': out.maxNotional = parseFloat(next); i++; break;
      case '--fallback-price': out.fallbackPrice = parseFloat(next); i++; break;
      case '-h':
      case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 20).join('\n'));
        process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createRateLimiter(rps) {
  if (!rps || rps <= 0) return async () => {};
  const intervalMs = 1000 / rps;
  let nextSlot = 0;
  return async function take() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  };
}

async function postJsonOnce(url, body, headers = {}) {
  let resp, text;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    text = await resp.text();
  } catch (err) {
    return { ok: false, httpStatus: 0, headers: null, body: { error: { code: 'NETWORK_ERROR', message: String(err) } } };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { ok: resp.ok, httpStatus: resp.status, headers: resp.headers, body: parsed };
}

function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const secs = Number(headerVal);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(headerVal);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

async function postJson(rl, url, body, headers, maxRetries) {
  let attempt = 0;
  while (true) {
    await rl();
    const resp = await postJsonOnce(url, body, headers);
    const retryable = resp.httpStatus === 429 || (resp.httpStatus >= 500 && resp.httpStatus <= 599) || resp.httpStatus === 0;
    if (!retryable || attempt >= maxRetries) return resp;
    const ra = resp.headers ? parseRetryAfter(resp.headers.get('retry-after')) : null;
    const backoff = ra != null ? ra : Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
    await sleep(backoff);
    attempt++;
  }
}

async function authenticate(rl, authBaseUrl, wallet, maxRetries) {
  const root = authBaseUrl.replace(/\/$/, '');

  const challengeResp = await postJson(rl, `${root}/auth/challenge`, { wallet_address: wallet.address }, {}, maxRetries);
  if (!challengeResp.ok || !challengeResp.body?.challenge) {
    return { ok: false, stage: 'challenge', httpStatus: challengeResp.httpStatus, body: challengeResp.body };
  }
  const challenge = challengeResp.body.challenge;

  let signature;
  try {
    signature = await wallet.signMessage(challenge);
  } catch (err) {
    return { ok: false, stage: 'sign', httpStatus: 0, body: { error: { code: 'SIGN_ERROR', message: String(err) } } };
  }

  const verifyResp = await postJson(rl, `${root}/auth/verify`, {
    wallet_address: wallet.address,
    challenge,
    signature,
  }, {}, maxRetries);
  if (!verifyResp.ok || !verifyResp.body?.access_token) {
    return { ok: false, stage: 'verify', httpStatus: verifyResp.httpStatus, body: verifyResp.body };
  }

  return {
    ok: true,
    accessToken: verifyResp.body.access_token,
    refreshToken: verifyResp.body.refresh_token,
    expiresIn: verifyResp.body.expires_in,
  };
}

async function enroll(rl, baseUrl, slug, address, termsAccepted, jwt, maxRetries) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/competitions/${encodeURIComponent(slug)}/enroll`;
  const resp = await postJson(
    rl,
    url,
    { address, terms_accepted: termsAccepted },
    { 'Authorization': `Bearer ${jwt}` },
    maxRetries,
  );
  let status;
  if (resp.httpStatus === 201) status = 'enrolled';
  else if (resp.httpStatus === 200) status = 'already_enrolled';
  else status = 'failed';
  return { address, status, httpStatus: resp.httpStatus, body: resp.body };
}

// ---------------------------------------------------------------------------
// Volume generation: faucet assets, then fire random spot MARKET orders.
// Market orders only generate volume if the book already has opposing
// liquidity — rejected/zero-fill orders are logged but not fatal.
// ---------------------------------------------------------------------------

async function getJsonOnce(url, headers = {}) {
  let resp, text;
  try {
    resp = await fetch(url, { method: 'GET', headers });
    text = await resp.text();
  } catch (err) {
    return { ok: false, httpStatus: 0, headers: null, body: { error: { code: 'NETWORK_ERROR', message: String(err) } } };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { ok: resp.ok, httpStatus: resp.status, headers: resp.headers, body: parsed };
}

async function getJson(rl, url, headers, maxRetries) {
  let attempt = 0;
  while (true) {
    await rl();
    const resp = await getJsonOnce(url, headers);
    const retryable = resp.httpStatus === 429 || (resp.httpStatus >= 500 && resp.httpStatus <= 599) || resp.httpStatus === 0;
    if (!retryable || attempt >= maxRetries) return resp;
    const ra = resp.headers ? parseRetryAfter(resp.headers.get('retry-after')) : null;
    const backoff = ra != null ? ra : Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
    await sleep(backoff);
    attempt++;
  }
}

async function faucet(rl, faucetUrl, appSessionId, asset, amount, maxRetries) {
  const resp = await postJson(rl, faucetUrl, { app_session_id: appSessionId, asset, amount }, {}, maxRetries);
  return { ok: resp.ok && resp.body?.success === true, httpStatus: resp.httpStatus, body: resp.body };
}

// Reference price for sizing: orderbook mid -> ticker last -> fallback.
async function getReferencePrice(rl, tradingBase, market, fallbackPrice, maxRetries) {
  const root = tradingBase.replace(/\/$/, '');

  const ob = await getJson(rl, `${root}/orderbook?symbol=${encodeURIComponent(market)}`, {}, maxRetries);
  if (ob.ok) {
    const bestBid = parseFloat(ob.body?.bids?.[0]?.[0]);
    const bestAsk = parseFloat(ob.body?.asks?.[0]?.[0]);
    if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) return { price: (bestBid + bestAsk) / 2, source: 'orderbook_mid' };
    if (Number.isFinite(bestBid)) return { price: bestBid, source: 'best_bid' };
    if (Number.isFinite(bestAsk)) return { price: bestAsk, source: 'best_ask' };
  }

  const tk = await getJson(rl, `${root}/ticker/24hr?symbol=${encodeURIComponent(market)}`, {}, maxRetries);
  const last = parseFloat(tk.body?.last);
  if (tk.ok && Number.isFinite(last) && last > 0) return { price: last, source: 'ticker_last' };

  return { price: fallbackPrice, source: 'fallback' };
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

// Quantize a base-asset amount to the lot step, clamped to min_qty.
function quantizeAmount(amount, stepSize, minQty) {
  const steps = Math.max(1, Math.round(amount / stepSize));
  const q = Math.max(minQty, steps * stepSize);
  const decimals = (String(stepSize).split('.')[1] || '').length;
  return q.toFixed(decimals);
}

async function createSpotMarketOrder(rl, tradingBase, jwt, appSessionId, market, side, amountStr, maxRetries) {
  const url = `${tradingBase.replace(/\/$/, '')}/spot/order`;
  const resp = await postJson(
    rl,
    url,
    { app_session_id: appSessionId, market, side, type: 'market', amount: amountStr },
    { 'Authorization': `Bearer ${jwt}` },
    maxRetries,
  );
  return {
    ok: resp.ok && !!resp.body?.order_uuid,
    httpStatus: resp.httpStatus,
    orderUuid: resp.body?.order_uuid || null,
    error: resp.ok ? null : (resp.body?.error || `HTTP_${resp.httpStatus}`),
    message: resp.body?.message,
  };
}

// Faucet both assets, then place `opts.orders` random buy/sell market orders.
async function runVolumeForAccount(rl, opts, address, jwt) {
  const appSessionId = address; // faucet + spot account are keyed by wallet address

  const faucetResults = [];
  for (const [asset, amount] of [['USDT', opts.faucetUsdt], ['ETH', opts.faucetEth]]) {
    const f = await faucet(rl, opts.faucetUrl, appSessionId, asset, amount, opts.maxRetries);
    faucetResults.push({ asset, amount, ok: f.ok, httpStatus: f.httpStatus, error: f.ok ? null : (f.body?.error || f.body?.message || `HTTP_${f.httpStatus}`) });
  }

  const ref = await getReferencePrice(rl, opts.tradingBase, opts.market, opts.fallbackPrice, opts.maxRetries);

  const orders = [];
  let accepted = 0;
  for (let i = 0; i < opts.orders; i++) {
    const side = Math.random() < 0.5 ? 'buy' : 'sell';
    const notional = randBetween(opts.minNotional, opts.maxNotional);
    const amountStr = quantizeAmount(notional / ref.price, opts.stepSize, opts.minQty);
    const r = await createSpotMarketOrder(rl, opts.tradingBase, jwt, appSessionId, opts.market, side, amountStr, opts.maxRetries);
    if (r.ok) accepted++;
    orders.push({ side, amount: amountStr, ok: r.ok, httpStatus: r.httpStatus, orderUuid: r.orderUuid, error: r.error });
    if (opts.delay > 0) await sleep(opts.delay);
  }

  return {
    faucet: faucetResults,
    refPrice: ref.price,
    refSource: ref.source,
    ordersPlaced: orders.length,
    ordersAccepted: accepted,
    orders,
  };
}

async function worker(queue, results, jwts, opts, rl, onResult) {
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job) break;

    const auth = await authenticate(rl, opts.authBase, job.wallet, opts.maxRetries);
    if (!auth.ok) {
      const result = {
        address: job.wallet.address,
        status: 'failed',
        httpStatus: auth.httpStatus,
        body: { error: { code: `AUTH_${auth.stage.toUpperCase()}_FAILED`, ...auth.body } },
      };
      results.push(result);
      onResult(result);
      if (opts.delay > 0) await sleep(opts.delay);
      continue;
    }

    jwts.push({ address: job.wallet.address, jwt: auth.accessToken });

    const result = await enroll(rl, opts.base, opts.competition, job.wallet.address, opts.terms, auth.accessToken, opts.maxRetries);

    // Generate volume regardless of enroll outcome (we have a valid JWT + funded account).
    if (opts.volume) {
      try {
        result.volume = await runVolumeForAccount(rl, opts, job.wallet.address, auth.accessToken);
      } catch (err) {
        result.volume = { error: String(err) };
      }
    }

    results.push(result);
    onResult(result);
    if (opts.delay > 0) await sleep(opts.delay);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!Number.isFinite(opts.count) || opts.count <= 0) {
    console.error('--count must be a positive integer');
    process.exit(2);
  }

  console.log(`Generating ${opts.count} wallets...`);
  const queue = [];
  for (let i = 0; i < opts.count; i++) {
    queue.push({ wallet: Wallet.createRandom() });
  }

  console.log(`Auth via ${opts.authBase}`);
  console.log(`Enroll into "${opts.competition}" on ${opts.base}`);
  console.log(`Concurrency: ${opts.concurrency}, rps: ${opts.rps}, max-retries: ${opts.maxRetries}, delay: ${opts.delay}ms, terms_accepted: ${opts.terms}`);
  if (opts.volume) {
    console.log(`Volume: ON — trading ${opts.tradingBase}, faucet ${opts.faucetUrl}`);
    console.log(`        market ${opts.market}, ${opts.orders} orders/acct, notional $${opts.minNotional}-$${opts.maxNotional}, faucet USDT=${opts.faucetUsdt} ETH=${opts.faucetEth}`);
  } else {
    console.log('Volume: OFF (--volume false)');
  }
  console.log('');

  const rl = createRateLimiter(opts.rps);

  const total = queue.length;
  const results = [];
  const jwts = [];
  let done = 0;
  const onResult = (r) => {
    done++;
    const marker = r.status === 'enrolled' ? 'OK'
      : r.status === 'already_enrolled' ? 'DUP'
      : 'ERR';
    const note = r.status === 'failed'
      ? ` (${r.httpStatus} ${r.body?.error?.code || 'unknown'})`
      : '';
    let vol = '';
    if (r.volume) {
      if (r.volume.error) {
        vol = ` | vol ERR: ${r.volume.error}`;
      } else {
        const fOk = r.volume.faucet.filter((f) => f.ok).length;
        vol = ` | faucet ${fOk}/${r.volume.faucet.length}, orders ${r.volume.ordersAccepted}/${r.volume.ordersPlaced} @${r.volume.refSource}`;
      }
    }
    console.log(`[${done}/${total}] ${marker} ${r.address}${note}${vol}`);
  };

  const startedAt = Date.now();
  const workers = [];
  for (let i = 0; i < opts.concurrency; i++) {
    workers.push(worker(queue, results, jwts, opts, rl, onResult));
  }
  await Promise.all(workers);
  const elapsedMs = Date.now() - startedAt;

  const summary = {
    enrolled:         results.filter((r) => r.status === 'enrolled').length,
    already_enrolled: results.filter((r) => r.status === 'already_enrolled').length,
    failed:           results.filter((r) => r.status === 'failed').length,
  };

  console.log('');
  console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  enrolled:         ${summary.enrolled}`);
  console.log(`  already_enrolled: ${summary.already_enrolled}`);
  console.log(`  failed:           ${summary.failed}`);

  if (summary.failed > 0) {
    const codes = {};
    for (const r of results) {
      if (r.status !== 'failed') continue;
      const c = r.body?.error?.code || `HTTP_${r.httpStatus}`;
      codes[c] = (codes[c] || 0) + 1;
    }
    console.log('  failure breakdown:', codes);
  }

  if (opts.volume) {
    const vols = results.map((r) => r.volume).filter((v) => v && !v.error);
    const faucetOk = vols.reduce((n, v) => n + v.faucet.filter((f) => f.ok).length, 0);
    const faucetTot = vols.reduce((n, v) => n + v.faucet.length, 0);
    const ordAccepted = vols.reduce((n, v) => n + v.ordersAccepted, 0);
    const ordPlaced = vols.reduce((n, v) => n + v.ordersPlaced, 0);
    console.log('');
    console.log('  volume:');
    console.log(`    faucet deposits ok:  ${faucetOk}/${faucetTot}`);
    console.log(`    market orders accepted: ${ordAccepted}/${ordPlaced}`);
    if (ordPlaced > 0 && ordAccepted === 0) {
      console.log('    ⚠️  0 orders accepted — book may be empty or account underfunded; check per-account errors in the results file.');
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(__dirname, `enrollments-${opts.competition}-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    base: opts.base,
    competition: opts.competition,
    started_at: new Date(startedAt).toISOString(),
    elapsed_ms: elapsedMs,
    summary,
    results,
  }, null, 2));
  console.log(`\nResults written to ${outFile}`);

  const jwtFile = path.join(__dirname, `wallet-jwts-${opts.competition}-${ts}.json`);
  fs.writeFileSync(jwtFile, JSON.stringify(jwts, null, 2));
  console.log(`JWTs written to  ${jwtFile} (${jwts.length} entries)`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
