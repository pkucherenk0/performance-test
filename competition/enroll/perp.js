#!/usr/bin/env node
'use strict';
// Bulk-enroll fresh wallets into a competition and (optionally) generate PERP volume:
//   faucet USDT (spot) -> transfer spot->perps -> round-trip perp MARKET orders (open + reduce-only close).
// The auth/enroll/worker-pool/output plumbing is shared in ../lib/enroll-runner.js.
//
// Usage:
//   node enroll/perp.js                                  # defaults below
//   node enroll/perp.js --count 50
//   node enroll/perp.js --count 10 --orders 3 --market ETHUSDT-PERP
//   node enroll/perp.js --count 10 --no-volume           # enroll only
//   node enroll/perp.js --help

const { getMarkPrice, resolvePerpMarket, sizeAmount, createOrder } = require('../lib/market');
const { faucet, transferSpotToPerps, waitForPerpFunds } = require('../lib/accounts');
const { runEnrollment } = require('../lib/enroll-runner');
const { applyEnv } = require('../lib/env');

const DEFAULTS = {
  env: 'uat',                 // --env uat|stage (stage has no faucet; see note below)
  base: 'https://hub.uat.yellow.pro.neodax.app',
  authBase: 'https://auth.uat.yellow.pro.neodax.app',
  competition: 'pablo-13',
  count: 20,
  concurrency: 2,
  rps: 4,
  maxRetries: 5,
  delay: 0,
  terms: true,

  // --- Volume generation (faucet + spot->perps transfer + perp market orders) ---
  volume: true,
  tradingBase: 'https://api.uat.yellow.pro.neodax.app',
  faucetUrl: 'https://faucet.uat.yellow.pro.neodax.app/api/deposit',
  market: 'ETHUSDT-PERP',     // perp market (auto-resolved against exchangeInfo)
  collateral: 'USDT',         // stablecoin collateral asset (faucet + transfer + margin)
  orders: 3,                  // round-trip market orders per account (each = open + close)
  faucetUsdt: '500',          // USDT credited to the SPOT account per account
  transferUsdt: '200',        // USDT moved spot -> perps per account
  leverage: 5,                // order leverage (isolated); cross uses account-market initial
  minNotional: 50,            // min USD notional per order (raised to market MIN_NOTIONAL)
  maxNotional: 150,           // max USD notional per order
  fallbackPrice: 3000,        // used to size orders if mark price is unavailable (~current ETH)
  close: true,                // round-trip: open then immediately close (reduce-only)
  transferTimeoutMs: 15000,   // how long to wait for the spot->perps transfer to settle
};

const USAGE = `Bulk-enroll wallets + generate PERP volume (faucet -> transfer spot->perps -> perp round-trips).

Usage:
  node enroll/perp.js [--count N] [--competition slug] [--orders R] [--no-volume]
Flags: --base --auth-base --competition --count --concurrency --rps --max-retries --delay
  --terms --volume/--no-volume --trading-base --faucet-url --market --collateral --orders
  --faucet-usdt --transfer-usdt --leverage --min-notional --max-notional --fallback-price --close/--no-close
Output (to competition/ root): enrollments-perp-<comp>-<ts>.json + wallet-jwts-perp-<comp>-<ts>.json`;

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
      case '--collateral':     out.collateral = next; i++; break;
      case '--orders':         out.orders = parseInt(next, 10); i++; break;
      case '--faucet-usdt':    out.faucetUsdt = next; i++; break;
      case '--transfer-usdt':  out.transferUsdt = next; i++; break;
      case '--leverage':       out.leverage = parseFloat(next); i++; break;
      case '--min-notional':   out.minNotional = parseFloat(next); i++; break;
      case '--max-notional':   out.maxNotional = parseFloat(next); i++; break;
      case '--fallback-price': out.fallbackPrice = parseFloat(next); i++; break;
      case '--close':          out.close = next !== 'false'; i++; break;
      case '--no-close':       out.close = false; break;
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

// Faucet USDT to spot, transfer collateral to perps, then fire round-trip perp orders.
// The perpetuals account is created automatically on the first transfer.
async function runVolumeForAccount(rl, opts, address, jwt) {
  const appSessionId = address;

  // 1. Faucet collateral into the SPOT account (the faucet only credits spot).
  const f = await faucet(rl, opts.faucetUrl, appSessionId, opts.collateral, opts.faucetUsdt, opts.maxRetries);
  const faucetResult = { asset: opts.collateral, amount: opts.faucetUsdt, ok: f.ok, httpStatus: f.httpStatus, error: f.ok ? null : (f.body?.error || f.body?.message || `HTTP_${f.httpStatus}`) };

  // 2. Transfer collateral spot -> perps (async; auto-creates the perps account).
  const xfer = await transferSpotToPerps(rl, opts.tradingBase, jwt, appSessionId, opts.collateral, opts.transferUsdt, opts.maxRetries);

  // 3. Wait for the funds to land on the perps side.
  const transferAmt = parseFloat(opts.transferUsdt);
  const funds = xfer.ok ? await waitForPerpFunds(rl, opts, jwt, appSessionId, transferAmt * 0.9) : { settled: false, available: 0 };

  // 4. Resolve market + mark price, then fire round-trip market orders.
  const mkt = await resolvePerpMarket(rl, opts.tradingBase, opts.market, opts.maxRetries);
  const mark = await getMarkPrice(rl, opts.tradingBase, mkt.market, opts.maxRetries);
  const ref = mark > 0 ? { price: mark, source: 'mark_price' } : { price: opts.fallbackPrice, source: 'fallback' };

  const orders = [];
  let accepted = 0;
  if (funds.available > 0) {
    for (let i = 0; i < opts.orders; i++) {
      const direction = Math.random() < 0.5 ? 'long' : 'short';
      const openSide = direction === 'long' ? 'buy' : 'sell';
      const notional = randBetween(opts.minNotional, opts.maxNotional);
      const amountStr = sizeAmount(notional, ref.price, mkt);

      const open = await createOrder(rl, opts, jwt, appSessionId, { market: mkt.market, side: openSide, direction, type: 'market', amount: amountStr, reduceOnly: false });
      if (open.ok) accepted++;
      orders.push({ phase: 'open', direction, side: openSide, amount: amountStr, ok: open.ok, httpStatus: open.httpStatus, orderUuid: open.orderUuid, error: open.error });
      if (opts.delay > 0) await new Promise((res) => setTimeout(res, opts.delay));

      if (opts.close && open.ok) {
        const closeSide = direction === 'long' ? 'sell' : 'buy';
        const close = await createOrder(rl, opts, jwt, appSessionId, { market: mkt.market, side: closeSide, direction, type: 'market', amount: amountStr, reduceOnly: true });
        if (close.ok) accepted++;
        orders.push({ phase: 'close', direction, side: closeSide, amount: amountStr, ok: close.ok, httpStatus: close.httpStatus, orderUuid: close.orderUuid, error: close.error });
        if (opts.delay > 0) await new Promise((res) => setTimeout(res, opts.delay));
      }
    }
  }

  return {
    faucet: [faucetResult],
    transfer: { ok: xfer.ok, httpStatus: xfer.httpStatus, transferId: xfer.transferId, error: xfer.error, settled: funds.settled, perpAvailable: funds.available },
    market: mkt.market, marketResolved: mkt.resolved,
    refPrice: ref.price, refSource: ref.source,
    ordersPlaced: orders.length, ordersAccepted: accepted, orders,
  };
}

function printConfig(opts) {
  console.log(`Volume: ON (PERP) — trading ${opts.tradingBase}, faucet ${opts.faucetUrl}`);
  console.log(`        market ${opts.market}, ${opts.orders} round-trips/acct${opts.close ? ' (open+close)' : ' (open only)'}, notional $${opts.minNotional}-$${opts.maxNotional}, leverage ${opts.leverage}x`);
  console.log(`        faucet ${opts.collateral}=${opts.faucetUsdt} (spot) -> transfer ${opts.transferUsdt} ${opts.collateral} to perps`);
}

function volumeLine(v, opts) {
  const fOk = v.faucet.filter((f) => f.ok).length;
  const xfer = v.transfer.ok ? (v.transfer.settled ? `xfer OK (${v.transfer.perpAvailable} ${opts.collateral})` : `xfer pending (${v.transfer.perpAvailable})`) : `xfer ERR(${v.transfer.error})`;
  return ` | faucet ${fOk}/${v.faucet.length}, ${xfer}, orders ${v.ordersAccepted}/${v.ordersPlaced} @${v.refSource}`;
}

function printVolumeSummary(results) {
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

const opts = parseArgs(process.argv);
runEnrollment(opts, {
  mode: 'perp', filePrefix: 'enrollments-perp', jwtPrefix: 'wallet-jwts-perp',
  printConfig, runVolume: runVolumeForAccount, volumeLine, printVolumeSummary,
}).catch((err) => { console.error('Fatal:', err); process.exit(1); });
