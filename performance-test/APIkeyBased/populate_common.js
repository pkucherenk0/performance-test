// Shared plumbing for the orderbook-populate scripts (API-key HMAC auth).
//
// Used by:
//   spot_orderbook_populate.js   — spot only
//   perp_orderbook_populate.js   — perp only
//   orderbook_populate.js        — both, by composing the two scripts above
//
// Metrics are registered here ONCE so the "all" script can import both venue
// scripts without k6 complaining about a metric being defined twice.

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import crypto from 'k6/crypto';
import { config, users } from './config.js';

export const BASE_URL = config.baseUrl;

// --- Shared run knobs (env-driven) ---
export const ACTIVE_USERS = parseInt(__ENV.ACTIVE_USERS || '1', 10); // how many users.json entries to use
export const SPAM_DELAY_MS = parseInt(__ENV.SPAM_DELAY_MS || '10', 10);
export const SIDE = (__ENV.SIDE || 'alt').toLowerCase();             // buy | sell | alt

// --- Shared metrics ---
export const ordersPlaced = new Counter('orders_placed');
export const orderErrors = new Counter('order_errors');
export const orderLatency = new Trend('order_latency_ms');

// k6 options derived from env (VUS / DURATION, or use --vus/--duration).
export const options = {
  vus: parseInt(__ENV.VUS || '1', 10),
  duration: __ENV.DURATION || '60s',
};

export function log(msg, type = 'INFO') {
  const time = new Date().toISOString().split('T')[1].replace('Z', '');
  const icons = { INFO: 'ℹ️', SUCCESS: '✅', WARN: '⚠️', ERROR: '❌', SEND: '📤' };
  console.log(`${icons[type] || ''} [${time}] VU${__VU}: ${msg}`);
}

// HMAC auth: prehash = METHOD + path + timestamp + canonical(sorted body fields).
export function getAuthHeaders(apiKey, apiSecret, method, url, bodyObject = {}) {
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

// Pick the user for this VU from the first ACTIVE_USERS entries (round-robin).
export function pickUser() {
  const activeCount = Math.min(ACTIVE_USERS, users.length);
  const user = users[(__VU - 1) % activeCount];
  if (!user) log('No user found in users.json', 'ERROR');
  return user;
}

// Decide buy/sell for this iteration: honor SIDE, else alternate per iteration.
export function chooseSide() {
  return SIDE === 'buy' ? true : SIDE === 'sell' ? false : (__ITER % 2 === 0);
}

// Sign, POST, record metrics and log. Returns true on HTTP 200.
export function submitOrder(venue, venuePath, user, payload, label) {
  const url = `${BASE_URL}${venuePath}`;
  const headers = getAuthHeaders(user.apiKey, user.apiSecret, 'POST', url, payload);

  const start = Date.now();
  const res = http.post(url, JSON.stringify(payload), { headers });
  orderLatency.add(Date.now() - start, { venue });

  const ok = check(res, { [`${venue} order 200`]: r => r.status === 200 }, { venue });
  if (ok) {
    ordersPlaced.add(1, { venue });
    log(`${venue.toUpperCase()} ${label} @ ${payload.price} → OK`, 'SEND');
  } else {
    orderErrors.add(1, { venue });
    log(`${venue.toUpperCase()} ${label} @ ${payload.price} FAILED | ${res.status} | ${res.body}`, 'ERROR');
  }
  return ok;
}

// Resting limit price: buys below center (won't cross asks), sells above (won't cross bids).
export function restingPrice(isBuy, center, range, decimals) {
  const offset = Math.floor(Math.random() * range) + 1;
  return (isBuy ? center - offset : center + offset).toFixed(decimals);
}
