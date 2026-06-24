'use strict';
// PHASE 3 — push the overlay tier DEEPER via the 24h-average YELLOW balance (either-threshold rule).
// Faucet ~24x the target tier's campaign_yellow_req so the hour-weighted 24h average crosses it in
// one tick, wait for ingestion, then trade and verify the overlay tier deepened via YELLOW alone.

const { sleep } = require('../lib/http');
const { faucet } = require('../lib/accounts');
const { getFeeTierEffective } = require('../lib/fees');
const { expectedCompTier, expectedTierEither, close } = require('../lib/tiers');
const { C } = require('../lib/checks');
const { takerFill } = require('../lib/trade');

async function phaseYellowUp(ctx) {
  const { rl, opts, tiers, subject } = ctx;
  const checks = [];
  if (!opts.faucet) {
    console.log(`\nPhase 3 (YELLOW): skipped on env "${opts.env}" — the 24h-average crossing relies on a faucet deposit spike (≈ deposit/24 in one tick). On a no-faucet env, pre-hold YELLOW for >24h so the average already qualifies, or run a dedicated long YELLOW soak.`);
    return checks;
  }
  const volTier = expectedCompTier(tiers, ctx.campaignVol);
  const targetTier = opts.yellowTargetTier != null
    ? tiers.find((t) => t.tier === opts.yellowTargetTier)
    : (tiers.find((t) => t.tier === volTier.tier + 1) || tiers[tiers.length - 1]);
  if (!targetTier || !(targetTier.yellowMin > 0)) {
    console.log('\nPhase 3 (YELLOW): no higher tier with a YELLOW requirement to target — skipping.');
    return checks;
  }
  const req = targetTier.yellowMin;
  const dep = Math.ceil(req * opts.yellowMult * 1.05);
  console.log(`\nPhase 3 — YELLOW path: target ${targetTier.name} (campaign_yellow_req ${req}); volume alone qualifies ${volTier.name}.`);
  console.log(`  depositing ${dep} ${opts.yellowAsset} so the 24h hour-weighted average (≈ deposit/24 in one tick) crosses ${req}...`);
  const fy = await faucet(rl, opts.faucetUrl, subject.appSessionId, opts.yellowAsset, String(dep), opts.maxRetries);
  console.log(`  faucet ${opts.yellowAsset} ${dep}: ${fy.ok ? 'ok' : 'FAILED ' + (fy.body?.error || fy.body?.message || fy.httpStatus)}`);

  console.log(`  waiting up to ${opts.yellowWatchSecs}s for overlay.campaign_yellow_balance (24h avg) to reach ${req}...`);
  const yDeadline = Date.now() + opts.yellowWatchSecs * 1000;
  let yEff = await getFeeTierEffective(rl, opts, subject.jwt);
  while (Date.now() < yDeadline) {
    yEff = await getFeeTierEffective(rl, opts, subject.jwt);
    if (yEff?.overlayActive && (yEff.overlayCampaignYellow ?? 0) >= req) break;
    console.log(`    campaign_yellow_balance = ${yEff?.overlayCampaignYellow ?? 'n/a'} / ${req}; overlay taker ${yEff?.overlayPerpTaker != null ? (yEff.overlayPerpTaker * 100).toFixed(4) + '%' : '-'}`);
    await sleep(opts.yellowPollSecs * 1000);
  }
  const yb = yEff?.overlayCampaignYellow ?? 0;
  const yellowQualified = !!yEff?.overlayActive && yb >= req * (1 - opts.feeEpsilon);
  const o = await takerFill(ctx, true, 3);
  if (!o.skip && opts.delay) await sleep(opts.delay);
  if (!o.skip) await takerFill(ctx, false, 3);
  const eff2 = await getFeeTierEffective(rl, opts, subject.jwt);
  const expTier = expectedTierEither(tiers, ctx.campaignVol, yb);
  const yellowResult = {
    targetTier: targetTier.name, req, deposited: dep, campaignYellow: yb, yellowQualified,
    volTier: volTier.name, expectedTier: expTier.name, expectedOverlayTaker: expTier.takerRate,
    overlayTakerAfter: eff2?.overlayPerpTaker ?? null, charged: o.row?.observedRate ?? null,
    deeperThanVolume: expTier.tier > volTier.tier, preYellowFloor: ctx.finalFloor,
  };
  ctx.yellowResult = yellowResult;
  console.log(`  result: campaign_yellow_balance ${yb} | either-threshold tier ${expTier.name} (${(expTier.takerRate * 100).toFixed(4)}%) | overlay taker ${eff2?.overlayPerpTaker != null ? (eff2.overlayPerpTaker * 100).toFixed(4) + '%' : '-'} | perp fill charged ${o.row?.observedRate != null ? (o.row.observedRate * 100).toFixed(4) + '%' : 'n/a'}`);

  checks.push(C('YELLOW: 24h-average balance reached the target campaign_yellow_req', yellowResult.yellowQualified, { campaignYellow: yellowResult.campaignYellow, req: yellowResult.req }));
  if (yellowResult.deeperThanVolume) {
    const overlayOk = yellowResult.overlayTakerAfter != null && close(yellowResult.overlayTakerAfter, yellowResult.expectedOverlayTaker, opts.feeEpsilon);
    checks.push(C('YELLOW: overlay tier deepened via YELLOW (either-threshold) beyond the volume tier', overlayOk, { expectedTier: yellowResult.expectedTier, expectedOverlayTaker: yellowResult.expectedOverlayTaker, overlayTakerAfter: yellowResult.overlayTakerAfter, volTier: yellowResult.volTier }));
    const reduced = yellowResult.charged != null && yellowResult.preYellowFloor != null && yellowResult.charged < yellowResult.preYellowFloor * (1 - opts.feeEpsilon);
    const expectMore = yellowResult.expectedOverlayTaker < (yellowResult.preYellowFloor ?? Infinity) * (1 - opts.feeEpsilon);
    checks.push(C('YELLOW: perp fill charged at a further-reduced rate after YELLOW deepened the tier', expectMore ? reduced : true, { charged: yellowResult.charged, preYellowFloor: yellowResult.preYellowFloor, expectedOverlayTaker: yellowResult.expectedOverlayTaker }, !expectMore));
  } else {
    checks.push(C('YELLOW: overlay tier deepened via YELLOW', true, 'target YELLOW tier not above the volume-qualified tier — nothing further to gain via YELLOW at this volume', true));
  }
  return checks;
}

module.exports = { phaseYellowUp };
