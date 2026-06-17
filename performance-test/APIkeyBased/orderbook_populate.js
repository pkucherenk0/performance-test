// Orderbook populate — SPOT + PERP together — for pagination / depth testing.
//
// This is the "all" script: it does NOT reimplement order placement. It imports
// the per-venue workers from the two standalone scripts and runs both each
// iteration:
//   populateSpot  <- spot_orderbook_populate.js
//   populatePerp  <- perp_orderbook_populate.js
//
// For a single venue, run those scripts directly instead:
//   k6 run spot_orderbook_populate.js
//   k6 run perp_orderbook_populate.js
//
// Credentials: users.<env>.json (same dir, git-ignored):
//   [{ apiKey, apiSecret, sessionId, userAddress }]
//
// --- HOW TO RUN -------------------------------------------------------------
//   cd performance-test/APIkeyBased
//
//   k6 run orderbook_populate.js                            # both venues, 60s, UAT
//   k6 run -e ENV=stage orderbook_populate.js               # against stage
//   k6 run --vus 1 --iterations 100 orderbook_populate.js   # 100 iters => 100 spot + 100 perp
//   k6 run -e SPOT_CENTER=1679 -e PERP_CENTER=1679 orderbook_populate.js   # tune to live mark
//
// Env knobs — the union of both venue scripts (all optional):
//   ENV=uat|stage   ACTIVE_USERS=1   SPAM_DELAY_MS=10   VUS / DURATION
//   SIDE=buy|sell|alt (def alt)
//   SPOT_CENTER SPOT_RANGE SPOT_AMOUNT SPOT_DECIMALS
//   PERP_CENTER PERP_RANGE PERP_AMOUNT PERP_DECIMALS LEVERAGE MARGIN_MODE
// ---------------------------------------------------------------------------

import { sleep } from 'k6';
import {
  SPAM_DELAY_MS, options as commonOptions, pickUser, chooseSide,
} from './populate_common.js';
import { populateSpot } from './spot_orderbook_populate.js';
import { populatePerp } from './perp_orderbook_populate.js';

export const options = commonOptions;

export default function () {
  const user = pickUser();
  if (!user) return;

  // Same buy/sell decision applied to both venues this iteration.
  const isBuy = chooseSide();
  populateSpot(user, isBuy);
  populatePerp(user, isBuy);

  sleep(SPAM_DELAY_MS / 1000);
}
