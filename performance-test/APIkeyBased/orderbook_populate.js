// Orderbook populate — SPOT and/or PERP — for pagination / depth testing.
//
// Modeled on perp_orderbook_populate.js: API-key HMAC auth from users.json,
// each VU iteration places a resting LIMIT order (gtc) alternating buy/sell
// around a center price so the orders rest on the book instead of filling.
//
//   spot -> POST /spot/order
//   perp -> POST /perpetual/order
//
// Credentials: users.<env>.json (same dir, git-ignored):
//   [{ apiKey, apiSecret, sessionId, userAddress }]
//
// --- HOW TO RUN -------------------------------------------------------------
//   cd performance-test/APIkeyBased
//
//   # both venues, 60s default, UAT (default env)
//   k6 run orderbook_populate.js
//
//   # against stage
//   k6 run -e ENV=stage orderbook_populate.js
//
//   # spot only / perp only
//   k6 run -e VENUE=spot orderbook_populate.js
//   k6 run -e VENUE=perp orderbook_populate.js
//
//   # exactly 100 orders on one venue (1 order per iteration)
//   k6 run --vus 1 --iterations 100 -e VENUE=spot orderbook_populate.js
//
//   # heavier depth: 4 users spamming for 2 min on stage
//   k6 run -e ENV=stage --vus 4 --duration 120s -e ACTIVE_USERS=4 -e VENUE=both orderbook_populate.js
//
//   # tune to live mark so orders don't cross/fill
//   k6 run -e SPOT_CENTER=1679 -e PERP_CENTER=1679 orderbook_populate.js
//
// Env knobs (all optional):
//   ENV=uat|stage (def uat)           VENUE=spot|perp|both (def both)
//   ACTIVE_USERS=1   SPAM_DELAY_MS=10  VUS / DURATION (or use --vus/--duration)
//   BASE_URL SPOT_MARKET PERP_MARKET  (default from config.js for the env)
//   SPOT_CENTER SPOT_RANGE SPOT_AMOUNT SPOT_DECIMALS
//   PERP_CENTER PERP_RANGE PERP_AMOUNT PERP_DECIMALS LEVERAGE MARGIN_MODE
//   SIDE=buy|sell|alt (def alt — alternate per iteration)
// ---------------------------------------------------------------------------

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import crypto from 'k6/crypto';
import { config, users } from './config.js';

// --- CONFIGURATION (env-driven; see config.js) ---
const BASE_URL = config.baseUrl;
const VENUE = (__ENV.VENUE || 'both').toLowerCase();        // spot | perp | both
const SIDE = (__ENV.SIDE || 'alt').toLowerCase();           // buy | sell | alt
const ACTIVE_USERS = parseInt(__ENV.ACTIVE_USERS || '1', 10);
const SPAM_DELAY_MS = parseInt(__ENV.SPAM_DELAY_MS || '10', 10);

// Spot defaults: ETHUSDT
const SPOT_MARKET = config.spotMarket;
const SPOT_CENTER = parseFloat(__ENV.SPOT_CENTER || '1679');
const SPOT_RANGE = parseInt(__ENV.SPOT_RANGE || '100', 10); // integer ticks off center
const SPOT_AMOUNT = __ENV.SPOT_AMOUNT || '0.01';
const SPOT_DECIMALS = parseInt(__ENV.SPOT_DECIMALS || '2', 10);

// Perp defaults: ETHUSDT-PERP
const PERP_MARKET = config.perpMarket;
const PERP_CENTER = parseFloat(__ENV.PERP_CENTER || '1679');
const PERP_RANGE = parseInt(__ENV.PERP_RANGE || '100', 10);
const PERP_AMOUNT = __ENV.PERP_AMOUNT || '0.01';
const PERP_DECIMALS = parseInt(__ENV.PERP_DECIMALS || '2', 10);
const LEVERAGE = __ENV.LEVERAGE || '10';
const MARGIN_MODE = __ENV.MARGIN_MODE || 'cross';

// --- METRICS ---
const ordersPlaced = new Counter('orders_placed');
const orderErrors = new Counter('order_errors');
const orderLatency = new Trend('order_latency_ms');

function log(msg, type = 'INFO') {
  const time = new Date().toISOString().split('T')[1].replace('Z', '');
  const icons = { INFO: 'ℹ️', SUCCESS: '✅', WARN: '⚠️', ERROR: '❌', SEND: '📤' };
  console.log(`${icons[type] || ''} [${time}] VU${__VU}: ${msg}`);
}

// HMAC auth — identical scheme to perp_orderbook_populate.js
function getAuthHeaders(apiKey, apiSecret, method, url, bodyObject = {}) {
  if (!apiKey || !apiSecret) throw new Error('Missing API Key/Secret');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  let path = url.replace(/^(?:https?:\/\/|wss?:\/\/)[^\/]+/, '');
  if (!path.startsWith('/')) path = '/' + path;
  const methodUpper = method.toUpperCase();
  let canonicalFieldString = '';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(methodUpper)) {
    try {
      const sortedKeys = Object.keys(bodyObject).sort();
      canonicalFieldString = sortedKeys.map(key => `${key}=${bodyObject[key]}`).join('|');
    } catch (e) {}
  }
  const prehash = methodUpper + path + timestamp + canonicalFieldString;
  const signature = crypto.hmac('sha256', apiSecret, prehash, 'hex');
  return {
    'Content-Type': 'application/json',
    'X-API-KEY': apiKey,
    'X-TIMESTAMP': timestamp,
    'X-SIGNATURE': signature,
  };
}

export const options = {
  vus: parseInt(__ENV.VUS || '1', 10),
  duration: __ENV.DURATION || '60s',
};

// Place one resting limit order on a venue. Returns true on HTTP 200.
function placeOrder(venue, user, isBuy) {
  const side = isBuy ? 'buy' : 'sell';
  const isSpot = venue === 'spot';

  const center = isSpot ? SPOT_CENTER : PERP_CENTER;
  const range = isSpot ? SPOT_RANGE : PERP_RANGE;
  const decimals = isSpot ? SPOT_DECIMALS : PERP_DECIMALS;
  const amount = isSpot ? SPOT_AMOUNT : PERP_AMOUNT;
  const market = isSpot ? SPOT_MARKET : PERP_MARKET;
  const venuePath = isSpot ? '/spot/order' : '/perpetual/order';

  // Buys: center-1 .. center-range (below center, never cross asks)
  // Sells: center+1 .. center+range (above center, never cross bids)
  const offset = Math.floor(Math.random() * range) + 1;
  const price = (isBuy ? center - offset : center + offset).toFixed(decimals);

  let payload;
  if (isSpot) {
    payload = {
      app_session_id: user.sessionId,
      market,
      side,
      amount,
      price,
      type: 'limit',
      time_in_force: 'gtc',
    };
  } else {
    payload = {
      app_session_id: user.sessionId,
      market,
      margin_mode: MARGIN_MODE,
      side,
      direction: isBuy ? 'long' : 'short',
      leverage: LEVERAGE,
      amount,
      price,
      type: 'limit',
      time_in_force: 'gtc',
    };
  }

  const url = `${BASE_URL}${venuePath}`;
  const headers = getAuthHeaders(user.apiKey, user.apiSecret, 'POST', url, payload);

  const start = Date.now();
  const res = http.post(url, JSON.stringify(payload), { headers });
  orderLatency.add(Date.now() - start, { venue });

  const ok = check(res, { [`${venue} order 200`]: r => r.status === 200 }, { venue });
  if (ok) {
    ordersPlaced.add(1, { venue });
    log(`${venue.toUpperCase()} ${side.toUpperCase()} @ ${price} → OK`, 'SEND');
  } else {
    orderErrors.add(1, { venue });
    log(`${venue.toUpperCase()} ${side.toUpperCase()} @ ${price} FAILED | ${res.status} | ${res.body}`, 'ERROR');
  }
  return ok;
}

export default function () {
  const activeCount = Math.min(ACTIVE_USERS, users.length);
  const user = users[(__VU - 1) % activeCount];
  if (!user) { log('No user found in users.json', 'ERROR'); return; }

  // alt → flip each iteration; otherwise honor SIDE
  const isBuy = SIDE === 'buy' ? true : SIDE === 'sell' ? false : (__ITER % 2 === 0);

  if (VENUE === 'spot' || VENUE === 'both') placeOrder('spot', user, isBuy);
  if (VENUE === 'perp' || VENUE === 'both') placeOrder('perp', user, isBuy);

  sleep(SPAM_DELAY_MS / 1000);
}
