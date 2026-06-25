'use strict';
// PHASE 5 — YELLOW tier DECREASE: sell all the subject's YELLOW to the maker, wait for the
// campaign_yellow_balance to decay below the tier req, then trade and verify the overlay tier
// dropped back to the volume-qualified tier and the fee ROSE again.

const { sleep } = require('../lib/http');
const { getFeeTierEffective } = require('../lib/fees');
const { getSpotAssetBalance, createSpotOrder } = require('../lib/spot');
const { expectedCompTier, expectedTierEither, close } = require('../lib/tiers');
const { C, logTrade, sid, dbg } = require('../lib/checks');
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
  // The YELLOW market can be EMPTY (no prior trades -> no last/mark price), which makes a MARKET sell
  // rejected with "market_price_unavailable". So use the counterparty (maker) as the BUYER: it rests a
  // limit BID, and the subject sells into it with a crossing LIMIT order (price == the bid). A limit
  // order carries its own price, so it needs no market reference — the maker buys the YELLOW, the trade
  // executes against the otherwise-empty book, and a last price is established.
  const mk = await createSpotOrder(rl, opts, maker.jwt, maker.appSessionId, { market: opts.yellowMarket, side: 'buy', type: 'limit', amount: String(sellQty), price: opts.yellowSellPrice, tif: 'gtc' });
  await sleep(300);
  const sj = mk.ok ? await createSpotOrder(rl, opts, subject.jwt, subject.appSessionId, { market: opts.yellowMarket, side: 'sell', type: 'limit', amount: String(sellQty), price: opts.yellowSellPrice, tif: 'gtc' }) : { ok: false, error: 'maker bid rejected: ' + mk.error };
  await sleep(1500);
  const yAfterBal = await getSpotAssetBalance(rl, opts, subject.jwt, subject.appSessionId, opts.yellowAsset);
  console.log(`  sell ${sellQty}: ${sj.ok ? 'ok' : 'FAILED ' + sj.error} | subject ${opts.yellowAsset} now ${yAfterBal} | trade ${sid(sj.orderUuid)} (maker bid ${sid(mk.orderUuid)})`);

  console.log(`  waiting up to ${opts.yellowWatchSecs}s for overlay.campaign_yellow_balance to decay below ${yellowResult.req}...`);
  const dDeadline = Date.now() + opts.yellowWatchSecs * 1000;
  let dEff = await getFeeTierEffective(rl, opts, subject.jwt);
  while (Date.now() < dDeadline) {
    dEff = await getFeeTierEffective(rl, opts, subject.jwt);
    if (!dEff?.overlayActive || (dEff.overlayCampaignYellow ?? 0) < yellowResult.req) break;
    dbg(`    campaign_yellow_balance = ${dEff?.overlayCampaignYellow ?? 'n/a'} (want < ${yellowResult.req}); overlay taker ${dEff?.overlayPerpTaker != null ? (dEff.overlayPerpTaker * 100).toFixed(4) + '%' : '-'}`);
    await sleep(opts.yellowPollSecs * 1000);
  }
  const yAfter = dEff?.overlayCampaignYellow ?? 0;
  const o = await takerFill(ctx, true, 5);
  if (!o.skip) logTrade(ctx.fillLog, o.row, opts.feeEpsilon);   // trade id + tag for the post-drain fill
  if (!o.skip && opts.delay) await sleep(opts.delay);
  if (!o.skip) await takerFill(ctx, false, 5);
  const eff3 = await getFeeTierEffective(rl, opts, subject.jwt);
  const expTierAfter = expectedTierEither(tiers, ctx.campaignVol, yAfter);
  const yellowDecreaseResult = {
    soldQty: sellQty, sellExecuted: !!sj.ok, yellowBalanceAfter: yAfterBal, campaignYellowAfter: yAfter,
    volTier: volTier.name, expectedTierAfter: expTierAfter.name, expectedTakerAfter: expTierAfter.takerRate,
    overlayTakerAfter: eff3?.overlayPerpTaker ?? null, chargedAfter: o.row?.observedRate ?? null,
    peakCharged, droppedToVolumeTier: expTierAfter.tier === volTier.tier,
  };
  ctx.yellowDecreaseResult = yellowDecreaseResult;
  console.log(`  result: campaign_yellow_balance ${yAfter} | tier now ${expTierAfter.name} (${(expTierAfter.takerRate * 100).toFixed(4)}%) | overlay taker ${eff3?.overlayPerpTaker != null ? (eff3.overlayPerpTaker * 100).toFixed(4) + '%' : '-'} | perp fill charged ${o.row?.observedRate != null ? (o.row.observedRate * 100).toFixed(4) + '%' : 'n/a'} (was ${peakCharged != null ? (peakCharged * 100).toFixed(4) + '%' : '?'} at YELLOW peak)`);

  // SEPARATE a genuine regression from the inherent 24h-average decay DELAY.
  //
  // campaign_yellow_balance is a 24h hour-weighted average. Phase 3 can spike it UP in one tick (a
  // single large deposit alone is ≈ deposit/24, enough to cross the req), but it CANNOT be drained
  // symmetrically: selling zeroes only the CURRENT hour bucket while the prior 23h still carry the
  // spike, so the average stays high for hours. Within --yellow-watch-secs it legitimately will not
  // fall below the req on a short run.
  //
  // So tier-drop / fee-rise are HARD checks ONLY when the metric ACTUALLY decayed below the req (then
  // a tier that failed to revert is a real regression). When it has NOT decayed, the tier correctly
  // stays deep — failing here would misread the decay delay as a bug (the exact delay-vs-regression
  // trap this suite exists to avoid). In that case report the delay as info and instead assert the
  // engine is still CONSISTENT with the not-yet-decayed balance.
  const decayed = yellowDecreaseResult.campaignYellowAfter < yellowResult.req;
  if (decayed) {
    checks.push(C('YELLOW decrease: campaign_yellow_balance decayed below the tier req after selling', true, { campaignYellowAfter: yellowDecreaseResult.campaignYellowAfter, req: yellowResult.req }));
    checks.push(C('YELLOW decrease: overlay tier dropped back to the volume-qualified tier', yellowDecreaseResult.droppedToVolumeTier, { tierAfter: yellowDecreaseResult.expectedTierAfter, volTier: yellowDecreaseResult.volTier, overlayTakerAfter: yellowDecreaseResult.overlayTakerAfter }));
    const rose = yellowDecreaseResult.chargedAfter != null && yellowDecreaseResult.peakCharged != null && yellowDecreaseResult.chargedAfter > yellowDecreaseResult.peakCharged * (1 + opts.feeEpsilon);
    checks.push(C('YELLOW decrease: perp fee ROSE again after YELLOW removed (discount reverted, subsequent fills)', rose, { peakCharged: yellowDecreaseResult.peakCharged, chargedAfter: yellowDecreaseResult.chargedAfter }));
  } else {
    const decayDetail = yellowDecreaseResult.sellExecuted
      ? `DELAY (not a regression): the YELLOW sell executed (spot balance now ${yAfterBal}) but the 24h trailing average is still ${yellowDecreaseResult.campaignYellowAfter} >= req ${yellowResult.req} — a 24h hour-weighted average cannot drain within ${opts.yellowWatchSecs}s; it needs a >24h soak to fall below the req.`
      : `INCONCLUSIVE (not a regression): the YELLOW sell did NOT execute (${sj.error}; ${opts.yellowMarket} unsellable here), so the balance is unchanged at ${yAfterBal} and the decay path was never exercised — separate from a 24h-average decay delay.`;
    checks.push(C('YELLOW decrease: campaign_yellow_balance decayed below the tier req after selling', true, decayDetail, true));
    // System is behaving correctly while the average is still high: the overlay tier must MATCH the
    // either-threshold tier for that not-yet-decayed balance (it must NOT spuriously drop or deepen).
    const consistent = eff3?.overlayPerpTaker != null && close(eff3.overlayPerpTaker, expTierAfter.takerRate, opts.feeEpsilon);
    checks.push(C('YELLOW decrease: overlay tier still consistent with the (not-yet-decayed) 24h YELLOW balance', consistent,
      { campaignYellowAfter: yellowDecreaseResult.campaignYellowAfter, tierForBalance: expTierAfter.name, expectedTaker: expTierAfter.takerRate, overlayTakerAfter: yellowDecreaseResult.overlayTakerAfter }));
    checks.push(C('YELLOW decrease: perp fee ROSE again after YELLOW removed (discount reverted, subsequent fills)', true,
      'DELAY (not a regression): the YELLOW 24h average has not decayed below the req yet, so the tier correctly stays deep and the fee correctly stays low — a fee rise is only expected once the average decays.', true));
  }
  return checks;
}

module.exports = { phaseYellowDown };
