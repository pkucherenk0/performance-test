'use strict';
// Console summary + JSON artifact for one run.

const fs = require('fs');
const path = require('path');

function report(ctx, checks) {
  console.log('\n=== ASSERTIONS ===');
  let allPass = true;
  for (const c of checks) {
    if (!c.info) allPass = allPass && c.pass;          // info checks never fail the run
    const tag = c.info ? (c.pass ? 'INFO' : 'WARN') : (c.pass ? 'PASS' : 'FAIL');
    console.log(`${tag}  ${c.name}`);
    if (c.detail && (!c.pass || c.info)) console.log('      ', JSON.stringify(c.detail));
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
    timeline: ctx.timeline, crossingObs: ctx.crossingObs, checks, allPass,
  }, null, 2));
  console.log(`\nResults: ${outFile}`);
  console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
}

module.exports = { report, writeResults };
