// Orderbook populate — PERP only — for pagination / depth testing.
//
// Each VU iteration places one resting LIMIT order (gtc) on POST /perpetual/order,
// priced around PERP_CENTER so it rests on the book instead of filling.
//
// Exports populatePerp(user, isBuy) so orderbook_populate.js can reuse it.
//
// Credentials: users.<env>.json (same dir, git-ignored):
//   [{ apiKey, apiSecret, sessionId, userAddress }]
//
// --- HOW TO RUN -------------------------------------------------------------
//   cd performance-test/APIkeyBased
//
//   k6 run perp_orderbook_populate.js                       # 60s, UAT (default)
//   k6 run -e ENV=stage perp_orderbook_populate.js          # against stage
//   k6 run --vus 1 --iterations 100 perp_orderbook_populate.js   # exactly 100 orders
//   k6 run -e PERP_CENTER=1679 perp_orderbook_populate.js   # tune to live mark
//
// Env knobs (all optional):
//   ENV=uat|stage   ACTIVE_USERS=1   SPAM_DELAY_MS=10   VUS / DURATION
//   SIDE=buy|sell|alt (def alt)   BASE_URL PERP_MARKET (from config.js)
//   PERP_CENTER PERP_RANGE PERP_AMOUNT PERP_DECIMALS LEVERAGE MARGIN_MODE
// ---------------------------------------------------------------------------

import { sleep } from 'k6';
import { config } from './config.js';
import {
  SPAM_DELAY_MS, options as commonOptions,
  pickUser, chooseSide, submitOrder, restingPrice,
} from './populate_common.js';

// Re-export so `k6 run perp_orderbook_populate.js` honors VUS/DURATION env.
export const options = commonOptions;

// --- PERP config (env-driven) ---
const PERP_MARKET = config.perpMarket;
const PERP_CENTER = parseFloat(__ENV.PERP_CENTER || '1679');
const PERP_RANGE = parseInt(__ENV.PERP_RANGE || '100', 10); // integer ticks off center
const PERP_AMOUNT = __ENV.PERP_AMOUNT || '0.01';
const PERP_DECIMALS = parseInt(__ENV.PERP_DECIMALS || '2', 10);
const LEVERAGE = __ENV.LEVERAGE || '10';
const MARGIN_MODE = __ENV.MARGIN_MODE || 'cross';

// Place one resting perp limit order. Reused by the "all" script.
export function populatePerp(user, isBuy) {
  const side = isBuy ? 'buy' : 'sell';
  const direction = isBuy ? 'long' : 'short';
  const payload = {
    app_session_id: user.sessionId,
    market: PERP_MARKET,
    margin_mode: MARGIN_MODE,
    side,
    direction,
    leverage: LEVERAGE,
    amount: PERP_AMOUNT,
    price: restingPrice(isBuy, PERP_CENTER, PERP_RANGE, PERP_DECIMALS),
    type: 'limit',
    time_in_force: 'gtc',
  };
  return submitOrder('perp', '/perpetual/order', user, payload, `${side.toUpperCase()} ${direction}`);
}

export default function () {
  const user = pickUser();
  if (!user) return;
  populatePerp(user, chooseSide());
  sleep(SPAM_DELAY_MS / 1000);
}
