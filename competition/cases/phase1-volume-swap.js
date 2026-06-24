'use strict';
// PHASE 1 — drive perp volume across competition tiers, swapping roles at the halfway point.
//   First half:  SUBJECT takes (overlay taker fee), counterparty rests (standard maker fee).
//   Second half: roles SWAP — SUBJECT rests (overlay MAKER fee), counterparty takes (standard taker).
// Then wait for the campaign-volume tracker to ingest, and record the qualified tier crossing.
// Produces no checks itself; it sets up ctx state consumed by phase 2's assertions.

const { sleep } = require('../lib/http');
const { getFeeTierEffective } = require('../lib/fees');
const { expectedCompTier, close } = require('../lib/tiers');
const { logSides } = require('../lib/checks');
const { takerFill } = require('../lib/trade');

async function phaseVolume(ctx) {
  const { rl, opts, subject, tiers, tgt } = ctx;
  console.log('Trading, round-tripping to flatten. First half: SUBJECT takes / counterparty rests.');
  console.log('Second half (after ~50% of target volume): roles SWAP so we verify the fee from both sides for both accounts.');
  let swapped = false;
  while (ctx.tradedVol < tgt && ctx.cycle < opts.maxOrders) {
    ctx.cycle++;
    const swap = ctx.tradedVol >= tgt / 2;   // first half subject=taker; second half subject=maker
    if (swap && !swapped) {
      swapped = true;
      console.log(`\n  ── ROLE SWAP at $${Math.round(ctx.tradedVol).toLocaleString()}: enrolled SUBJECT now RESTS as MAKER, counterparty TAKES ──`);
      console.log(`     (confirms the competition overlay also discounts the subject's MAKER fills, and the non-enrolled counterparty pays standard TAKER fees)\n`);
    }
    const open = await takerFill(ctx, true, 1, swap);
    if (open.skip) { console.warn(`  cycle ${ctx.cycle} open skipped: ${open.reason}`); if (opts.delay) await sleep(opts.delay); continue; }
    if (opts.delay) await sleep(opts.delay);
    const closeFill = await takerFill(ctx, false, 1, swap);
    const r = open.row;
    const cv = r.overlayCampaignVol != null ? `$${Math.round(r.overlayCampaignVol).toLocaleString()}` : 'pending (overlay not yet ingested)';
    console.log(`  c${ctx.cycle}  traded $${Math.round(ctx.tradedVol).toLocaleString()} | campaignVol ${cv}`);
    logSides(r);
    if (closeFill.skip) console.warn(`  cycle ${ctx.cycle} close skipped: ${closeFill.reason}`);
    if (opts.delay) await sleep(opts.delay);
  }

  console.log(`\nWaiting up to ${opts.watchSecs}s for campaign_volume_usd to ingest tradedVol $${Math.round(ctx.tradedVol).toLocaleString()}...`);
  const deadline = Date.now() + opts.watchSecs * 1000;
  let finalEff = await getFeeTierEffective(rl, opts, subject.jwt);
  while (Date.now() < deadline) {
    finalEff = await getFeeTierEffective(rl, opts, subject.jwt);
    if (finalEff?.overlayActive && finalEff.overlayCampaignVol >= Math.min(ctx.tradedVol * 0.9, tgt)) break;
    await sleep(5000);
  }
  ctx.finalEff = finalEff;
  ctx.campaignVol = finalEff?.overlayCampaignVol ?? 0;
  console.log(`campaign_volume_usd = $${Math.round(ctx.campaignVol).toLocaleString()}; overlay taker ${finalEff?.overlayPerpTaker != null ? (finalEff.overlayPerpTaker * 100).toFixed(4) + '%' : '-'}, effective taker ${finalEff?.effPerpTaker != null ? (finalEff.effPerpTaker * 100).toFixed(4) + '%' : '-'}`);

  if (finalEff?.overlayActive) {
    const qualTier = expectedCompTier(tiers, ctx.campaignVol);   // highest tier whose volReq <= campaignVol
    for (const t of tiers) {
      if (ctx.campaignVol < t.volMin) continue;                  // not reached
      const isCurrent = t.name === qualTier.name;
      const expectedOverlay = qualTier.takerRate;                // overlay rate should equal the HIGHEST qualified tier's
      const matches = isCurrent ? close(finalEff.overlayPerpTaker, expectedOverlay, opts.feeEpsilon) : true;
      ctx.crossingObs.push({ tier: t.name, volReq: t.volMin, reached: true, isQualified: isCurrent, expectedOverlayTaker: isCurrent ? expectedOverlay : null, observedOverlayTaker: finalEff.overlayPerpTaker, pass: matches });
    }
    console.log(`Qualified competition tier at campaignVol $${Math.round(ctx.campaignVol).toLocaleString()}: ${qualTier.name} (expected overlay taker ${(qualTier.takerRate * 100).toFixed(4)}%)`);
  }
  return [];
}

module.exports = { phaseVolume };
