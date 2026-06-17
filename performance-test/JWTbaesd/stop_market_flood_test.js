import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { config, users } from './config.js';

// --- CONFIGURATION (env-driven; see config.js) ---
const BASE_URL = config.baseUrl;
const MARKET = config.spotMarket;

// --- METRICS ---
const orderPlacementTime = new Trend('order_placement_time');
const ordersSucceeded    = new Counter('orders_succeeded');
const ordersFailed       = new Counter('orders_failed');

// --- TEST OPTIONS ---
// Single account, exactly 10 000 stop-market orders
export const options = {
  vus: 1,
  iterations: 2000,
};

export default function () {
  // Always use the first account
  const currentUser  = users[0];
  const JWT_TOKEN    = currentUser.jwt;
  const APP_SESSION  = currentUser.sessionId;

  const payload = JSON.stringify({
    "app_session_id": APP_SESSION,
    "market":         MARKET,
    "side":           "buy",
    "amount":         "100",
    "price":          "0",
    "trigger_price":  "2010",
    "type":           "trigger_market",
    "time_in_force":  "ioc"
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'Content-Type':  'application/json',
    },
    tags: { name: 'PlaceStopMarketOrder' },
  };

  const start = Date.now();
  const res   = http.post(`${BASE_URL}/spot/order`, payload, params);
  orderPlacementTime.add(Date.now() - start);

  const ok = check(res, {
    'status 200':        (r) => r.status === 200,
    'has order_uuid':    (r) => {
      try { return !!r.json('order_uuid'); } catch { return false; }
    },
  });

  if (ok) {
    ordersSucceeded.add(1);
  } else {
    ordersFailed.add(1);
    console.error(`iter ${__ITER} failed — status: ${res.status} body: ${res.body}`);
  }
}
