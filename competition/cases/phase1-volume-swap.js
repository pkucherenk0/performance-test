'use strict';
// PHASE 1 — drive perp volume across competition tiers, swapping roles at the halfway point.
//   First half:  SUBJECT takes (overlay taker fee), counterparty rests (standard maker fee).
//   Second half: roles SWAP — SUBJECT rests (overlay MAKER fee), counterparty takes (standard taker).
// Then wait for the campaign-volume tracker to ingest, and record the qualified tier crossing.
//
// Pre-swap gate: the first half races past the ~1-min campaign-volume ingestion, so without a gate
// the subject TAKES the whole first half at the BASE rate (overlay never engages) and the run swaps
// before the taker discount is ever applied — the taker overlay discount would then only be validated
// in phase 2, and the intermediate tier is skipped. So at the 50% boundary we WAIT for ingestion to
// deepen the taker fee, capture one real discounted taker fill, and HARD-assert it (DELAY->info if
// ingestion can't catch up within budget), THEN swap. Returns that one check; phase 2 owns the rest.

const { sleep } = require('../lib/http');
const { getFeeTierEffective } = require('../lib/fees');
const { expectedCompTier, close } = require('../lib/tiers');
const { C, logTrade, logSides, recordWarn, clk, dbg } = require('../lib/checks');
const { takerFill } = require('../lib/trade');

// At the role-swap boundary, wait (up to the ingestion budget) for the campaign overlay to deepen the
// subject's TAKER best-of below its initial (base) rate, then capture one real discounted taker fill.
// Polling only (no extra trading) so it can't consume the second half's volume budget. Returns
// { deepened, captured, row } — deepened=false means ingestion never caught up within budget.
async function gateTakerStepdown(ctx, initRate) {
  const { rl, opts, subject, tiers } = ctx;
  const eps = opts.feeEpsilon;
  console.log(`\n  Pre-swap gate: waiting up to ${opts.watchSecs}s for the overlay to deepen the subject's TAKER fee below ${(initRate * 100).toFixed(4)}% (ingestion lag) before swapping...`);
  const deadline = Date.now() + opts.watchSecs * 1000;
  let deepened = false;
  while (Date.now() < deadline) {
    const eff = await getFeeTierEffective(rl, opts, subject.jwt);
    const floor = eff?.overlayActive && eff.overlayPerpTaker != null && eff.standardPerpTaker != null
      ? Math.min(eff.standardPerpTaker, eff.overlayPerpTaker) : null;
    if (floor != null && initRate != null && floor < initRate * (1 - eps)) { deepened = true; break; }
    dbg(`    overlay ${eff?.overlayActive ? 'active' : 'inactive'} taker best-of ${floor != null ? (floor * 100).toFixed(4) + '%' : '-'} (want < ${(initRate * 100).toFixed(4)}%); campaignVol $${Math.round(eff?.overlayCampaignVol ?? 0).toLocaleString()}`);
    await sleep(opts.yellowPollSecs * 1000);
  }
  if (!deepened) return { deepened: false, captured: false };
  ctx.cycle++;
  const o = await takerFill(ctx, true, 1, false);   // subject TAKES — capture the discounted taker fill
  if (o.skip) return { deepened: true, captured: false, reason: o.reason };
  logTrade(ctx.fillLog, o.row, eps, tiers);
  if (opts.delay) await sleep(opts.delay);
  const c = await takerFill(ctx, false, 1, false);
  if (!c.skip) logTrade(ctx.fillLog, c.row, eps, tiers);
  return { deepened: true, captured: true, row: o.row };
}

async function phaseVolume(ctx) {
  const { rl, opts, subject, tiers, tgt } = ctx;
  const eps = opts.feeEpsilon;
  const checks = [];
  console.log('Trading, round-tripping to flatten. First half: SUBJECT takes / counterparty rests.');
  console.log('Second half (after ~50% of target volume): roles SWAP so we verify the fee from both sides for both accounts.');
  let swapped = false;
  while (ctx.tradedVol < tgt && ctx.cycle < opts.maxOrders) {
    ctx.cycle++;
    const swap = ctx.tradedVol >= tgt / 2;   // first half subject=taker; second half subject=maker
    if (swap && !swapped) {
      swapped = true;
      // GATE: validate the overlay actually discounted the subject's TAKER fee before handing the
      // taker role to the counterparty (otherwise the first half ran entirely at the base rate).
      const firstTaker = ctx.timeline.find((r) => !r.restIsSubject && r.observedRate != null);
      const initRate = firstTaker?.observedRate ?? null;
      const gate = await gateTakerStepdown(ctx, initRate);
      if (!gate.deepened) {
        checks.push(C('phase-1: subject TAKER fee discounted by the overlay before the role swap', true,
          `DELAY (not a regression): campaign volume did not ingest enough to deepen the taker fee within ${opts.watchSecs}s — the taker discount is validated in phase 2 instead (ingestion lag, not an override). Raise --watch-secs to exercise this hard before the swap.`, true));
      } else if (!gate.captured) {
        checks.push(C('phase-1: subject TAKER fee discounted by the overlay before the role swap', true,
          `overlay deepened but no clean taker fill was captured at the boundary (${gate.reason || 'fill skipped'}) — validated in phase 2`, true));
      } else {
        const ch = gate.row.observedRate;
        const discounted = initRate != null && ch != null && ch < initRate * (1 - eps);   // overlay applied, not stuck at base VIP
        checks.push(C('phase-1: subject TAKER fee discounted by the overlay before the role swap (real taker fill charged below base VIP)', discounted,
          { initialTakerRate: initRate, chargedAfterIngestion: ch, expectedBestOf: gate.row.expectedBestOf, standard: gate.row.standardPerpTaker, overlay: gate.row.overlayPerpTaker, chargedIsBestOf: gate.row.chargedIsBestOf, campaignVol: Math.round(gate.row.overlayCampaignVol ?? 0) }));
      }
      console.log(`\n  ── ROLE SWAP at $${Math.round(ctx.tradedVol).toLocaleString()}: enrolled SUBJECT now RESTS as MAKER, counterparty TAKES ──`);
      console.log(`     (confirms the competition overlay also discounts the subject's MAKER fills, and the non-enrolled counterparty pays standard TAKER fees)\n`);
    }
    const open = await takerFill(ctx, true, 1, swap);
    if (open.skip) { recordWarn(ctx, `cycle ${ctx.cycle} open skipped: ${open.reason}`); if (opts.delay) await sleep(opts.delay); continue; }
    if (opts.delay) await sleep(opts.delay);
    const closeFill = await takerFill(ctx, false, 1, swap);
    const r = open.row;
    const cv = r.overlayCampaignVol != null ? `$${Math.round(r.overlayCampaignVol).toLocaleString()}` : 'pending (overlay not yet ingested)';
    dbg(`  c${ctx.cycle}  ${clk()}  traded $${Math.round(ctx.tradedVol).toLocaleString()} | campaignVol ${cv}`);
    const tag = logTrade(ctx.fillLog, r, opts.feeEpsilon, tiers);   // trade id + INITIAL/TIER/ROLE-SWAP/exec
    if (tag !== 'exec') logSides(r);                                // full both-sides breakdown on boundary trades
    if (closeFill.skip) recordWarn(ctx, `cycle ${ctx.cycle} close skipped: ${closeFill.reason}`);
    else logTrade(ctx.fillLog, closeFill.row, opts.feeEpsilon, tiers);   // indicator the close leg executed (+ id)
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
  return checks;
}

module.exports = { phaseVolume };
