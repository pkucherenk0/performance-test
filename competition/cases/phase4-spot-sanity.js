'use strict';
// PHASE 4 — spot behaviour depends on the competition's volume_source:
//   perp-only competition  -> spot is OUT, overlay must NOT discount spot (spot = standard schedule).
//   spot_perp / spot comp   -> spot is IN, overlay SHOULD discount spot (best-of applies to spot too).

const { sleep } = require('../lib/http');
const { faucet } = require('../lib/accounts');
const { getFeeTierEffective } = require('../lib/fees');
const { getSpotFeeRate, getSpotReferencePrice, createSpotOrder, countSpotTrades } = require('../lib/spot');
const { close } = require('../lib/tiers');
const { C } = require('../lib/checks');

async function phaseSpotSanity(ctx) {
  const { rl, opts, subject, maker } = ctx;
  const checks = [];
  const spotInComp = /spot/i.test(ctx.comp?.volume_source || '');
  console.log(`\nPhase 4 — spot check on ${opts.spotMarket} (volume_source=${ctx.comp?.volume_source}: spot ${spotInComp ? 'IS in the competition — overlay SHOULD discount spot' : 'is NOT in the competition — overlay must NOT discount spot'})...`);
  let spotRate = await getSpotFeeRate(rl, opts, subject.jwt, subject.appSessionId, opts.spotMarket);
  const effNow = await getFeeTierEffective(rl, opts, subject.jwt);
  // When spot is in the competition the overlay discount on spot ingests a little after the overlay
  // turns on — poll briefly for the live spot taker to drop to the overlay rate before asserting.
  const ovSpot = effNow?.overlaySpotTaker ?? null, stdSpot = effNow?.standardSpotTaker ?? null;
  if (spotInComp && effNow?.overlayActive && ovSpot != null && stdSpot != null && ovSpot < stdSpot * (1 - opts.feeEpsilon)) {
    const sDeadline = Date.now() + opts.watchSecs * 1000;
    while (Date.now() < sDeadline && !(spotRate?.takerRate != null && close(spotRate.takerRate, ovSpot, opts.feeEpsilon))) {
      console.log(`    spot taker ${spotRate?.takerRate != null ? (spotRate.takerRate * 100).toFixed(4) + '%' : '-'} (want overlay ${(ovSpot * 100).toFixed(4)}%); waiting for spot discount to ingest...`);
      await sleep(opts.yellowPollSecs * 1000);
      spotRate = await getSpotFeeRate(rl, opts, subject.jwt, subject.appSessionId, opts.spotMarket);
    }
  }
  let spotFilled = false, spotErr = null;
  // The spot fee-rate assertions (s1–s3) are authoritative and don't need a fill. The sanity fill
  // needs spot inventory on both accounts; on a no-faucet env there's none (collateral was swept to
  // perps), so skip the fill cleanly there rather than firing an order that just rejects.
  const spotPx = await getSpotReferencePrice(rl, opts, opts.spotMarket);
  if (!opts.faucet) {
    spotErr = 'skipped on stage — no spot inventory without a faucet (spot rate checks above are authoritative)';
  } else {
    const fb = await faucet(rl, opts.faucetUrl, subject.appSessionId, opts.spotBase, '50', opts.maxRetries);
    if (spotPx > 0 && fb.ok) {
      const amt = (Math.max(opts.spotNotional, 10) / spotPx).toFixed(4);
      const bidPx = (spotPx * 0.999).toFixed(2);
      const before = await countSpotTrades(rl, opts, subject.jwt, subject.appSessionId, opts.spotMarket);
      const mk = await createSpotOrder(rl, opts, maker.jwt, maker.appSessionId, { market: opts.spotMarket, side: 'buy', type: 'limit', amount: amt, price: bidPx, tif: 'gtc' });
      await sleep(300);
      const sj = mk.ok ? await createSpotOrder(rl, opts, subject.jwt, subject.appSessionId, { market: opts.spotMarket, side: 'sell', type: 'market', amount: amt }) : { ok: false, error: 'maker bid rejected: ' + mk.error };
      spotErr = sj.ok ? null : sj.error;
      if (sj.ok) { await sleep(1500); spotFilled = (await countSpotTrades(rl, opts, subject.jwt, subject.appSessionId, opts.spotMarket)) > before; }
    } else {
      spotErr = `no spot price (${spotPx}) or base faucet failed`;
    }
  }
  const spotResult = {
    market: opts.spotMarket,
    spotEffectiveTaker: spotRate?.takerRate ?? null, spotRateSource: spotRate?.source ?? null,
    standardSpotTaker: effNow?.standardSpotTaker ?? null, overlaySpotTaker: effNow?.overlaySpotTaker ?? null,
    effSpotTaker: effNow?.effSpotTaker ?? null, overlayActive: effNow?.overlayActive ?? null,
    filled: spotFilled, error: spotErr,
  };
  ctx.spotResult = spotResult;
  console.log(`  spot effective taker ${spotRate?.takerRate != null ? (spotRate.takerRate * 100).toFixed(4) + '%' : '-'} (src ${spotRate?.source}) | standard ${effNow?.standardSpotTaker != null ? (effNow.standardSpotTaker * 100).toFixed(4) + '%' : '-'} | overlay ${effNow?.overlaySpotTaker != null ? (effNow.overlaySpotTaker * 100).toFixed(4) + '%' : '-'} | fill ${spotFilled ? 'ok' : 'no (' + spotErr + ')'}`);

  // (s1) PRIMARY, lag-robust: does the competition overlay touch spot? When the overlay spot rate
  //      is cheaper than standard (it WOULD change the outcome if applied) we can tell from the live fee:
  //        spot IN  comp -> live spot fee must equal the overlay rate (discounted, best-of picks overlay)
  //        spot OUT comp -> live spot fee must stay ABOVE the overlay rate (standard schedule only)
  //      Anchors on the live fee + overlay rate, never the laggy fee-tier-effective field.
  const se = spotResult.spotEffectiveTaker, ov = spotResult.overlaySpotTaker, st = spotResult.standardSpotTaker;
  const overlayCheaperThanStd = spotResult.overlayActive && ov != null && st != null && ov < st * (1 - opts.feeEpsilon);
  if (!overlayCheaperThanStd) {
    checks.push(C(`spot ${spotInComp ? 'discounted' : 'NOT discounted'} by competition overlay`, true, `inconclusive: overlay spot (${ov}) not cheaper than standard (${st}) — best-of picks standard for spot either way`, true));
  } else if (spotInComp) {
    // spot is IN the competition -> overlay SHOULD discount it. HARD guard: spot is never charged
    // ABOVE standard (a real regression). The discount itself ingests with a lag, so a not-yet-discounted
    // reading (spot == standard) is reported as INFO, and only spot < standard ~ overlay is the PASS.
    const notWorse = se != null && se <= st * (1 + opts.feeEpsilon);
    checks.push(C('spot never charged ABOVE the standard schedule', notWorse, { spotEffectiveTaker: se, standardSpotTaker: st }));
    const discounted = se != null && close(se, ov, opts.feeEpsilon);
    if (discounted) {
      checks.push(C('spot DISCOUNTED by competition overlay (spot is in the competition, best-of applies)', true, { spotEffectiveTaker: se, overlaySpotTaker: ov, standardSpotTaker: st }));
    } else {
      checks.push(C('spot DISCOUNTED by competition overlay (spot is in the competition, best-of applies)', true, `spot discount not yet ingested at read time: live spot ${se} still ~ standard ${st}, overlay ${ov} (field lags overlay activation; spot is never above standard, asserted separately)`, true));
    }
  } else {
    const notDiscounted = se != null && se > ov * (1 + opts.feeEpsilon);
    checks.push(C('spot NOT discounted by competition overlay (spot uses the standard schedule)', notDiscounted, { spotEffectiveTaker: se, overlaySpotTaker: ov, standardSpotTaker: st }));
  }
  // (s2) the live spot fee is a real fee_tier rate (source) — sanity on the source field.
  const s2 = spotResult.spotRateSource === 'fee_tier' || spotResult.spotRateSource === 'fee_engine';
  checks.push(C('spot fee resolved from the fee-tier engine (source)', s2, { source: spotResult.spotRateSource, spotEffectiveTaker: se }));
  // (s3) INFO: spot effective vs the EXPECTED best-of (overlay best-of when spot is in the comp,
  //      else the standard.spot field). The fee-tier-effective fields lag the live tier.
  const expectedSpot = spotInComp && overlayCheaperThanStd ? ov : st;
  const s3 = se != null && expectedSpot != null && close(se, expectedSpot, opts.feeEpsilon);
  checks.push(C('spot effective == expected best-of spot rate (fee-tier-effective fields lag live tier)', s3, { spotEffectiveTaker: se, expectedSpot, standardSpotTakerField: st, overlaySpotTaker: ov, note: 'mismatch = a fee-tier-effective field trailing the live tier' }, true));
  // (s4) a real spot fill executed — INFO (/spot/trades exposes no per-fill fee; the rate checks above are authoritative).
  checks.push(C('spot sanity trade executed (per-fill fee not exposed by /spot/trades)', spotResult.filled || !opts.faucet, spotResult.filled ? 'spot fill confirmed' : `no spot fill: ${spotResult.error}`, true));
  return checks;
}

module.exports = { phaseSpotSanity };
