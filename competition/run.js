#!/usr/bin/env node
'use strict';
// Orchestrator: parse args -> build the shared funded context -> run the phases IN ORDER
// (they share state and accumulate volume) -> report + write the JSON artifact.
// Add a phase by writing one cases/*.js module and one line below.

const path = require('path');
const { parseArgs } = require('./config');
const { createRateLimiter } = require('./lib/http');
const { setup } = require('./setup');
const { report, writeResults } = require('./lib/report');
const { setVerbose } = require('./lib/checks');

const { phaseVolume } = require('./cases/phase1-volume-swap');
const { phaseMarkerFills } = require('./cases/phase2-marker-deepened');
const { phaseYellowUp } = require('./cases/phase3-yellow-up');
const { phaseSpotSanity } = require('./cases/phase4-spot-sanity');
const { phaseYellowDown } = require('./cases/phase5-yellow-down');
const { phaseNonEnrolled } = require('./cases/non-enrolled');
const { phaseBaseVipCrossover } = require('./cases/phase6-base-vip-crossover');

async function main() {
  const opts = parseArgs(process.argv);
  setVerbose(opts.debug);   // clean test-report output by default; --debug for the full per-fill firehose
  const rl = createRateLimiter(opts.rps);
  const ctx = await setup(rl, opts);

  const checks = [];
  checks.push(...await phaseVolume(ctx));                              // phase 1: drives volume + pre-swap taker-discount gate
  checks.push(...await phaseMarkerFills(ctx));                         // phase 2 + all perp-volume assertions
  if (opts.yellow)                        checks.push(...await phaseYellowUp(ctx));
  if (opts.spotCheck)                     checks.push(...await phaseSpotSanity(ctx));
  if (opts.yellow && opts.yellowDecrease) checks.push(...await phaseYellowDown(ctx));
  if (!opts.makerEnroll)                  checks.push(...await phaseNonEnrolled(ctx));
  // Phase 6 reads the subject's recorded timeline (no extra accounts); disabled on stage where
  // seeded accounts carry uncontrolled standard tiers (--no-base-vip to skip on uat too).
  if (opts.baseVip && opts.env !== 'stage') checks.push(...await phaseBaseVipCrossover(ctx));

  const allPass = report(ctx, checks);
  writeResults(ctx, checks, allPass, path.join(__dirname, 'results'));
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
