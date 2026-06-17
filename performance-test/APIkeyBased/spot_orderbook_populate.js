// Orderbook populate — SPOT only — for pagination / depth testing.
//
// Each VU iteration places one resting LIMIT order (gtc) on POST /spot/order,
// priced around SPOT_CENTER so it rests on the book instead of filling.
//
// Exports populateSpot(user, isBuy) so orderbook_populate.js can reuse it.
//
// Credentials: users.<env>.json (same dir, git-ignored):
//   [{ apiKey, apiSecret, sessionId, userAddress }]
//
// --- HOW TO RUN -------------------------------------------------------------
//   cd performance-test/APIkeyBased
//
//   k6 run spot_orderbook_populate.js                       # 60s, UAT (default)
//   k6 run -e ENV=stage spot_orderbook_populate.js          # against stage
//   k6 run --vus 1 --iterations 100 spot_orderbook_populate.js   # exactly 100 orders
//   k6 run -e SPOT_CENTER=1679 spot_orderbook_populate.js   # tune to live mark
//
// Env knobs (all optional):
//   ENV=uat|stage   ACTIVE_USERS=1   SPAM_DELAY_MS=10   VUS / DURATION
//   SIDE=buy|sell|alt (def alt)   BASE_URL SPOT_MARKET (from config.js)
//   SPOT_CENTER SPOT_RANGE SPOT_AMOUNT SPOT_DECIMALS
// ---------------------------------------------------------------------------

import { sleep } from 'k6';
import { config } from './config.js';
import {
  SPAM_DELAY_MS, options as commonOptions,
  pickUser, chooseSide, submitOrder, restingPrice,
} from './populate_common.js';

// Re-export so `k6 run spot_orderbook_populate.js` honors VUS/DURATION env.
export const options = commonOptions;

// --- SPOT config (env-driven) ---
const SPOT_MARKET = config.spotMarket;
const SPOT_CENTER = parseFloat(__ENV.SPOT_CENTER || '1679');
const SPOT_RANGE = parseInt(__ENV.SPOT_RANGE || '100', 10); // integer ticks off center
const SPOT_AMOUNT = __ENV.SPOT_AMOUNT || '0.01';
const SPOT_DECIMALS = parseInt(__ENV.SPOT_DECIMALS || '2', 10);

// Place one resting spot limit order. Reused by the "all" script.
export function populateSpot(user, isBuy) {
  const side = isBuy ? 'buy' : 'sell';
  const payload = {
    app_session_id: user.sessionId,
    market: SPOT_MARKET,
    side,
    amount: SPOT_AMOUNT,
    price: restingPrice(isBuy, SPOT_CENTER, SPOT_RANGE, SPOT_DECIMALS),
    type: 'limit',
    time_in_force: 'gtc',
  };
  return submitOrder('spot', '/spot/order', user, payload, side.toUpperCase());
}

export default function () {
  const user = pickUser();
  if (!user) return;
  populateSpot(user, chooseSide());
  sleep(SPAM_DELAY_MS / 1000);
}
