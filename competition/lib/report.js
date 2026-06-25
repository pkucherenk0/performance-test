'use strict';
// Console summary + JSON artifact for one run.

const fs = require('fs');
const path = require('path');

// status tag for a check: FAIL/WARN fail-or-info split, PASS/INFO on success.
const tagOf = (c) => (c.info ? (c.pass ? 'INFO' : 'WARN') : (c.pass ? 'PASS' : 'FAIL'));

function report(ctx, checks) {
  // tally up front so the verdict shape is readable before scanning 30+ lines.
  const tally = { PASS: 0, FAIL: 0, INFO: 0, WARN: 0 };
  for (const c of checks) tally[tagOf(c)]++;
  const allPass = tally.FAIL === 0;

  const hard = tally.PASS + tally.FAIL;          // assertions that could actually fail the run
  const skipped = tally.INFO + tally.WARN;       // observational / not-exercised paths (auto-pass)
  console.log(`\n=== ASSERTIONS (${checks.length}: ${tally.PASS} pass, ${tally.INFO} info, ${tally.FAIL} fail, ${tally.WARN} warn) ===`);
  console.log(`Coverage: ${hard} hard assertion${hard === 1 ? '' : 's'} exercised (${tally.PASS} pass, ${tally.FAIL} fail) · ${skipped} observational/not-exercised (auto-pass — see REVIEW)`);
  for (const c of checks) {
    const tag = tagOf(c);
    console.log(`${tag}  ${c.name}`);
    if (c.detail && (!c.pass || c.info)) console.log('      ', JSON.stringify(c.detail));
  }

  if (ctx.warnings && ctx.warnings.length) {
    console.log(`\n=== WARNINGS (${ctx.warnings.length}) ===   (non-failing skips / anomalies / lag notes — review even on a green run)`);
    for (const w of ctx.warnings) console.log(`WARN  ${w}`);
  }

  // REVIEW — re-list the info checks (INFO + WARN) on their own. These never fail the run, so on a
  // green "ALL CHECKS PASSED" they hide among the PASS lines; they're exactly the items that need an
  // eyeball (skips, "DELAY not a regression", inconclusive paths, "no crossover possible").
  const review = checks.filter((c) => c.info);
  if (review.length) {
    console.log(`\n=== REVIEW (${review.length}) ===   non-failing items to eyeball even on a green run`);
    for (const c of review) {
      console.log(`${tagOf(c)}  ${c.name}`);
      if (c.detail) console.log('      ', JSON.stringify(c.detail));
    }
  }

  const reached = ctx.crossingObs.filter((c) => c.reached);
  if (!reached.length) console.log('\n⚠️  No competition tier thresholds were reached — raise --target-tier/--order-notional/--faucet-usdt, or use an edition with an active overlay and reachable campaign bands.');
  return allPass;
}

// Writes ./<outDir>/fee-verify-<competition>-<ts>.json (outDir is created if missing).
function writeResults(ctx, checks, allPass, outDir) {
  const { opts, comp, mkt, subject, maker } = ctx;
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `fee-verify-${opts.competition}-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    competition: opts.competition, market: mkt.market,
    scheduleSource: ctx.scheduleSource, volumeSource: comp.volume_source, status: comp.status,
    window: { starts_at: comp.starts_at, ends_at: comp.ends_at },
    startTotalVolume: ctx.startTotalVolume, endTotalVolume: ctx.endTotalVolume,
    tiers: ctx.tiers, reductionExpected: ctx.reductionExpected, stdTakerRate: opts.stdTakerRate, stdMakerRate: opts.stdMakerRate,
    subject: subject.wallet.address, maker: maker.wallet.address,
    baseline: ctx.baseline, finalEffective: ctx.finalEff, finalCampaignVol: Math.round(ctx.campaignVol), tradedVol: Math.round(ctx.tradedVol), cycles: ctx.cycle,
    makerEnrolled: opts.makerEnroll,
    yellowResult: ctx.yellowResult, yellowDecreaseResult: ctx.yellowDecreaseResult, spotResult: ctx.spotResult, nonEnrolledResult: ctx.nonEnrolledResult,
    timeline: ctx.timeline, crossingObs: ctx.crossingObs, warnings: ctx.warnings || [], checks, allPass,
  }, null, 2));
  console.log(`\nResults: ${outFile}`);
  console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
}

module.exports = { report, writeResults };
