#!/usr/bin/env node
'use strict';
// Bulk-enroll fresh wallets into a competition and (optionally) generate SPOT volume:
//   faucet USDT + ETH -> random buy/sell spot MARKET orders.
// The auth/enroll/worker-pool/output plumbing is shared in ../lib/enroll-runner.js.
//
// Usage:
//   node enroll/spot.js                                  # defaults below
//   node enroll/spot.js --count 50
//   node enroll/spot.js --competition edition-1 --count 25 --concurrency 4
//   node enroll/spot.js --count 10 --no-volume           # enroll only
//   node enroll/spot.js --help

const { getJson } = require('../lib/http');
const { faucet } = require('../lib/accounts');
const { createSpotOrder } = require('../lib/spot');
const { runEnrollment } = require('../lib/enroll-runner');
const { applyEnv } = require('../lib/env');

const DEFAULTS = {
  env: 'uat',                 // --env uat|stage (stage has no faucet; see note below)
  base: 'https://hub.uat.yellow.pro.neodax.app',
  authBase: 'https://auth.uat.yellow.pro.neodax.app',
  competition: 'pablo-12',
  count: 20,
  concurrency: 2,
  rps: 4,
  maxRetries: 5,
  delay: 0,
  terms: true,

  // --- Volume generation (faucet + random spot market orders) ---
  volume: true,
  tradingBase: 'https://api.uat.yellow.pro.neodax.app',
  faucetUrl: 'https://faucet.uat.yellow.pro.neodax.app/api/deposit',
  market: 'ETHUSDT',          // spot market to trade
  orders: 5,                  // random market orders per account
  faucetUsdt: '200',          // USDT credited per account (funds buys)
  faucetEth: '0.1',           // ETH credited per account (funds sells)
  minNotional: 5,             // min USD notional per order
  maxNotional: 20,            // max USD notional per order
  stepSize: 0.001,            // ETHUSDT LOT_SIZE step_size (amount granularity)
  minQty: 0.001,              // ETHUSDT LOT_SIZE min_qty
  fallbackPrice: 1700,        // used to size orders if orderbook/ticker price is unavailable
};

const USAGE = `Bulk-enroll wallets + generate SPOT volume (faucet USDT/ETH -> random spot market orders).

Usage:
  node enroll/spot.js [--count N] [--competition slug] [--concurrency K] [--no-volume]
Flags: --base --auth-base --competition --count --concurrency --rps --max-retries --delay
  --terms --volume/--no-volume --trading-base --faucet-url --market --orders
  --faucet-usdt --faucet-eth --min-notional --max-notional --fallback-price
Output (to competition/ root): enrollments-<comp>-<ts>.json + wallet-jwts-<comp>-<ts>.json`;

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  const explicit = new Set();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    switch (a) {
      case '--env':            out.env = String(next).toLowerCase(); i++; break;
      case '--base':           out.base = next; explicit.add('base'); i++; break;
      case '--auth-base':      out.authBase = next; explicit.add('authBase'); i++; break;
      case '--competition':    out.competition = next; i++; break;
      case '--count':          out.count = parseInt(next, 10); i++; break;
      case '--concurrency':    out.concurrency = parseInt(next, 10); i++; break;
      case '--rps':            out.rps = parseFloat(next); i++; break;
      case '--max-retries':    out.maxRetries = parseInt(next, 10); i++; break;
      case '--delay':          out.delay = parseInt(next, 10); i++; break;
      case '--terms':          out.terms = next !== 'false'; i++; break;
      case '--volume':         out.volume = next !== 'false'; i++; break;
      case '--no-volume':      out.volume = false; break;
      case '--trading-base':   out.tradingBase = next; explicit.add('tradingBase'); i++; break;
      case '--faucet-url':     out.faucetUrl = next; explicit.add('faucetUrl'); i++; break;
      case '--market':         out.market = next; i++; break;
      case '--orders':         out.orders = parseInt(next, 10); i++; break;
      case '--faucet-usdt':    out.faucetUsdt = next; i++; break;
      case '--faucet-eth':     out.faucetEth = next; i++; break;
      case '--min-notional':   out.minNotional = parseFloat(next); i++; break;
      case '--max-notional':   out.maxNotional = parseFloat(next); i++; break;
      case '--fallback-price': out.fallbackPrice = parseFloat(next); i++; break;
      case '-h':
      case '--help': console.log(USAGE); process.exit(0);
      default: console.error(`Unknown arg: ${a}`); process.exit(2);
    }
  }
  applyEnv(out, explicit);
  if (!out.faucet && out.volume) {
    console.warn(`⚠️  env "${out.env}" has no faucet — fresh wallets can't be funded, so volume is disabled (enroll only).`);
    out.volume = false;
  }
  return out;
}

const randBetween = (min, max) => min + Math.random() * (max - min);

// Quantize a base-asset amount to the lot step, clamped to min_qty.
function quantizeAmount(amount, stepSize, minQty) {
  const steps = Math.max(1, Math.round(amount / stepSize));
  const q = Math.max(minQty, steps * stepSize);
  const decimals = (String(stepSize).split('.')[1] || '').length;
  return q.toFixed(decimals);
}

// Reference price for sizing: orderbook mid -> best bid/ask -> ticker last -> fallback.
async function getReferencePrice(rl, opts, market) {
  const root = opts.tradingBase.replace(/\/$/, '');
  const ob = await getJson(rl, `${root}/orderbook?symbol=${encodeURIComponent(market)}`, {}, opts.maxRetries);
  if (ob.ok) {
    const bestBid = parseFloat(ob.body?.bids?.[0]?.[0]);
    const bestAsk = parseFloat(ob.body?.asks?.[0]?.[0]);
    if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) return { price: (bestBid + bestAsk) / 2, source: 'orderbook_mid' };
    if (Number.isFinite(bestBid)) return { price: bestBid, source: 'best_bid' };
    if (Number.isFinite(bestAsk)) return { price: bestAsk, source: 'best_ask' };
  }
  const tk = await getJson(rl, `${root}/ticker/24hr?symbol=${encodeURIComponent(market)}`, {}, opts.maxRetries);
  const last = parseFloat(tk.body?.last);
  if (tk.ok && Number.isFinite(last) && last > 0) return { price: last, source: 'ticker_last' };
  return { price: opts.fallbackPrice, source: 'fallback' };
}

// Faucet both assets, then place `opts.orders` random buy/sell spot market orders.
async function runVolumeForAccount(rl, opts, address, jwt) {
  const appSessionId = address;
  const faucetResults = [];
  for (const [asset, amount] of [['USDT', opts.faucetUsdt], ['ETH', opts.faucetEth]]) {
    const f = await faucet(rl, opts.faucetUrl, appSessionId, asset, amount, opts.maxRetries);
    faucetResults.push({ asset, amount, ok: f.ok, httpStatus: f.httpStatus, error: f.ok ? null : (f.body?.error || f.body?.message || `HTTP_${f.httpStatus}`) });
  }

  const ref = await getReferencePrice(rl, opts, opts.market);
  const orders = [];
  let accepted = 0;
  for (let i = 0; i < opts.orders; i++) {
    const side = Math.random() < 0.5 ? 'buy' : 'sell';
    const notional = randBetween(opts.minNotional, opts.maxNotional);
    const amountStr = quantizeAmount(notional / ref.price, opts.stepSize, opts.minQty);
    const r = await createSpotOrder(rl, opts, jwt, appSessionId, { market: opts.market, side, type: 'market', amount: amountStr });
    if (r.ok) accepted++;
    orders.push({ side, amount: amountStr, ok: r.ok, httpStatus: r.httpStatus, orderUuid: r.orderUuid, error: r.error });
    if (opts.delay > 0) await new Promise((res) => setTimeout(res, opts.delay));
  }
  return { faucet: faucetResults, refPrice: ref.price, refSource: ref.source, ordersPlaced: orders.length, ordersAccepted: accepted, orders };
}

function printConfig(opts) {
  console.log(`Volume: ON — trading ${opts.tradingBase}, faucet ${opts.faucetUrl}`);
  console.log(`        market ${opts.market}, ${opts.orders} orders/acct, notional $${opts.minNotional}-$${opts.maxNotional}, faucet USDT=${opts.faucetUsdt} ETH=${opts.faucetEth}`);
}

function volumeLine(v) {
  const fOk = v.faucet.filter((f) => f.ok).length;
  return ` | faucet ${fOk}/${v.faucet.length}, orders ${v.ordersAccepted}/${v.ordersPlaced} @${v.refSource}`;
}

function printVolumeSummary(results) {
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

const opts = parseArgs(process.argv);
runEnrollment(opts, {
  filePrefix: 'enrollments', jwtPrefix: 'wallet-jwts',
  printConfig, runVolume: runVolumeForAccount, volumeLine, printVolumeSummary,
}).catch((err) => { console.error('Fatal:', err); process.exit(1); });
