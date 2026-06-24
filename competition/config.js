'use strict';
// Run configuration: defaults + CLI flag parsing. All knobs are overridable from the command line.

const { applyEnv } = require('./lib/env');

const DEFAULTS = {
  // --- Environment (--env uat|stage) ---
  // uat   = faucet available -> fresh random wallets, auto-funded each run.
  // stage = NO faucet -> pre-funded wallets from users.stage.json, topped up manually.
  // Endpoints below are the uat defaults; applyEnv() swaps them for the chosen env unless overridden.
  env: 'uat',
  base: 'https://hub.uat.yellow.pro.neodax.app',
  authBase: 'https://auth.uat.yellow.pro.neodax.app',
  tradingBase: 'https://api.uat.yellow.pro.neodax.app',
  faucetUrl: 'https://faucet.uat.yellow.pro.neodax.app/api/deposit',
  faucet: true,                     // set by applyEnv from --env (uat: true, stage: false)
  accountSource: 'faucet',          // set by applyEnv ('faucet' | 'users')
  usersFile: null,                  // stage: path to users.<env>.json (defaults to users.<env>.json)
  subjectIndex: 0,                  // which users.json entry is the SUBJECT (stage only)
  makerIndex: 1,                    // which users.json entry is the MAKER (stage only)
  minPerpUsd: 20000,                // stage: required perp collateral per account (no faucet to top up)
  feeTiersUrl: 'https://yellow-neodax-client-uat.openware-account.workers.dev/fee-tiers',
  scheduleKey: 'initialSchedule',   // RSC key holding the tier array; set to the competition key when known
  competition: 'pablo-15',

  market: 'BTCUSDT-PERP',           // resolved against /perpetual/exchangeInfo
  makerEnroll: false,               // maker = the NON-ENROLLED counterparty (trades perp, must get standard fees only)
  collateral: 'USDT',
  faucetUsdt: '2000000',            // SPOT credit per account (huge — UAT faucet; uat only)
  transferUsdt: '1000000',          // moved spot -> perps per account (uat; stage tops up to minPerpUsd)
  leverage: 10,
  terms: true,                      // terms_accepted on enroll

  // best-of(standard, competition). With scheduleKey=initialSchedule the "standard"
  // baseline IS this schedule's tier 0, so best-of is a no-op; override when testing a
  // competition schedule against a separately-known standing VIP rate.
  stdTakerRate: null,               // null => use schedule tier 0 perp_taker
  stdMakerRate: null,

  targetTier: 3,                    // drive volume until this schedule tier is reached (by index in the volume-sorted schedule)
  targetVolume: null,               // explicit USD volume target (overrides targetTier)
  orderNotional: 50000,             // USD notional per chunk order (subject taker fill)
  maxOrders: 2000,                  // safety cap on round-trips
  watchSecs: 100,                   // how long to poll fee-tier-effective for campaign-volume ingestion (>=60 for the 1-min tracker)
  markerFills: 4,                   // phase-2 round-trips AFTER ingestion, to capture fills CHARGED at the deepened tier

  // --- Phase 3: YELLOW-holding tier path ---
  yellow: true,                     // run the YELLOW-balance tier test (set --no-yellow to skip the long wait)
  yellowAsset: 'YELLOW',            // faucet asset for the platform token
  yellowTargetTier: null,           // competition tier_level to reach via YELLOW (default: volume-qualified tier + 1)
  yellowMult: 24,                   // deposit = yellowReq * mult; the 24h hour-weighted avg ≈ deposit/24, so ~24x crosses the req in one tick
  yellowWatchSecs: 100,             // poll budget for the 24h-average YELLOW balance to ingest (~100s on this env)
  yellowPollSecs: 10,               // poll interval while waiting for the YELLOW average

  // --- Phase 4: spot sanity (perp-only comp -> standard fees; spot_perp comp -> overlay discounts spot) ---
  spotCheck: true,                  // run the spot sanity check (set --no-spot-check to skip)
  spotMarket: 'ETHUSDT',            // spot market for the sanity trade
  spotBase: 'ETH',                  // spot base asset to faucet (for sell-side / inventory)
  spotNotional: 300,                // USD notional for the spot sanity fill

  // --- Phase 5: YELLOW tier DECREASE (sell all YELLOW to the maker, confirm fee rises back) ---
  yellowDecrease: true,             // after the YELLOW increase, drain YELLOW and verify the tier drops
  yellowMarket: 'YELLOWUSDT',       // spot market used to sell YELLOW from subject -> maker
  yellowSellPrice: '0.01',          // limit price for the maker's YELLOW bid (drain price; value irrelevant)

  rps: 6,
  maxRetries: 5,
  delay: 200,
  transferTimeoutMs: 20000,
  fillTimeoutMs: 10000,
  feeEpsilon: 0.06,                 // relative tolerance comparing observed vs engine rate
};

const USAGE = `Verify the perp fee-tier engine: correct fee charged + steps down with competition volume,
from BOTH sides (taker & maker) for BOTH accounts (enrolled subject + non-enrolled counterparty).

Phases (sequential, share one funded context):
  1 volume + role swap   drive volume; first half subject takes, second half subject rests (maker)
  2 marker @ deepened    wait for the engine to catch up, then confirm the deepened tier both sides
  3 YELLOW up            faucet YELLOW so the 24h avg crosses a tier req; verify the overlay deepens
  4 spot sanity          spot_perp comp -> overlay discounts spot; perp-only -> spot stays standard
  5 YELLOW down          drain YELLOW; verify the tier drops back and the fee rises again
  + non-enrolled         the counterparty never enrolled -> standard fees only (negative control)

Environments (--env, default uat):
  uat    faucet available -> fresh random wallets, auto-funded each run.
  stage  NO faucet -> pre-funded wallets from users.stage.json (top up manually); YELLOW phases
         depend on faucet spikes so they auto-skip on stage. Flags: --users-file, --subject-index,
         --maker-index, --min-perp-usd.

Usage:
  node run.js --competition <slug>
  node run.js --env stage --competition <slug>            # uses users.stage.json
  node run.js --competition <slug> --market BTCUSDT-PERP --target-tier 3
  node run.js --no-yellow --no-spot-check
  node run.js --help

Common flags: --env --competition --market --target-tier --target-volume --order-notional
  --marker-fills --watch-secs --no-yellow --no-spot-check --no-yellow-decrease --epsilon --rps
Output: ./results/fee-verify-<competition>-<ts>.json`;

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  const explicit = new Set();   // endpoint keys passed on the CLI -> applyEnv must not override them
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    switch (a) {
      case '--env':             out.env = String(next).toLowerCase(); i++; break;
      case '--users-file':      out.usersFile = next; i++; break;
      case '--subject-index':   out.subjectIndex = parseInt(next, 10); i++; break;
      case '--maker-index':     out.makerIndex = parseInt(next, 10); i++; break;
      case '--min-perp-usd':    out.minPerpUsd = parseFloat(next); i++; break;
      case '--base':            out.base = next; explicit.add('base'); i++; break;
      case '--auth-base':       out.authBase = next; explicit.add('authBase'); i++; break;
      case '--trading-base':    out.tradingBase = next; explicit.add('tradingBase'); i++; break;
      case '--faucet-url':      out.faucetUrl = next; explicit.add('faucetUrl'); i++; break;
      case '--fee-tiers-url':   out.feeTiersUrl = next; i++; break;
      case '--schedule-key':    out.scheduleKey = next; i++; break;
      case '--competition':     out.competition = next; i++; break;
      case '--market':          out.market = next; i++; break;
      case '--maker-enroll':    out.makerEnroll = next !== 'false'; i++; break;
      case '--collateral':      out.collateral = next; i++; break;
      case '--faucet-usdt':     out.faucetUsdt = next; i++; break;
      case '--transfer-usdt':   out.transferUsdt = next; i++; break;
      case '--leverage':        out.leverage = parseFloat(next); i++; break;
      case '--std-taker':       out.stdTakerRate = parseFloat(next); i++; break;
      case '--std-maker':       out.stdMakerRate = parseFloat(next); i++; break;
      case '--target-tier':     out.targetTier = parseInt(next, 10); i++; break;
      case '--target-volume':   out.targetVolume = parseFloat(next); i++; break;
      case '--order-notional':  out.orderNotional = parseFloat(next); i++; break;
      case '--max-orders':      out.maxOrders = parseInt(next, 10); i++; break;
      case '--watch-secs':      out.watchSecs = parseInt(next, 10); i++; break;
      case '--marker-fills':    out.markerFills = parseInt(next, 10); i++; break;
      case '--yellow':          out.yellow = next !== 'false'; i++; break;
      case '--no-yellow':       out.yellow = false; break;
      case '--yellow-asset':    out.yellowAsset = next; i++; break;
      case '--yellow-target-tier': out.yellowTargetTier = parseInt(next, 10); i++; break;
      case '--yellow-mult':     out.yellowMult = parseFloat(next); i++; break;
      case '--yellow-watch-secs': out.yellowWatchSecs = parseInt(next, 10); i++; break;
      case '--yellow-poll-secs': out.yellowPollSecs = parseInt(next, 10); i++; break;
      case '--spot-check':      out.spotCheck = next !== 'false'; i++; break;
      case '--no-spot-check':   out.spotCheck = false; break;
      case '--spot-market':     out.spotMarket = next; i++; break;
      case '--spot-base':       out.spotBase = next; i++; break;
      case '--spot-notional':   out.spotNotional = parseFloat(next); i++; break;
      case '--yellow-decrease': out.yellowDecrease = next !== 'false'; i++; break;
      case '--no-yellow-decrease': out.yellowDecrease = false; break;
      case '--yellow-market':   out.yellowMarket = next; i++; break;
      case '--yellow-sell-price': out.yellowSellPrice = next; i++; break;
      case '--rps':             out.rps = parseFloat(next); i++; break;
      case '--delay':           out.delay = parseInt(next, 10); i++; break;
      case '--epsilon':         out.feeEpsilon = parseFloat(next); i++; break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`); process.exit(2);
    }
  }
  applyEnv(out, explicit);   // swap endpoints + faucet/accountSource for the chosen --env
  return out;
}

module.exports = { DEFAULTS, USAGE, parseArgs };
