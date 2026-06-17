import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import crypto from 'k6/crypto';
import { config, users } from './config.js';

// --- CONFIGURATION (env-driven; see config.js) ---
const BASE_URL = config.baseUrl;
const MARKET = config.perpMarket;
const SPAM_DELAY_MS = 10;

// Number of users to use from users.json (1 = only the first user, 2 = first two, etc.)
// Override via env: k6 run -e ACTIVE_USERS=3 perp_orderbook_populate.js
const ACTIVE_USERS = parseInt(__ENV.ACTIVE_USERS || '1', 10);

// --- PRICING CONFIG ---
const CENTER_PRICE = 1679;
const PRICE_RANGE = 100; // buys: CENTER-1 to CENTER-RANGE, sells: CENTER+1 to CENTER+RANGE

// --- METRICS ---
const ordersPlaced = new Counter('orders_placed');
const orderErrors = new Counter('order_errors');
const orderLatency = new Trend('order_latency_ms');

function log(msg, type = 'INFO') {
  const time = new Date().toISOString().split('T')[1].replace('Z', '');
  const icons = { INFO: 'ℹ️', SUCCESS: '✅', WARN: '⚠️', ERROR: '❌', SEND: '📤' };
  console.log(`${icons[type] || ''} [${time}] VU${__VU}: ${msg}`);
}

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
  vus: 1,
  duration: '60s',
};

export default function () {
  // Use only the first ACTIVE_USERS entries; distribute VUs round-robin across that slice
  const activeCount = Math.min(ACTIVE_USERS, users.length);
  const userIndex = (__VU - 1) % activeCount;
  const currentUser = users[userIndex];

  if (!currentUser) {
    log('No user found in users.json', 'ERROR');
    return;
  }

  const { apiKey: API_KEY, apiSecret: API_SECRET, sessionId: APP_SESSION_ID } = currentUser;

  // Alternate buy and sell within each VU iteration
  // Odd iterations → buy below center, Even iterations → sell above center
  const isBuy = __ITER % 2 === 0;
  const side = isBuy ? 'buy' : 'sell';
  const direction = isBuy ? 'long' : 'short';

  // Buys: center-RANGE to center-1 (all below center, won't cross asks)
  // Sells: center+1 to center+RANGE (all above center, won't cross bids)
  const offset = Math.floor(Math.random() * PRICE_RANGE) + 1;
  const rawPrice = isBuy ? (CENTER_PRICE - offset) : (CENTER_PRICE + offset);
  const price = rawPrice.toFixed(2);

  const payload = {
    app_session_id: APP_SESSION_ID,
    market: MARKET,
    margin_mode: 'cross',
    side: side,
    direction: direction,
    leverage: '10',
    amount: '0.01',
    price: price,
    type: 'limit',
    time_in_force: 'gtc',
  };

  const url = `${BASE_URL}/perpetual/order`;
  const headers = getAuthHeaders(API_KEY, API_SECRET, 'POST', url, payload);

  const start = Date.now();
  const res = http.post(url, JSON.stringify(payload), { headers: headers });
  orderLatency.add(Date.now() - start);

  const ok = check(res, { 'order accepted (200)': r => r.status === 200 });

  if (ok) {
    ordersPlaced.add(1);
    log(`${side.toUpperCase()} ${direction} @ ${price} → OK`, 'SEND');
  } else {
    orderErrors.add(1);
    log(`${side.toUpperCase()} ${direction} @ ${price} FAILED | ${res.status} | ${res.body}`, 'ERROR');
  }

  sleep(SPAM_DELAY_MS / 1000);
}
