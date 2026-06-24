'use strict';
// PHASE 5 — YELLOW tier DECREASE: sell all the subject's YELLOW to the maker, wait for the
// campaign_yellow_balance to decay below the tier req, then trade and verify the overlay tier
// dropped back to the volume-qualified tier and the fee ROSE again.

const { sleep } = require('../lib/http');
const { getFeeTierEffective } = require('../lib/fees');
const { getSpotAssetBalance, createSpotOrder } = require('../lib/spot');
const { expectedCompTier, expectedTierEither, close } = require('../lib/tiers');
const { C } = require('../lib/checks');
const { takerFill } = require('../lib/trade');

async function phaseYellowDown(ctx) {
  const { rl, opts, tiers, subject, maker } = ctx;
  const checks = [];
  const yellowResult = ctx.yellowResult;
  if (!yellowResult || !yellowResult.yellowQualified) return checks;   // nothing was raised via YELLOW

  const volTier = expectedCompTier(tiers, ctx.campaignVol);
  const peakCharged = yellowResult.charged;
  const ybal = await getSpotAssetBalance(rl, opts, subject.jwt, subject.appSessionId, opts.yellowAsset);
  const sellQty = Math.floor(ybal);
  console.log(`\nPhase 5 — YELLOW tier decrease: subject holds ${ybal} ${opts.yellowAsset}; selling all to the maker on ${opts.yellowMarket}...`);
  if (sellQty < 1) {
    console.log(`  no YELLOW balance to sell (${ybal}) — skipping.`);
    return checks;
  }
  const mk = await createSpotOrder(rl, opts, maker.jwt, maker.appSessionId, { market: opts.yellowMarket, side: 'buy', type: 'limit', amount: String(sellQty), price: opts.yellowSellPrice, tif: 'gtc' });
  await sleep(300);
  const sj = mk.ok ? await createSpotOrder(rl, opts, subject.jwt, subject.appSessionId, { market: opts.yellowMarket, side: 'sell', type: 'market', amount: String(sellQty) }) : { ok: false, error: 'maker bid rejected: ' + mk.error };
  await sleep(1500);
  const yAfterBal = await getSpotAssetBalance(rl, opts, subject.jwt, subject.appSessionId, opts.yellowAsset);
  console.log(`  sell ${sellQty}: ${sj.ok ? 'ok' : 'FAILED ' + sj.error} | subject ${opts.yellowAsset} now ${yAfterBal}`);

  console.log(`  waiting up to ${opts.yellowWatchSecs}s for overlay.campaign_yellow_balance to decay below ${yellowResult.req}...`);
  const dDeadline = Date.now() + opts.yellowWatchSecs * 1000;
  let dEff = await getFeeTierEffective(rl, opts, subject.jwt);
  while (Date.now() < dDeadline) {
    dEff = await getFeeTierEffective(rl, opts, subject.jwt);
    if (!dEff?.overlayActive || (dEff.overlayCampaignYellow ?? 0) < yellowResult.req) break;
    console.log(`    campaign_yellow_balance = ${dEff?.overlayCampaignYellow ?? 'n/a'} (want < ${yellowResult.req}); overlay taker ${dEff?.overlayPerpTaker != null ? (dEff.overlayPerpTaker * 100).toFixed(4) + '%' : '-'}`);
    await sleep(opts.yellowPollSecs * 1000);
  }
  const yAfter = dEff?.overlayCampaignYellow ?? 0;
  const o = await takerFill(ctx, true, 5);
  if (!o.skip && opts.delay) await sleep(opts.delay);
  if (!o.skip) await takerFill(ctx, false, 5);
  const eff3 = await getFeeTierEffective(rl, opts, subject.jwt);
  const expTierAfter = expectedTierEither(tiers, ctx.campaignVol, yAfter);
  const yellowDecreaseResult = {
    soldQty: sellQty, yellowBalanceAfter: yAfterBal, campaignYellowAfter: yAfter,
    volTier: volTier.name, expectedTierAfter: expTierAfter.name, expectedTakerAfter: expTierAfter.takerRate,
    overlayTakerAfter: eff3?.overlayPerpTaker ?? null, chargedAfter: o.row?.observedRate ?? null,
    peakCharged, droppedToVolumeTier: expTierAfter.tier === volTier.tier,
  };
  ctx.yellowDecreaseResult = yellowDecreaseResult;
  console.log(`  result: campaign_yellow_balance ${yAfter} | tier now ${expTierAfter.name} (${(expTierAfter.takerRate * 100).toFixed(4)}%) | overlay taker ${eff3?.overlayPerpTaker != null ? (eff3.overlayPerpTaker * 100).toFixed(4) + '%' : '-'} | perp fill charged ${o.row?.observedRate != null ? (o.row.observedRate * 100).toFixed(4) + '%' : 'n/a'} (was ${peakCharged != null ? (peakCharged * 100).toFixed(4) + '%' : '?'} at YELLOW peak)`);

  checks.push(C('YELLOW decrease: campaign_yellow_balance decayed below the tier req after selling', yellowDecreaseResult.campaignYellowAfter < yellowResult.req, { campaignYellowAfter: yellowDecreaseResult.campaignYellowAfter, req: yellowResult.req }));
  checks.push(C('YELLOW decrease: overlay tier dropped back to the volume-qualified tier', yellowDecreaseResult.droppedToVolumeTier, { tierAfter: yellowDecreaseResult.expectedTierAfter, volTier: yellowDecreaseResult.volTier, overlayTakerAfter: yellowDecreaseResult.overlayTakerAfter }));
  const rose = yellowDecreaseResult.chargedAfter != null && yellowDecreaseResult.peakCharged != null && yellowDecreaseResult.chargedAfter > yellowDecreaseResult.peakCharged * (1 + opts.feeEpsilon);
  checks.push(C('YELLOW decrease: perp fee ROSE again after YELLOW removed (discount reverted, subsequent fills)', rose, { peakCharged: yellowDecreaseResult.peakCharged, chargedAfter: yellowDecreaseResult.chargedAfter }));
  return checks;
}

module.exports = { phaseYellowDown };
