/**
 * balance_trade_test.js
 *
 * Two-user trade scenario across 25 price levels with predictable end-balances.
 *
 * Market:  config.spotMarket (default ETHUSDT — see config.js)
 * Users:   users[0] = MAKER (sells base)  |  users[1] = TAKER (buys base)
 *
 * Environment is selected with -e ENV=uat|stage (default uat). All endpoints,
 * the market symbol and the base/quote asset symbols come from config.js.
 *
 * Each VU runs exactly once (per-vu-iterations, 1 iteration).
 *
 * Flow:
 *   1. Fetch initial balance via REST.
 *   2. Open authenticated WS.
 *   3. On auth OK → place all 25 limit orders in ONE http.batch() call.
 *      (Taker sleeps 4 s — enough for the maker batch to land in the book.)
 *   4. Listen for order.updated / state=done events for every order UUID.
 *   5. When all fills received → close WS.
 *   6. Fetch final balance via REST and assert delta against expected values.
 *
 * ── Order book layout (25 levels, 5 groups, ETHUSDT-priced) ───────────────
 *
 *   Group 1  step ≈  $10   fine-grained   small amounts   1700 – 1740
 *   Group 2  step ≈  $25   medium step    med amounts     1765 – 1865
 *   Group 3  step ≈  $50   coarse step    large amounts   1915 – 2115
 *   Group 4  step ≈ $100   wide step      med amounts     2215 – 2615
 *   Group 5  step ≈ $500   very wide      small amounts   3115 – 5115
 *
 * The whole ladder sits ABOVE the current ETH mid (~1679) so the maker's
 * limit sells REST on the book instead of crossing the live bid. If the mid
 * moves above ~1700, shift the ladder up so the lowest sell stays above it.
 *
 * Amounts are multiples of 0.001 (lot-safe for ETH). The expected balance
 * deltas are DERIVED from the ladder at runtime (see EXPECTED below), so
 * editing ORDERS keeps the math correct automatically.
 *
 * ── Fee model: fee taken from the asset the user RECEIVES ─────────────────
 *   Maker (SELLS base → receives quote) → fee in quote:
 *     quote in = Σ(amount_i × price_i) × (1 − MAKER_FEE_RATE)
 *
 *   Taker (BUYS base → receives base) → fee in base:
 *     base in  = Σ(amount_i) × (1 − TAKER_FEE_RATE)
 *     quote out = Σ(amount_i × price_i)
 *
 *   ⚠ MAKER_FEE_RATE / TAKER_FEE_RATE below MUST match the live market's fee
 *     config, or the balance-delta assertions will fail. Override per-env:
 *     -e MAKER_FEE_RATE=0.002 -e TAKER_FEE_RATE=0.003
 * ─────────────────────────────────────────────────────────────────────────
 */

import ws   from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { config, users } from './config.js';

// ═══════════════════════════════════════════════════════════
// CONFIGURATION (env-driven; see config.js)
// ═══════════════════════════════════════════════════════════

const BASE_URL    = config.baseUrl;
const WS_URL      = config.wsUrl;
const MARKET      = config.spotMarket;
const BASE_ASSET  = config.baseAsset;   // e.g. BTC
const QUOTE_ASSET = config.quoteAsset;  // e.g. USDT

// Fee rates — MUST match the live market config (override via -e).
const MAKER_FEE_RATE = parseFloat(__ENV.MAKER_FEE_RATE || '0.001');   // 0.1%
const TAKER_FEE_RATE = parseFloat(__ENV.TAKER_FEE_RATE || '0.003');   // 0.3%

// Max time to wait for all fills before timing out
const WS_TIMEOUT_MS = 40000;

// ═══════════════════════════════════════════════════════════
// ORDER LEVELS  –  25 price levels across 5 groups (ETHUSDT)
//
//   sell  – maker's limit sell price  (fill price for balance calcs)
//   buy   – taker's limit buy price   (sell ≤ buy < next sell → unique match)
//   amount – base asset quantity (multiple of 0.0001)
// ═══════════════════════════════════════════════════════════

const ORDERS = [
  // ── Group 1: sell step ≈ $10 │ buy = sell + 5 ──────────────────────────
  { sell: '1700.0', buy: '1705.0', amount: '0.010' },
  { sell: '1710.0', buy: '1715.0', amount: '0.020' },
  { sell: '1720.0', buy: '1725.0', amount: '0.050' },
  { sell: '1730.0', buy: '1735.0', amount: '0.030' },
  { sell: '1740.0', buy: '1745.0', amount: '0.015' },

  // ── Group 2: sell step ≈ $25 │ buy = sell + 12 ─────────────────────────
  { sell: '1765.0', buy: '1777.0', amount: '0.100' },
  { sell: '1790.0', buy: '1802.0', amount: '0.080' },
  { sell: '1815.0', buy: '1827.0', amount: '0.200' },
  { sell: '1840.0', buy: '1852.0', amount: '0.150' },
  { sell: '1865.0', buy: '1877.0', amount: '0.120' },

  // ── Group 3: sell step ≈ $50 │ buy = sell + 25 ─────────────────────────
  { sell: '1915.0', buy: '1940.0', amount: '0.300' },
  { sell: '1965.0', buy: '1990.0', amount: '0.250' },
  { sell: '2015.0', buy: '2040.0', amount: '0.400' },
  { sell: '2065.0', buy: '2090.0', amount: '0.350' },
  { sell: '2115.0', buy: '2140.0', amount: '0.500' },

  // ── Group 4: sell step ≈ $100 │ buy = sell + 50 ────────────────────────
  { sell: '2215.0', buy: '2265.0', amount: '0.200' },
  { sell: '2315.0', buy: '2365.0', amount: '0.180' },
  { sell: '2415.0', buy: '2465.0', amount: '0.160' },
  { sell: '2515.0', buy: '2565.0', amount: '0.140' },
  { sell: '2615.0', buy: '2665.0', amount: '0.120' },

  // ── Group 5: sell step ≈ $500 │ buy = sell + 250 ───────────────────────
  { sell: '3115.0', buy: '3365.0', amount: '0.050' },
  { sell: '3615.0', buy: '3865.0', amount: '0.040' },
  { sell: '4115.0', buy: '4365.0', amount: '0.030' },
  { sell: '4615.0', buy: '4865.0', amount: '0.020' },
  { sell: '5115.0', buy: '5365.0', amount: '0.010' },
];

// ── Expected balance deltas (derived from ORDERS at runtime) ──────────────
const totalBase  = ORDERS.reduce((s, o) => s + parseFloat(o.amount), 0);
const totalQuote = ORDERS.reduce((s, o) => s + parseFloat(o.amount) * parseFloat(o.sell), 0);

const EXPECTED = {
  maker: {
    base:  -totalBase,                            // base sold
    quote: +(totalQuote * (1 - MAKER_FEE_RATE)),  // quote received, less maker fee
  },
  taker: {
    base:  +(totalBase * (1 - TAKER_FEE_RATE)),   // base received, less taker fee
    quote: -totalQuote,                           // quote spent
  },
};

// Tolerance for floating-point balance comparison
const BALANCE_TOLERANCE = 0.000001;

// ═══════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════

const fillLatencyMs = new Trend('fill_latency_ms');
const ordersPlaced  = new Counter('orders_placed');
const ordersFilled  = new Counter('orders_filled');

// ═══════════════════════════════════════════════════════════
// OPTIONS  –  2 VUs, 1 iteration each
// ═══════════════════════════════════════════════════════════

export const options = {
  scenarios: {
    trade_balance_test: {
      executor:   'per-vu-iterations',
      vus:        2,
      iterations: 1,
    }
  }
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function authHeaders(jwt) {
  return {
    'Authorization': `Bearer ${jwt}`,
    'Content-Type': 'application/json',
  };
}

/**
 * GET /spot/accounts → { base: float|null, quote: float|null }
 * Picks the account matching sessionId and reads available_balance.
 */
function fetchBalances(jwt, sessionId) {
  const res = http.get(`${BASE_URL}/spot/accounts`, { headers: authHeaders(jwt) });
  if (res.status !== 200) {
    console.error(`[fetchBalances] HTTP ${res.status}: ${res.body}`);
    return { base: null, quote: null };
  }
  try {
    const accounts = res.json();
    if (!Array.isArray(accounts) || accounts.length === 0) {
      console.error('[fetchBalances] Unexpected response shape:', res.body.slice(0, 300));
      return { base: null, quote: null };
    }
    const account  = accounts.find(a => a.app_session_id === sessionId) || accounts[0];
    const balances = account.balances || [];
    const find = (sym) => {
      const b = balances.find(x => x.asset_symbol === sym);
      return b ? parseFloat(b.available_balance) : null;
    };
    return { base: find(BASE_ASSET), quote: find(QUOTE_ASSET) };
  } catch (e) {
    console.error('[fetchBalances] Parse error:', String(e));
    return { base: null, quote: null };
  }
}

/**
 * Place all ORDERS in a single http.batch() call (concurrent HTTP requests).
 * Returns an array of { uuid, price, amount } for successfully placed orders.
 */
function placeOrdersBatch(jwt, sessionId, side) {
  const requests = ORDERS.map(({ sell, amount }) => ({
    method: 'POST',
    url:    `${BASE_URL}/spot/order`,
    body:   JSON.stringify({
      app_session_id: sessionId,
      market:         MARKET,
      side,
      amount,
      price:          sell,
      type:           'limit',
      time_in_force:  'gtc',
    }),
    params: { headers: authHeaders(jwt) },
  }));

  const responses = http.batch(requests);

  return responses.map((res, i) => {
    const { sell, amount } = ORDERS[i];
    if (res.status === 200) {
      try {
        return { uuid: res.json('order_uuid'), price: sell, amount };
      } catch (_) {}
    }
    console.error(`[batch] Order ${i + 1} FAILED  sell=${sell}  HTTP ${res.status}: ${res.body}`);
    return null;
  }).filter(o => o !== null);
}

/** Cancel an order — best-effort cleanup on timeout. */
function cancelOrder(jwt, sessionId, uuid) {
  const body = JSON.stringify({ app_session_id: sessionId, market: MARKET, order_uuid: uuid });
  http.del(`${BASE_URL}/spot/order`, body, { headers: authHeaders(jwt) });
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

export default function () {
  // Roles: VU 1 → users[0] = MAKER (sell)  |  VU 2 → users[1] = TAKER (buy)
  const userIdx = (__VU - 1) % 2;
  const user    = users[userIdx];
  const JWT     = user.jwt;
  const SID     = user.sessionId;

  const isMaker = userIdx === 0;
  const role    = isMaker ? 'MAKER' : 'TAKER';
  const side    = isMaker ? 'sell'  : 'buy';
  const exp     = isMaker ? EXPECTED.maker : EXPECTED.taker;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  VU ${__VU}  │  ${role}  │  ${config.env.toUpperCase()}  │  ${MARKET}  │  side=${side}  │  ${ORDERS.length} orders`);
  console.log(`  total${BASE_ASSET}=${totalBase.toFixed(8)}  total${QUOTE_ASSET}=${totalQuote.toFixed(8)}`);
  console.log(`  Expected ${BASE_ASSET} Δ: ${exp.base.toFixed(8)}`);
  console.log(`  Expected ${QUOTE_ASSET} Δ: ${exp.quote.toFixed(8)}`);
  console.log(`${'─'.repeat(70)}`);

  // ── 1. Snapshot initial balances ────────────────────────
  const initial = fetchBalances(JWT, SID);
  console.log(`[${role}] Initial:  ${BASE_ASSET}=${initial.base}  ${QUOTE_ASSET}=${initial.quote}`);

  // Maker uses http.batch() → all 25 orders sent concurrently (~1s total).
  // 4s gives the maker time to batch-place and the exchange time to process.
  if (!isMaker) sleep(4);

  // ── 2. Open WS, place all 25 orders, await fill events ──
  const pendingOrders = {};   // { uuid: placementTimestamp }
  let   filledCount   = 0;
  let   timedOut      = false;
  const numOrders     = ORDERS.length;

  const wsRes = ws.connect(WS_URL, {}, function (socket) {
    let ordersSent = false;

    function onAllFilled() {
      console.log(`[${role}] All ${numOrders} fills received — closing WS`);
      socket.close();
    }

    socket.on('open', function () {
      socket.send(JSON.stringify({ connect: { token: JWT, name: 'js' }, id: 1 }));
    });

    socket.on('message', function (raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }

      // ── Auth confirmed → place orders ────────────────────
      if (msg.id === 1 && msg.connect && !ordersSent) {
        ordersSent = true;

        if (isMaker) {
          // MAKER: batch — all 25 sells hit the book in one round-trip.
          // No matching risk: nothing to match against yet.
          console.log(`[${role}] Auth OK — batch-placing ${numOrders} SELL orders…`);
          const t0 = Date.now();
          const placed = placeOrdersBatch(JWT, SID, 'sell');
          console.log(`[${role}] Batch done in ${Date.now() - t0}ms — ${placed.length}/${numOrders} accepted`);
          placed.forEach(({ uuid, price, amount }) => {
            pendingOrders[uuid] = Date.now();
            ordersPlaced.add(1);
            console.log(`[${role}] Placed  price=${price}  amount=${amount}  uuid=${uuid}`);
          });

        } else {
          // TAKER: sequential — each HTTP call completes before the next is sent.
          // Guarantees FIFO processing by the matching engine:
          //   buy@1700 → matches sell@1700 (cheapest)
          //   buy@1710 → matches sell@1710 (now cheapest)  … etc.
          // Concurrent batch would let the engine pick fills in arbitrary order,
          // causing cross-price matches and leaving orders unmatched.
          console.log(`[${role}] Auth OK — placing ${numOrders} BUY orders sequentially…`);
          for (let i = 0; i < ORDERS.length; i++) {
            const { buy, amount } = ORDERS[i];
            const body = JSON.stringify({
              app_session_id: SID, market: MARKET, side: 'buy',
              amount, price: buy, type: 'limit', time_in_force: 'gtc',
            });
            const res = http.post(`${BASE_URL}/spot/order`, body, { headers: authHeaders(JWT) });
            if (res.status === 200) {
              try {
                const uuid = res.json('order_uuid');
                pendingOrders[uuid] = Date.now();
                ordersPlaced.add(1);
                console.log(`[${role}] Order ${i + 1}/${numOrders}  buy=${buy}  amount=${amount}  uuid=${uuid}`);
              } catch (_) {
                console.error(`[${role}] Order ${i + 1} JSON parse error: ${res.body}`);
              }
            } else {
              console.error(`[${role}] Order ${i + 1} FAILED  buy=${buy}  HTTP ${res.status}: ${res.body}`);
            }
          }
        }

        if (Object.keys(pendingOrders).length === 0) {
          console.error(`[${role}] No orders placed — aborting`);
          socket.close();
        }
      }

      // ── Private push: order fill event ───────────────────
      if (msg.push && msg.push.pub && msg.push.pub.data) {
        const data = msg.push.pub.data;
        const type = data.header && data.header.type;

        if (type === 'order.updated') {
          const uuid  = data.order_id || data.uuid;
          const state = data.state;
          if (uuid && pendingOrders[uuid] !== undefined &&
              (state === 'done' || state === 'filled')) {
            const latency = Date.now() - pendingOrders[uuid];
            fillLatencyMs.add(latency);
            ordersFilled.add(1);
            filledCount++;
            delete pendingOrders[uuid];
            console.log(`[${role}] Fill ${filledCount}/${numOrders}  uuid=${uuid}  latency=${latency}ms`);
            if (filledCount >= numOrders) onAllFilled();
          }
        }
      }
    });

    socket.on('error', function (e) {
      console.error(`[${role}] WS error: ${e.error()}`);
    });

    socket.on('close', function () {
      console.log(`[${role}] WS closed`);
    });

    // Safety net: cancel any unfilled orders that linger after timeout
    socket.setTimeout(function () {
      const remaining = Object.keys(pendingOrders);
      if (remaining.length > 0) {
        timedOut = true;
        console.warn(`[${role}] Timeout — ${remaining.length} order(s) still pending. Cancelling…`);
        remaining.forEach(uuid => {
          console.warn(`[${role}] Cancelling ${uuid}`);
          cancelOrder(JWT, SID, uuid);
        });
      }
      socket.close();
    }, WS_TIMEOUT_MS);
  });

  // ── 3. Fetch final balances and assert deltas ────────────
  const final = fetchBalances(JWT, SID);
  console.log(`[${role}] Final:    ${BASE_ASSET}=${final.base}  ${QUOTE_ASSET}=${final.quote}`);

  const baseDelta = (initial.base !== null && final.base !== null)
    ? final.base - initial.base : null;
  const quoteDelta = (initial.quote !== null && final.quote !== null)
    ? final.quote - initial.quote : null;

  console.log(`[${role}] ${BASE_ASSET} Δ  →  actual=${baseDelta !== null ? baseDelta.toFixed(8) : 'n/a'}  expected=${exp.base.toFixed(8)}`);
  console.log(`[${role}] ${QUOTE_ASSET} Δ  →  actual=${quoteDelta !== null ? quoteDelta.toFixed(8) : 'n/a'}  expected=${exp.quote.toFixed(8)}`);

  const near = (actual, expected) =>
    actual !== null && expected !== null && Math.abs(actual - expected) < BALANCE_TOLERANCE;

  check(wsRes, {
    'WS handshake (101)': (r) => r && r.status === 101,
  });

  check(null, {
    [`[${role}] all ${numOrders} orders filled`]:    () => filledCount === numOrders,
    [`[${role}] no timeout`]:                        () => !timedOut,
    [`[${role}] ${BASE_ASSET} balance delta correct`]:  () => near(baseDelta, exp.base),
    [`[${role}] ${QUOTE_ASSET} balance delta correct`]: () => near(quoteDelta, exp.quote),
  });
}
