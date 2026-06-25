'use strict';
// PHASE 2 — capture fills CHARGED at the deepened tier on BOTH sides, then run all perp-volume
// assertions. The per-account engine tier refreshes on the ~1-min tracker, so after a fresh
// crossing we (1) round-trip as taker until the charged rate reaches the deepened best-of, then
// (2) take confirmation fills as subject-taker AND subject-maker, then re-read the authoritative
// floor (phase-2 volume may deepen the tier further than the end-of-phase-1 snapshot).

const { sleep, getJson } = require('../lib/http');
const { getFeeTierEffective } = require('../lib/fees');
const { fetchCompetition } = require('../lib/competition-api');
const { expectedCompTier, close, floorEff } = require('../lib/tiers');
const { C, pct, logTrade, logSides, bandCheck, dbg } = require('../lib/checks');
const { takerFill } = require('../lib/trade');

async function phaseMarkerFills(ctx) {
  const { rl, opts, mkt, subject } = ctx;
  const eps = opts.feeEpsilon;
  let finalEff = ctx.finalEff;
  // Did the per-account engine reach the deepened overlay rate within the catch-up window?
  // Used by the base-VIP regression guard below to tell a genuine ingestion DELAY (engine never
  // caught up) apart from an OVERRIDE (engine had time, discount available, base VIP persisted).
  let engineCaughtUp = false;
  if (finalEff?.overlayActive && opts.markerFills > 0) {
    const deepenedTaker = floorEff(finalEff);                                                   // expected deepened taker best-of
    const deepenedMakerTarget = finalEff.overlayActive ? Math.min(finalEff.standardPerpMaker, finalEff.overlayPerpMaker) : finalEff.standardPerpMaker;
    console.log(`\nPhase 2: capture fills CHARGED at the deepened tier (expect taker ${pct(deepenedTaker)}, subject maker ${pct(deepenedMakerTarget)}).`);
    // Round-trip as taker until the CHARGED rate reaches the deepened best-of (engine caught up),
    // bounded by --watch-secs. After the role swap the subject stopped taking before the overlay
    // deepened, so the first taker fills here can still be charged the previous tier.
    console.log(`  Waiting for the matching engine to catch up to the ingested campaign volume...`);
    const deadline = Date.now() + opts.watchSecs * 1000;
    let attempts = 0;
    while (!engineCaughtUp && Date.now() < deadline && ctx.cycle < opts.maxOrders) {
      ctx.cycle++; attempts++;
      const o = await takerFill(ctx, true, 2, false);
      if (o.skip) { console.warn(`  catch-up ${attempts} skipped: ${o.reason}`); await sleep(opts.delay || 200); continue; }
      if (opts.delay) await sleep(opts.delay);
      const c = await takerFill(ctx, false, 2, false);
      dbg(`  catch-up ${attempts}  campaignVol ${o.row.overlayCampaignVol != null ? '$' + Math.round(o.row.overlayCampaignVol).toLocaleString() : 'pending'}`);
      { const tg = logTrade(ctx.fillLog, o.row, eps); if (tg !== 'exec') logSides(o.row); }
      if (c.row) logTrade(ctx.fillLog, c.row, eps);
      engineCaughtUp = close(o.row.observedRate, deepenedTaker, eps) || (c.row && close(c.row.observedRate, deepenedTaker, eps));
      if (!engineCaughtUp) { dbg(`  engine not caught up (charged ${pct(o.row.observedRate)} vs deepened ${pct(deepenedTaker)}); waiting ${opts.yellowPollSecs}s...`); await sleep(opts.yellowPollSecs * 1000); }
    }
    if (!engineCaughtUp) console.warn(`  ⚠️  engine did not reach the deepened taker rate within ${opts.watchSecs}s; phase-2 assertions will reflect the lag.`);

    // Confirmation marker fills at the deepened tier — BOTH sides: subject TAKER (overlay taker) and
    // subject MAKER (overlay maker), so the deepened tier is proven from both sides for the subject.
    console.log(`\n  Confirmation marker round-trips at the deepened tier (subject taker + subject maker):`);
    for (let i = 0; i < opts.markerFills && ctx.cycle < opts.maxOrders; i++) {
      ctx.cycle++;
      const ot = await takerFill(ctx, true, 2, false);          // subject takes
      if (!ot.skip && opts.delay) await sleep(opts.delay);
      if (!ot.skip) await takerFill(ctx, false, 2, false);
      ctx.cycle++;
      const om = await takerFill(ctx, true, 2, true);           // subject rests (maker), counterparty takes
      if (!om.skip && opts.delay) await sleep(opts.delay);
      if (!om.skip) await takerFill(ctx, false, 2, true);
      dbg(`  m${i + 1}:`);
      if (!ot.skip) { const tg = logTrade(ctx.fillLog, ot.row, eps); if (tg !== 'exec') logSides(ot.row); }
      if (!om.skip) { const tg = logTrade(ctx.fillLog, om.row, eps); if (tg !== 'exec') logSides(om.row); }
      if (opts.delay) await sleep(opts.delay);
    }
  }

  // Phase-2 trading (catch-up + confirmation) adds volume and can deepen the subject's tier FURTHER
  // than the end-of-phase-1 snapshot (which lagged behind ingestion). RE-READ the authoritative
  // resolution so finalFloor / campaign volume reflect the DEEPEST tier actually reached across
  // phases 1+2 — otherwise the deeper phase-2 fills look like "stacking" below a stale shallower floor.
  const finalReRead = await getFeeTierEffective(rl, opts, subject.jwt);
  if (finalReRead && finalReRead.overlayActive) {
    finalEff = finalReRead;
    ctx.finalEff = finalReRead;
    if ((finalReRead.overlayCampaignVol ?? 0) > (ctx.campaignVol ?? 0)) ctx.campaignVol = finalReRead.overlayCampaignVol;
    console.log(`\nFinal authoritative reading after phase 2: campaign_volume_usd $${Math.round(ctx.campaignVol).toLocaleString()} | overlay taker ${pct(finalReRead.overlayPerpTaker)} | effective taker ${pct(finalReRead.effPerpTaker)} | deepest best-of ${pct(floorEff(finalReRead))}`);
  }

  const checks = [];
  const filledRows = ctx.timeline.filter((r) => r.effPerpTaker != null);
  // Subject taker-rate assertions only see rows where the ENROLLED SUBJECT actually TOOK (first half +
  // phase 2). After the role swap the subject rests as maker and the taker is the non-enrolled
  // counterparty, whose standard taker rate must NOT be mixed into the subject's step-down series.
  const subjTakerRows = filledRows.filter((r) => !r.restIsSubject);
  // Maker-side rows split by which account rested (overlay schedule vs standard schedule).
  const subjMakerRows  = ctx.timeline.filter((r) => r.restIsSubject && r.makerObservedRate != null && r.makerIsMaker === true);
  const otherMakerRows = ctx.timeline.filter((r) => !r.restIsSubject && r.makerObservedRate != null && r.makerIsMaker === true);

  // The matching engine's CHARGED fee is ground truth. The fee-tier-effective endpoint
  // lags it in BOTH directions at a tier transition (its standard/overlay/effective fields
  // can each trail the live charge by ~1-2 fills), so every HARD check is anchored to
  // charged fees + the final settled reading — never to a single per-fill snapshot.
  //
  // Deepest legit best-of = min(standard, overlay-at-the-qualified-tier). Derive it from BOTH the
  // endpoint's overlay field AND the schedule-qualified overlay tier (tiers + final campaign volume),
  // then take the DEEPER: the endpoint's overlayPerpTaker can still trail the schedule-qualified tier
  // after a fresh crossing. Both inputs are legitimately-qualified rates (never charged-fee-derived),
  // so taking the min can't mask a true stacking under-charge — it only stops a stale shallow snapshot
  // from flagging the genuinely-deeper qualified fills.
  const endpointFloor = finalEff ? floorEff(finalEff) : null;
  const qualOverlay = finalEff && finalEff.overlayActive ? expectedCompTier(ctx.tiers, ctx.campaignVol).takerRate : null;
  const stdTakerNow = finalEff?.standardPerpTaker ?? opts.stdTakerRate ?? null;
  const scheduleFloor = qualOverlay != null && stdTakerNow != null ? Math.min(stdTakerNow, qualOverlay) : null;
  const floorCandidates = [endpointFloor, scheduleFloor].filter((v) => v != null);
  const finalFloor = floorCandidates.length ? Math.min(...floorCandidates) : null;
  ctx.finalFloor = finalFloor;
  const chargedRates = subjTakerRows.map((r) => r.observedRate);
  const firstCharged = chargedRates.length ? chargedRates[0] : null;
  const bestCharged = chargedRates.length ? Math.min(...chargedRates) : null;

  // (a) NO STACKING: no subject taker fill charged below the deepest best-of the subject reached.
  const undercut = finalFloor != null ? subjTakerRows.filter((r) => r.observedRate < finalFloor * (1 - eps)) : [];
  checks.push(C('no stacking: no subject taker fill charged below the deepest best-of reached', undercut.length === 0, undercut.length ? undercut.map((r) => ({ cycle: r.cycle, phase: r.phase, charged: r.observedRate, finalFloor })) : `${subjTakerRows.length} subject taker fills >= deepest best-of ${finalFloor}`));

  // (a2) every subject taker fee within the legit band [deepest best-of, initial rate] (rates only fall with volume).
  const outOfBand = subjTakerRows.filter((r) => firstCharged != null && finalFloor != null && (r.observedRate > firstCharged * (1 + eps) || r.observedRate < finalFloor * (1 - eps)));
  checks.push(C('every subject taker fee within [deepest best-of, initial rate]', outOfBand.length === 0, outOfBand.length ? outOfBand.map((r) => ({ cycle: r.cycle, charged: r.observedRate })) : `band [${finalFloor}, ${firstCharged}]`));

  // (a3) INFO: per-fill charged == the snapshot best-of read just before the order — fragile at
  //      transitions because the endpoint lags the live charge (NOT a stacking signal).
  const snapMatch = filledRows.filter((r) => r.chargedIsBestOf).length;
  checks.push(C('per-fill charged == snapshot min(standard, overlay) (endpoint lags at transitions)', snapMatch === filledRows.length, `${snapMatch}/${filledRows.length} matched (mismatch = stale snapshot vs live charge at a tier change)`, true));

  // (a4) INFO: actual fee vs the endpoint's effective display field.
  const effFieldMatch = filledRows.filter((r) => r.chargedMatchesEffField).length;
  checks.push(C('actual fee == endpoint effective field (display field, lags)', effFieldMatch === filledRows.length, `${effFieldMatch}/${filledRows.length} matched`, true));

  // (m1) COUNTERPARTY MAKER SIDE: the non-enrolled counterparty's maker fills follow the STANDARD
  //      maker schedule (no overlay) — band-tolerant against the single-fill tier-transition lag.
  checks.push(bandCheck('counterparty maker fills charged the standard maker schedule', otherMakerRows, (r) => r.makerObservedRate, (r) => r.makerExpectedBestOf, eps));

  // (m2) SUBJECT MAKER SIDE (post-swap): the enrolled subject's maker fills are charged its own
  //      best-of maker rate (overlay applies to the maker side too) — the "both sides" verification.
  checks.push(bandCheck('subject maker fills charged min(standard, overlay) maker rate (overlay applies to maker side)', subjMakerRows, (r) => r.makerObservedRate, (r) => r.makerExpectedBestOf, eps));

  // (m3) SUBJECT MAKER DISCOUNT: when the overlay maker rate is cheaper than standard, the subject's
  //      maker fee must actually be the (lower) overlay rate — proves the overlay discounts the maker side.
  if (subjMakerRows.length) {
    const ovM = subjMakerRows.map((r) => r.makerOverlayPerpMaker).filter((v) => v != null).pop() ?? null;
    const stdM = opts.stdMakerRate;
    const overlayCheaperMaker = ovM != null && stdM != null && ovM < stdM * (1 - eps);
    if (overlayCheaperMaker) {
      const bestSubjMaker = Math.min(...subjMakerRows.map((r) => r.makerObservedRate).filter((v) => v != null));
      const discounted = Number.isFinite(bestSubjMaker) && close(bestSubjMaker, ovM, eps);
      checks.push(C('subject MAKER fee discounted by the overlay (overlay maker rate applied, < standard maker)', discounted, { bestSubjectMakerCharged: bestSubjMaker, overlayMaker: ovM, standardMaker: stdM }));
    } else {
      checks.push(C('subject MAKER fee discounted by the overlay', true, `inconclusive: overlay maker (${ovM}) not cheaper than standard maker (${stdM}) — best-of keeps standard for the maker side`, true));
    }
  } else {
    checks.push(C('subject MAKER fee discounted by the overlay', true, 'no subject-as-maker fills captured (role swap produced no clean maker fill)', true));
  }

  // (m4) COUNTERPARTY TAKER SIDE (post-swap): the rows where the subject rested and the counterparty
  //      took. Charged on its OWN schedule (standard, no overlay when non-enrolled) — band-tolerant.
  const otherTakerRows = filledRows.filter((r) => r.restIsSubject);
  if (otherTakerRows.length) {
    checks.push(bandCheck('counterparty taker fills charged its own taker schedule', otherTakerRows, (r) => r.observedRate, (r) => r.expectedBestOf, eps));
    if (!opts.makerEnroll) {
      const noOverlay = otherTakerRows.every((r) => !r.takerOverlayActive);
      checks.push(C('counterparty taker fills: competition overlay NOT applied (non-enrolled gets standard taker)', noOverlay, noOverlay ? `${otherTakerRows.length} counterparty taker fills, overlay inactive` : otherTakerRows.filter((r) => r.takerOverlayActive).map((r) => ({ cycle: r.cycle }))));
    }
  } else {
    checks.push(C('counterparty taker fills charged its own taker schedule', true, 'no counterparty-as-taker fills captured (role swap produced no clean taker fill)', true));
  }

  // (b2) endpoint effective field settles to best-of on the FINAL reading.
  const finalBestOf = finalEff != null && close(finalEff.effPerpTaker, finalFloor, eps);
  checks.push(C('endpoint effective settles to min(standard, overlay) on final reading', finalBestOf, finalEff ? { effective: finalEff.effPerpTaker, standard: finalEff.standardPerpTaker, overlay: finalEff.overlayPerpTaker, expected: finalFloor } : 'no final reading'));

  // (b3) INFO: endpoint internal consistency per fill (field lags its own standard/overlay inputs).
  const effConsistent = filledRows.filter((r) => r.effFieldIsBestOf).length;
  checks.push(C('endpoint effective field == min(standard, overlay) per fill (lags)', effConsistent === filledRows.length, `${effConsistent}/${filledRows.length} consistent`, true));

  // (c) overlay activates once campaign volume is ingested and is active at the end (warm-up expected).
  const firstActiveIdx = filledRows.findIndex((r) => r.overlayActive);
  const warmupFills = firstActiveIdx < 0 ? filledRows.length : firstActiveIdx;
  const overlayEndActive = !!finalEff?.overlayActive;
  checks.push(C('overlay activates after volume ingestion and is active at end', overlayEndActive, `overlay activated after ${warmupFills} warm-up fills (campaign-tracker ingestion lag); active at end: ${overlayEndActive}`));

  // (d) the subject's CHARGED taker rate is non-increasing as volume grows (the real "fee drops with volume" signal).
  let monotone = true, prev = Infinity;
  for (const r of subjTakerRows) { if (r.observedRate > prev * (1 + eps) + 1e-12) monotone = false; prev = Math.min(prev, r.observedRate); }
  checks.push(C('subject charged taker rate non-increasing as volume grows', monotone));

  // (d2) OBSERVED step-down on real fills: the best charged rate dropped below the initial rate and
  //      reached the deepest best-of. Required only when a reduction is realizable.
  const reductionRealizable = finalFloor != null && firstCharged != null && finalFloor < firstCharged * (1 - eps);
  if (reductionRealizable) {
    const observed = bestCharged < firstCharged * (1 - eps) && close(bestCharged, finalFloor, eps);
    checks.push(C('a real fill was charged at the reduced rate after volume grew (observed step-down)', observed, { firstCharged, bestCharged, finalFloor }));
  } else {
    checks.push(C('a real fill was charged at the reduced rate after volume grew (observed step-down)', true, `no reduction realizable at this volume: deepest best-of ${finalFloor} not below initial charged ${firstCharged} (competition rates not cheaper than standard, or volume too low)`, true));
  }

  // (d3) phase-2 subject TAKER reached the deepened best-of — the strongest "reduced fill" proof.
  //      "reached" (not "every"): the catch-up loop's early fills may still be charged the prior
  //      tier while the per-account engine refreshes; the proof is that it DID reach the deepened rate.
  const p2 = subjTakerRows.filter((r) => r.phase === 2);
  if (p2.length > 0 && finalFloor != null) {
    const reached = p2.some((r) => close(r.observedRate, finalFloor, eps));
    checks.push(C('phase-2 subject TAKER fill reached the deepened best-of rate (engine caught up)', reached, { finalFloor, p2TakerCharged: p2.map((r) => r.observedRate) }));
  } else {
    checks.push(C('phase-2 subject TAKER fill reached the deepened best-of rate (engine caught up)', true, 'no phase-2 subject taker fills (--marker-fills 0 or overlay inactive)', true));
  }

  // (d4) phase-2 subject MAKER reached the deepened maker best-of — same proof + same schedule-deeper
  //      floor as the taker side (the endpoint's overlayPerpMaker can trail the qualified tier too).
  const endpointMaker = finalEff && finalEff.overlayActive ? Math.min(finalEff.standardPerpMaker, finalEff.overlayPerpMaker) : (finalEff?.standardPerpMaker ?? null);
  const qualMaker = finalEff && finalEff.overlayActive ? expectedCompTier(ctx.tiers, ctx.campaignVol).makerRate : null;
  const stdMakerNow = finalEff?.standardPerpMaker ?? opts.stdMakerRate ?? null;
  const schedMaker = qualMaker != null && stdMakerNow != null ? Math.min(stdMakerNow, qualMaker) : null;
  const makerCandidates = [endpointMaker, schedMaker].filter((v) => v != null);
  const deepenedMaker = makerCandidates.length ? Math.min(...makerCandidates) : null;
  const p2m = subjMakerRows.filter((r) => r.phase === 2);
  if (p2m.length > 0 && deepenedMaker != null) {
    const reachedM = p2m.some((r) => close(r.makerObservedRate, deepenedMaker, eps));
    checks.push(C('phase-2 subject MAKER fill reached the deepened maker best-of rate (engine caught up)', reachedM, { deepenedMaker, p2MakerCharged: p2m.map((r) => r.makerObservedRate) }));
  } else {
    checks.push(C('phase-2 subject MAKER fill reached the deepened maker best-of rate (engine caught up)', true, 'no phase-2 subject maker fills captured', true));
  }

  // (r1) BASE-VIP OVERRIDE REGRESSION GUARD — timing-independent.
  //
  // The production bug (neodax fee_engine fix #1369) re-published the wallet's STANDARD VIP fee
  // over an active competition session, so the effective rate snapped back to base VIP and the
  // campaign discount was wiped. What was first read as a "delay" was actually this override.
  //
  // This guard isolates the override from a genuine delay using ONE settled endpoint reading and
  // the best-of invariant alone (no dependence on catch-up timing): the effective rate is DEFINED
  // as min(standard, overlay). So if the overlay is active AND strictly cheaper than standard, the
  // effective rate MUST be that cheaper overlay rate. If it instead equals the standard rate, the
  // discount was overridden by base VIP — a true regression, not lag.
  //
  // Benign DELAY is explicitly NOT failed here (it does not satisfy "active cheaper overlay"):
  //   - overlay inactive (campaign volume not ingested yet)        -> base VIP is the correct answer
  //   - overlay active but not cheaper than standard               -> nothing to override
  const stdNow = finalEff?.standardPerpTaker ?? opts.stdTakerRate ?? null;
  const overlayBestOf = finalEff && finalEff.overlayActive ? floorEff(finalEff) : null;
  const discountAvailable = !!finalEff?.overlayActive && overlayBestOf != null && stdNow != null && overlayBestOf < stdNow * (1 - eps);
  if (discountAvailable) {
    const overridden = close(finalEff.effPerpTaker, stdNow, eps) && !close(finalEff.effPerpTaker, overlayBestOf, eps);
    checks.push(C('regression guard: active cheaper overlay is NOT overridden by base VIP (effective == overlay best-of, not standard)', !overridden,
      overridden
        ? { verdict: 'BASE-VIP OVERRIDE — discount wiped by standard VIP rate (regression of fee_engine overlay suppression)', standard: stdNow, overlayBestOf, settledEffective: finalEff.effPerpTaker, campaignVol: Math.round(ctx.campaignVol) }
        : { verdict: 'discount applied', overlayBestOf, settledEffective: finalEff.effPerpTaker, standard: stdNow }));
  } else {
    const why = !finalEff?.overlayActive
      ? `overlay not active yet (campaign volume $${Math.round(ctx.campaignVol).toLocaleString()} not ingested / warm-up) — base VIP is correct here, NOT an override (this is the benign delay path)`
      : `overlay active but its best-of (${pct(overlayBestOf)}) is not cheaper than standard (${pct(stdNow)}) — nothing for base VIP to override`;
    checks.push(C('regression guard: active cheaper overlay is NOT overridden by base VIP (effective == overlay best-of, not standard)', true, why, true));
  }

  // (r2) CHARGED-FEE CONFIRMATION of the same guard, gated on the engine having caught up so a slow
  //      INGESTION delay (engine never reached the deepened rate within --watch-secs) is reported as
  //      info, while a discount that was available + had time to apply but was charged at base VIP fails.
  if (discountAvailable && engineCaughtUp) {
    const realized = bestCharged != null && close(bestCharged, overlayBestOf, eps);
    const stuckAtBase = bestCharged != null && close(bestCharged, stdNow, eps) && !realized;
    checks.push(C('regression guard (charged): a real subject fill was charged the overlay discount, not base VIP', realized && !stuckAtBase,
      { bestChargedSubjectTaker: bestCharged, overlayBestOf, standard: stdNow, verdict: stuckAtBase ? 'BASE-VIP OVERRIDE on charged fee' : (realized ? 'discount charged' : 'neither — see band checks') }));
  } else if (discountAvailable) {
    checks.push(C('regression guard (charged): a real subject fill was charged the overlay discount, not base VIP', true,
      `DELAY (not a regression): engine did not reach the deepened rate within ${opts.watchSecs}s — overlay poll/ingestion lag, the discount was simply not applied yet`, true));
  } else {
    checks.push(C('regression guard (charged): a real subject fill was charged the overlay discount, not base VIP', true, 'no cheaper overlay available to charge (see r1 for classification)', true));
  }

  // (r1m) MAKER-SIDE base-VIP override guard — the mirror of r1 for the maker side, which otherwise
  //       has NO hard best-of invariant (its band check tolerates any in-envelope rate, so a maker
  //       fill charged the higher STANDARD rate while a cheaper overlay was active would slip through).
  //       Timing-independent: when the overlay maker rate is active and strictly cheaper than standard,
  //       the SETTLED maker effective MUST equal the overlay best-of, never the standard maker rate.
  const stdMakerNow2 = finalEff?.standardPerpMaker ?? opts.stdMakerRate ?? null;
  const overlayMakerBestOf = finalEff && finalEff.overlayActive && finalEff.overlayPerpMaker != null && finalEff.standardPerpMaker != null
    ? Math.min(finalEff.standardPerpMaker, finalEff.overlayPerpMaker) : null;
  const makerDiscountAvailable = !!finalEff?.overlayActive && overlayMakerBestOf != null && stdMakerNow2 != null && overlayMakerBestOf < stdMakerNow2 * (1 - eps);
  if (makerDiscountAvailable && finalEff.effPerpMaker != null) {
    const overriddenM = close(finalEff.effPerpMaker, stdMakerNow2, eps) && !close(finalEff.effPerpMaker, overlayMakerBestOf, eps);
    checks.push(C('regression guard (maker): active cheaper overlay maker rate is NOT overridden by base VIP (maker effective == overlay best-of, not standard)', !overriddenM,
      overriddenM
        ? { verdict: 'BASE-VIP OVERRIDE on maker side — overlay maker discount wiped by standard maker rate', standardMaker: stdMakerNow2, overlayMakerBestOf, settledEffectiveMaker: finalEff.effPerpMaker }
        : { verdict: 'maker discount applied', overlayMakerBestOf, settledEffectiveMaker: finalEff.effPerpMaker, standardMaker: stdMakerNow2 }));
  } else {
    const whyM = !finalEff?.overlayActive
      ? `overlay not active yet — base VIP maker rate is correct here (benign delay, not an override)`
      : `overlay active but its maker best-of (${pct(overlayMakerBestOf)}) is not cheaper than standard maker (${pct(stdMakerNow2)}) — nothing for base VIP to override`;
    checks.push(C('regression guard (maker): active cheaper overlay maker rate is NOT overridden by base VIP (maker effective == overlay best-of, not standard)', true, whyM, true));
  }

  // (r2m) CHARGED-FEE confirmation of the maker guard — gated on the engine having caught up, so a
  //       slow ingestion delay is reported as info while a discount that had time to apply but was
  //       charged at the standard maker rate FAILS. Closes the band-tolerance gap on the charged side.
  const bestChargedMaker = subjMakerRows.length ? Math.min(...subjMakerRows.map((r) => r.makerObservedRate).filter((v) => v != null)) : null;
  if (makerDiscountAvailable && engineCaughtUp && bestChargedMaker != null) {
    const realizedM = close(bestChargedMaker, overlayMakerBestOf, eps);
    const stuckAtBaseM = close(bestChargedMaker, stdMakerNow2, eps) && !realizedM;
    checks.push(C('regression guard (maker, charged): a real subject MAKER fill was charged the overlay discount, not base VIP', realizedM && !stuckAtBaseM,
      { bestChargedSubjectMaker: bestChargedMaker, overlayMakerBestOf, standardMaker: stdMakerNow2, verdict: stuckAtBaseM ? 'BASE-VIP OVERRIDE on charged maker fee' : (realizedM ? 'maker discount charged' : 'neither — see band checks') }));
  } else if (makerDiscountAvailable) {
    checks.push(C('regression guard (maker, charged): a real subject MAKER fill was charged the overlay discount, not base VIP', true,
      bestChargedMaker == null ? 'no subject maker fill captured to confirm the charged maker discount (role swap produced no clean maker fill)'
                               : `DELAY (not a regression): engine did not reach the deepened maker rate within ${opts.watchSecs}s — overlay poll/ingestion lag`, true));
  } else {
    checks.push(C('regression guard (maker, charged): a real subject MAKER fill was charged the overlay discount, not base VIP', true, 'no cheaper overlay maker rate available to charge (see r1m for classification)', true));
  }

  // (e) overlay tier rate matches the qualified competition tier at the final campaign volume.
  const qual = ctx.crossingObs.filter((c) => c.isQualified);
  if (qual.length > 0) {
    checks.push(C('overlay tier rate matches qualified competition tier for campaign volume', qual.every((c) => c.pass), qual));
  } else {
    checks.push(C('overlay tier rate matches qualified competition tier for campaign volume', true, `SKIPPED — overlay inactive or no campaign tier reached (campaignVol $${Math.round(ctx.campaignVol).toLocaleString()}); raise volume or use an active edition.`, true));
  }

  // (f) ingestion cross-check: competition total_volume_usd grew.
  const compEnd = await fetchCompetition(rl, opts.base, opts.competition, opts.maxRetries).catch(() => null);
  ctx.endTotalVolume = compEnd ? (parseFloat(compEnd.total_volume_usd || '0') || 0) : ctx.startTotalVolume;
  const volumeDelta = ctx.endTotalVolume - ctx.startTotalVolume;
  checks.push(C('competition total_volume_usd increased (volume ingested)', volumeDelta > 0, { startTotalVolume: ctx.startTotalVolume, endTotalVolume: ctx.endTotalVolume, volumeDelta: Math.round(volumeDelta), tradedVolume: Math.round(ctx.tradedVol), campaignVol: Math.round(ctx.campaignVol) }, true));

  // (g) forward-only: re-read trades; the SUBJECT's earliest fill must read the same fee now.
  //     Match it by its recorded order_uuid — positional trades[length-1] silently picks the WRONG
  //     trade once the subject's trades exceed one page (this run hit 97 vs a 100-page), comparing
  //     against a mid-run fill at a different tier. Request a generous page so the earliest order is
  //     present; if it still isn't, report "not verifiable" (info) rather than asserting on a wrong row.
  let forwardOnly = true, reRead = null, fwInfo = true;
  const firstRow = filledRows.find((r) => !r.restIsSubject && r.takerOrderUuid);   // the first fill the SUBJECT took
  if (firstRow) {
    const url = `${opts.tradingBase.replace(/\/$/, '')}/perpetual/trades?app_session_id=${encodeURIComponent(subject.appSessionId)}&market=${encodeURIComponent(mkt.market)}&page_size=1000`;
    const r = await getJson(rl, url, { Authorization: `Bearer ${subject.jwt}` }, opts.maxRetries);
    const trades = Array.isArray(r.body?.trades) ? r.body.trades : [];
    const firstTradeId = firstRow.takerTradeIds && firstRow.takerTradeIds[0];
    const match = trades.filter((t) => t.order_uuid === firstRow.takerOrderUuid
      || (firstTradeId && String(t.trade_id ?? t.id ?? t.uuid ?? t.trade_uuid ?? '') === firstTradeId));
    if (match.length) {
      const notional = match.reduce((s, t) => s + parseFloat(t.amount) * parseFloat(t.price), 0);
      const fee = match.reduce((s, t) => s + parseFloat(t.fee), 0);
      const rate = notional > 0 ? fee / notional : null;
      forwardOnly = rate != null && close(rate, firstRow.observedRate, eps);
      reRead = { reReadRate: rate, firstObserved: firstRow.observedRate, matchedOrder: firstRow.takerOrderUuid };
      fwInfo = false;   // verifiable -> HARD check
    } else {
      reRead = { note: 'earliest subject order not returned in the trades page — forward-only not verifiable this run', firstOrder: firstRow.takerOrderUuid };
    }
  }
  checks.push(C('forward-only: earliest fill not re-rated after later crossings', forwardOnly, reRead, fwInfo));

  return checks;
}

module.exports = { phaseMarkerFills };
