// Shared environment + market config for the API-key (HMAC) k6 scripts.
//
// Select the environment with -e ENV=<name> (default: uat):
//   k6 run -e ENV=uat   orderbook_populate.js
//   k6 run -e ENV=stage orderbook_populate.js
//
// Every value can also be overridden directly from the CLI, e.g.:
//   k6 run -e ENV=stage -e BASE_URL=https://... -e SPOT_MARKET=BTCUSDT script.js
//
// Credentials live in users.<env>.json next to this file (git-ignored):
//   users.uat.json   users.stage.json
// Each entry: { apiKey, apiSecret, sessionId, userAddress }

import { SharedArray } from 'k6/data';

const ENV = (__ENV.ENV || __ENV.env || 'uat').toLowerCase();

const ENVIRONMENTS = {
  uat: {
    baseUrl: 'https://api.uat.yellow.pro.neodax.app',
    wsUrl:   'wss://api.uat.yellow.pro.neodax.app/ws',
    authUrl: 'https://auth.uat.yellow.pro.neodax.app',
  },
  stage: {
    baseUrl: 'https://api.staging.yellow.pro.neodax.app',
    wsUrl:   'wss://api.staging.yellow.pro.neodax.app/ws',
    authUrl: 'https://auth.staging.yellow.pro.neodax.app',
  },
};

if (!ENVIRONMENTS[ENV]) {
  throw new Error(`Unknown ENV "${ENV}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}`);
}

const selected = ENVIRONMENTS[ENV];

// Markets are the same on both environments.
export const config = {
  env:        ENV,
  baseUrl:    __ENV.BASE_URL || selected.baseUrl,
  wsUrl:      __ENV.WS_URL   || selected.wsUrl,
  authUrl:    __ENV.AUTH_URL || selected.authUrl,

  spotMarket: __ENV.SPOT_MARKET || 'ETHUSDT',
  perpMarket: __ENV.PERP_MARKET || 'ETHUSDT-PERP',
  baseAsset:  __ENV.BASE_ASSET  || 'ETH',
  quoteAsset: __ENV.QUOTE_ASSET || 'USDT',
};

// Loaded once into shared memory; path resolves relative to this file.
export const users = new SharedArray('users', function () {
  return JSON.parse(open(`./users.${ENV}.json`));
});
