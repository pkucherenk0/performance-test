#!/usr/bin/env node
// Generate ETH wallets, authenticate each one against NeoDax (challenge / verify),
// then enroll each in a yellow-pro-hub competition using its own JWT.
//
// This is the PERPETUALS variant of enroll-competition.js. The enrollment and auth
// flow is identical; the difference is in how volume is generated:
//   spot   : faucet USDT/ETH -> spot MARKET orders
//   perp   : faucet USDT (spot) -> transfer spot->perps -> perpetual MARKET orders
//
// Per account the perp volume flow is:
//   1. faucet USDT into the spot account
//   2. transfer USDT spot -> perps               (POST /accounts/transfer, async/202)
//      (the perpetuals account is created automatically on first transfer)
//   3. poll until the USDT shows up on the perps side
//   4. fire `--orders` round-trip MARKET orders  (open long/short, then reduce-only close)
//
// Usage:
//   node enroll-competition-perp.js                              # defaults below
//   node enroll-competition-perp.js --count 50
//   node enroll-competition-perp.js --competition edition-1 --count 25 --concurrency 4
//   node enroll-competition-perp.js --count 10 --orders 3        # enroll + perp volume (default)
//   node enroll-competition-perp.js --count 10 --no-volume       # enroll only
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
//   --market         ETHUSDT-PERP   (auto-resolved against /perpetual/exchangeInfo;
//                                      falls back to the first TRADING market if not found)
//   --orders         3              (round-trip market orders per account; each = open + close)
//   --faucet-usdt    500            (USDT credited to the SPOT account per account)
//   --transfer-usdt  200            (USDT moved spot -> perps per account)
//   --leverage       5              (used for isolated; cross uses the account-market initial leverage)
//   --min-notional 50 / --max-notional 150   (per-order USD notional range; raised to market MIN_NOTIONAL)
//   --fallback-price 3000           (used to size orders if mark price is unavailable, ~current ETH)
//   --close true     (set false to leave positions open instead of round-tripping)
//
// NOTE: market orders only produce real volume if the perp book has opposing
// liquidity; rejected / zero-fill orders are logged but are not fatal.
//
// Output:
//   ./enrollments-perp-<competition>-<ts>.json — enrollment + volume results (no private keys)
//   ./wallet-jwts-perp-<competition>-<ts>.json — { address, jwt } pairs

const fs = require('fs');
const path = require('path');
const { Wallet } = require('ethers');

const DEFAULTS = {
  base: 'https://hub.uat.yellow.pro.neodax.app',
  authBase: 'https://auth.uat.yellow.pro.neodax.app',
  competition: 'pablo-13',
  //base: 'https://hub.staging.yellow.pro.neodax.app',
  //authBase: 'https://auth.staging.yellow.pro.neodax.app',
  //competition: 'edition-1',
  count: 20,
  concurrency: 2,
  rps: 4,
  maxRetries: 5,
  delay: 0,
  terms: true,

  // --- Volume generation (faucet + spot->perps transfer + perp market orders) ---
  // NOTE: tradingBase / faucetUrl MUST be the same environment as base/authBase,
  // since the auth JWT and the spot/perps accounts are env-scoped.
  volume: true,                                                   // run faucet+transfer+trading after each enroll
  tradingBase: 'https://api.uat.yellow.pro.neodax.app',           // Trading API (perp orders, transfer, market data)
  faucetUrl: 'https://faucet.uat.yellow.pro.neodax.app/api/deposit',
  market: 'ETHUSDT-PERP',     // perp market to trade (auto-resolved against exchangeInfo)
  collateral: 'USDT',         // stablecoin collateral asset (faucet + transfer + margin)
  orders: 3,                  // round-trip market orders per account (each = open + close)
  faucetUsdt: '500',          // USDT credited to the SPOT account per account
  transferUsdt: '200',        // USDT moved spot -> perps per account
  leverage: 5,                // order leverage (isolated); cross ignores and uses account-market initial
  minNotional: 50,            // min USD notional per order (raised to the market's MIN_NOTIONAL if lower)
  maxNotional: 150,           // max USD notional per order
  fallbackPrice: 3000,        // used to size orders if mark price is unavailable (~current ETH)
  close: true,                // round-trip: open then immediately close (reduce-only) to free margin
  transferTimeoutMs: 15000,   // how long to wait for the spot->perps transfer to settle
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--base':          out.base = next; i++; break;
      case '--auth-base':     out.authBase = next; i++; break;
      case '--competition':   out.competition = next; i++; break;
      case '--count':         out.count = parseInt(next, 10); i++; break;
      case '--concurrency':   out.concurrency = parseInt(next, 10); i++; break;
      case '--rps':           out.rps = parseFloat(next); i++; break;
      case '--max-retries':   out.maxRetries = parseInt(next, 10); i++; break;
      case '--delay':         out.delay = parseInt(next, 10); i++; break;
      case '--terms':         out.terms = next !== 'false'; i++; break;
      case '--volume':        out.volume = next !== 'false'; i++; break;
      case '--no-volume':     out.volume = false; break;
      case '--trading-base':  out.tradingBase = next; i++; break;
      case '--faucet-url':    out.faucetUrl = next; i++; break;
      case '--market':        out.market = next; i++; break;
      case '--collateral':    out.collateral = next; i++; break;
      case '--orders':        out.orders = parseInt(next, 10); i++; break;
      case '--faucet-usdt':   out.faucetUsdt = next; i++; break;
      case '--transfer-usdt': out.transferUsdt = next; i++; break;
      case '--leverage':      out.leverage = parseFloat(next); i++; break;
      case '--min-notional':  out.minNotional = parseFloat(next); i++; break;
      case '--max-notional':  out.maxNotional = parseFloat(next); i++; break;
      case '--fallback-price': out.fallbackPrice = parseFloat(next); i++; break;
      case '--close':         out.close = next !== 'false'; i++; break;
      case '--no-close':      out.close = false; break;
      case '-h':
      case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 60).join('\n'));
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
// Perp volume generation: faucet (spot) -> transfer spot->perps -> perp orders.
// ---------------------------------------------------------------------------

async function faucet(rl, faucetUrl, appSessionId, asset, amount, maxRetries) {
  const resp = await postJson(rl, faucetUrl, { app_session_id: appSessionId, asset, amount }, {}, maxRetries);
  return { ok: resp.ok && resp.body?.success === true, httpStatus: resp.httpStatus, body: resp.body };
}

// POST /accounts/transfer — move stablecoin collateral spot -> perps (async, returns 202).
async function transferSpotToPerps(rl, tradingBase, jwt, appSessionId, asset, amount, maxRetries) {
  const url = `${tradingBase.replace(/\/$/, '')}/accounts/transfer`;
  const resp = await postJson(
    rl,
    url,
    {
      app_session_id: appSessionId,
      source_account_type: 'spot',
      dest_account_type: 'perps',
      asset_symbol: asset,
      amount,
    },
    { 'Authorization': `Bearer ${jwt}` },
    maxRetries,
  );
  // Transfer accepted = 202; funds land asynchronously.
  return {
    ok: resp.httpStatus === 202 || resp.ok,
    httpStatus: resp.httpStatus,
    transferId: resp.body?.transfer_id || null,
    error: (resp.httpStatus === 202 || resp.ok) ? null : (resp.body?.error || resp.body?.message || `HTTP_${resp.httpStatus}`),
  };
}

// GET /perpetual/balance — returns an array of per-asset balances (empty array if no account yet).
async function getPerpAvailable(rl, tradingBase, jwt, appSessionId, asset, maxRetries) {
  const url = `${tradingBase.replace(/\/$/, '')}/perpetual/balance?app_session_id=${encodeURIComponent(appSessionId)}`;
  const resp = await getJson(rl, url, { 'Authorization': `Bearer ${jwt}` }, maxRetries);
  if (!resp.ok || !Array.isArray(resp.body)) return 0;
  const bal = resp.body.find((b) => b.asset_symbol === asset);
  return bal ? parseFloat(bal.available_balance || '0') : 0;
}

// Poll the perps side until the collateral shows up (transfer settled) or we time out.
async function waitForPerpFunds(rl, opts, jwt, appSessionId, minAmount, maxRetries) {
  const deadline = Date.now() + opts.transferTimeoutMs;
  let avail = 0;
  while (Date.now() < deadline) {
    avail = await getPerpAvailable(rl, opts.tradingBase, jwt, appSessionId, opts.collateral, maxRetries);
    if (avail >= minAmount) return { settled: true, available: avail };
    await sleep(750);
  }
  return { settled: avail > 0, available: avail };
}

// Pull a filter config block (LOT_SIZE, MIN_NOTIONAL, ...) out of a symbol entry.
function findFilter(sym, type) {
  const f = (sym.filters || []).find((x) => x.filter_type === type);
  return f ? f.config || {} : {};
}

// GET /perpetual/exchangeInfo — resolve the trading market + its lot/notional constraints.
async function resolvePerpMarket(rl, tradingBase, wanted, maxRetries) {
  const url = `${tradingBase.replace(/\/$/, '')}/perpetual/exchangeInfo`;
  const resp = await getJson(rl, url, {}, maxRetries);
  const symbols = Array.isArray(resp.body?.symbols) ? resp.body.symbols : [];
  const trading = symbols.filter((s) => (s.status || '').toUpperCase() === 'TRADING');
  const exact = trading.find((s) => s.symbol === wanted) || symbols.find((s) => s.symbol === wanted);
  const chosen = exact || trading[0] || symbols[0] || null;
  if (!chosen) return { market: wanted, amountPrecision: 3, stepSize: 0.001, minQty: 0.001, minNotional: 1, resolved: false };

  const lot = findFilter(chosen, 'LOT_SIZE');
  const notional = findFilter(chosen, 'MIN_NOTIONAL');
  return {
    market: chosen.symbol,
    amountPrecision: Number.isFinite(chosen.amount_precision) ? chosen.amount_precision : 3,
    stepSize: parseFloat(lot.step_size || '') || Math.pow(10, -(chosen.amount_precision || 3)),
    minQty: parseFloat(lot.min_qty || '') || 0,
    minNotional: parseFloat(notional.min_notional || '') || 0,
    maxLeverage: parseFloat(chosen.max_allowed_leverage || '0') || null,
    resolved: chosen.symbol === wanted,
  };
}

// Reference price for sizing: mark price from funding-rates/current ->
// per-symbol funding-rate -> fallback.
async function getMarkPrice(rl, tradingBase, market, fallbackPrice, maxRetries) {
  const root = tradingBase.replace(/\/$/, '');

  const all = await getJson(rl, `${root}/perpetual/funding-rates/current?symbols=${encodeURIComponent(market)}`, {}, maxRetries);
  const rates = all.body?.funding_rates || all.body?.fundingRates || [];
  const entry = Array.isArray(rates) ? rates.find((r) => r.market === market) : null;
  let mark = parseFloat(entry?.mark_price || entry?.markPrice || '');
  if (Number.isFinite(mark) && mark > 0) return { price: mark, source: 'mark_price' };

  const one = await getJson(rl, `${root}/perpetual/funding-rate/${encodeURIComponent(market)}`, {}, maxRetries);
  const cur = one.body?.current_funding_rate || one.body?.currentFundingRate || {};
  mark = parseFloat(cur.mark_price || cur.markPrice || '');
  if (Number.isFinite(mark) && mark > 0) return { price: mark, source: 'funding_rate' };

  return { price: fallbackPrice, source: 'fallback' };
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function decimalsOf(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

// Size a base-asset amount from a USD notional, honouring the market's
// step_size, min_qty and min_notional. Returns a decimal string.
function sizeAmount(notionalUsd, price, mkt) {
  const step = mkt.stepSize > 0 ? mkt.stepSize : Math.pow(10, -(mkt.amountPrecision || 3));
  const decimals = Math.max(decimalsOf(step), mkt.amountPrecision || 0);

  // Floor of the per-order notional we must clear (market min, plus a small buffer for fees/price drift).
  const minNotional = mkt.minNotional > 0 ? mkt.minNotional * 1.05 : 0;
  const targetNotional = Math.max(notionalUsd, minNotional);

  let qty = targetNotional / price;
  qty = Math.ceil(qty / step) * step;            // round UP to a whole step so we don't dip below min_notional
  if (mkt.minQty > 0 && qty < mkt.minQty) qty = mkt.minQty;
  // Final guard: ensure notional clears the market minimum after rounding.
  while (mkt.minNotional > 0 && qty * price < mkt.minNotional) qty += step;

  return qty.toFixed(decimals);
}

// POST /perpetual/order — create a perpetual MARKET order.
// Opening: side=buy/direction=long or side=sell/direction=short.
// Closing (reduce-only): opposite side, SAME direction as the position being closed.
async function createPerpMarketOrder(rl, tradingBase, jwt, appSessionId, market, side, direction, amountStr, leverage, reduceOnly, maxRetries) {
  const url = `${tradingBase.replace(/\/$/, '')}/perpetual/order`;
  const body = {
    app_session_id: appSessionId,
    market,
    side,                 // "buy" | "sell"
    direction,            // "long" | "short"
    type: 'market',
    amount: amountStr,
    reduce_only: reduceOnly,
  };
  if (leverage && leverage >= 1) body.leverage = String(leverage);
  const resp = await postJson(rl, url, body, { 'Authorization': `Bearer ${jwt}` }, maxRetries);
  return {
    ok: resp.ok && !!resp.body?.order_uuid,
    httpStatus: resp.httpStatus,
    orderUuid: resp.body?.order_uuid || null,
    error: resp.ok ? null : (resp.body?.error || `HTTP_${resp.httpStatus}`),
    message: resp.body?.message,
  };
}

// Faucet USDT to spot, transfer collateral to perps, then fire perp orders.
// The perpetuals account is created automatically on the first transfer.
async function runVolumeForAccount(rl, opts, address, jwt) {
  const appSessionId = address; // faucet + spot + perps accounts are keyed by wallet address

  // 1. Faucet the collateral into the SPOT account (the faucet only credits spot).
  const f = await faucet(rl, opts.faucetUrl, appSessionId, opts.collateral, opts.faucetUsdt, opts.maxRetries);
  const faucetResult = { asset: opts.collateral, amount: opts.faucetUsdt, ok: f.ok, httpStatus: f.httpStatus, error: f.ok ? null : (f.body?.error || f.body?.message || `HTTP_${f.httpStatus}`) };

  // 2. Transfer collateral spot -> perps (async; auto-creates the perps account).
  const xfer = await transferSpotToPerps(rl, opts.tradingBase, jwt, appSessionId, opts.collateral, opts.transferUsdt, opts.maxRetries);

  // 3. Wait for the funds to land on the perps side.
  const transferAmt = parseFloat(opts.transferUsdt);
  const funds = xfer.ok
    ? await waitForPerpFunds(rl, opts, jwt, appSessionId, transferAmt * 0.9, opts.maxRetries)
    : { settled: false, available: 0 };

  // 4. Resolve market + mark price, then fire round-trip market orders.
  const mkt = await resolvePerpMarket(rl, opts.tradingBase, opts.market, opts.maxRetries);
  const ref = await getMarkPrice(rl, opts.tradingBase, mkt.market, opts.fallbackPrice, opts.maxRetries);

  const orders = [];
  let accepted = 0;
  if (funds.available > 0) {
    for (let i = 0; i < opts.orders; i++) {
      const direction = Math.random() < 0.5 ? 'long' : 'short';
      const openSide = direction === 'long' ? 'buy' : 'sell';
      const notional = randBetween(opts.minNotional, opts.maxNotional);
      const amountStr = sizeAmount(notional, ref.price, mkt);

      // Open
      const open = await createPerpMarketOrder(rl, opts.tradingBase, jwt, appSessionId, mkt.market, openSide, direction, amountStr, opts.leverage, false, opts.maxRetries);
      if (open.ok) accepted++;
      orders.push({ phase: 'open', direction, side: openSide, amount: amountStr, ok: open.ok, httpStatus: open.httpStatus, orderUuid: open.orderUuid, error: open.error });
      if (opts.delay > 0) await sleep(opts.delay);

      // Close (reduce-only) to free margin for the next iteration.
      if (opts.close && open.ok) {
        const closeSide = direction === 'long' ? 'sell' : 'buy';
        const close = await createPerpMarketOrder(rl, opts.tradingBase, jwt, appSessionId, mkt.market, closeSide, direction, amountStr, opts.leverage, true, opts.maxRetries);
        if (close.ok) accepted++;
        orders.push({ phase: 'close', direction, side: closeSide, amount: amountStr, ok: close.ok, httpStatus: close.httpStatus, orderUuid: close.orderUuid, error: close.error });
        if (opts.delay > 0) await sleep(opts.delay);
      }
    }
  }

  return {
    faucet: [faucetResult],
    transfer: { ok: xfer.ok, httpStatus: xfer.httpStatus, transferId: xfer.transferId, error: xfer.error, settled: funds.settled, perpAvailable: funds.available },
    market: mkt.market,
    marketResolved: mkt.resolved,
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

    // Generate volume regardless of enroll outcome (we have a valid JWT + fundable accounts).
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
    console.log(`Volume: ON (PERP) — trading ${opts.tradingBase}, faucet ${opts.faucetUrl}`);
    console.log(`        market ${opts.market}, ${opts.orders} round-trips/acct${opts.close ? ' (open+close)' : ' (open only)'}, notional $${opts.minNotional}-$${opts.maxNotional}, leverage ${opts.leverage}x`);
    console.log(`        faucet ${opts.collateral}=${opts.faucetUsdt} (spot) -> transfer ${opts.transferUsdt} ${opts.collateral} to perps`);
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
        const v = r.volume;
        const fOk = v.faucet.filter((f) => f.ok).length;
        const xfer = v.transfer.ok ? (v.transfer.settled ? `xfer OK (${v.transfer.perpAvailable} ${opts.collateral})` : `xfer pending (${v.transfer.perpAvailable})`) : `xfer ERR(${v.transfer.error})`;
        vol = ` | faucet ${fOk}/${v.faucet.length}, ${xfer}, orders ${v.ordersAccepted}/${v.ordersPlaced} @${v.refSource}`;
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
    const xferOk = vols.filter((v) => v.transfer.ok).length;
    const xferSettled = vols.filter((v) => v.transfer.settled).length;
    const ordAccepted = vols.reduce((n, v) => n + v.ordersAccepted, 0);
    const ordPlaced = vols.reduce((n, v) => n + v.ordersPlaced, 0);
    console.log('');
    console.log('  volume (perp):');
    console.log(`    faucet deposits ok:     ${faucetOk}/${faucetTot}`);
    console.log(`    transfers accepted:     ${xferOk}/${vols.length} (settled on perps: ${xferSettled})`);
    console.log(`    perp orders accepted:   ${ordAccepted}/${ordPlaced}`);
    if (ordPlaced > 0 && ordAccepted === 0) {
      console.log('    ⚠️  0 orders accepted — perps may be underfunded (transfer not settled) or the book is empty; check per-account errors in the results file.');
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(__dirname, `enrollments-perp-${opts.competition}-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    base: opts.base,
    competition: opts.competition,
    mode: 'perp',
    started_at: new Date(startedAt).toISOString(),
    elapsed_ms: elapsedMs,
    summary,
    results,
  }, null, 2));
  console.log(`\nResults written to ${outFile}`);

  const jwtFile = path.join(__dirname, `wallet-jwts-perp-${opts.competition}-${ts}.json`);
  fs.writeFileSync(jwtFile, JSON.stringify(jwts, null, 2));
  console.log(`JWTs written to  ${jwtFile} (${jwts.length} entries)`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
