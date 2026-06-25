'use strict';
// PHASE 6 — BASE-VIP-vs-OVERLAY CROSSOVER (best-of from the "standard is better" side).
//
// A participant whose STANDARD VIP tier is already better (cheaper) than the competition's shallow
// overlay tier must keep paying its STANDARD rate after enrolling — joining a competition can only
// ever HELP, never make fees worse. The overlay takes over ONLY once campaign volume deepens it
// BELOW the standard rate. This is the inverse of the base-VIP-override bug (which wrongly applied
// base VIP over a BETTER competition discount); here we verify a BETTER base VIP is correctly KEPT
// over a WORSE overlay, then yields to the overlay at the crossover.
//
// The enrolled SUBJECT is exactly such a user: at enrollment its standard taker (e.g. 0.0350%) beats
// the competition's base overlay tier (e.g. 0.0400%), so best-of charges the standard rate while the
// overlay is active-but-shallow, then flips to the overlay once campaign volume makes it cheaper. We
// assert on the fills already recorded for the subject — deterministic, no extra accounts to fund.
//
// Disabled on stage (--env stage): seeded accounts carry uncontrolled standard tiers, so the regime
// boundaries here are not reliable; this phase needs the fresh, known-baseline uat accounts. (Wired
// off in run.js; this guard is a backstop in case it is invoked directly.)

const { C, pct } = require('../lib/checks');
const { close } = require('../lib/tiers');

async function phaseBaseVipCrossover(ctx) {
  const { opts } = ctx;
  const eps = opts.feeEpsilon;
  const checks = [];

  if (opts.env === 'stage') {
    checks.push(C('base-VIP crossover: better base VIP kept until the overlay beats it', true, 'skipped on stage (seeded accounts carry uncontrolled standard tiers)', true));
    return checks;
  }

  // Subject TAKER fills only (restIsSubject=false): rows where the enrolled subject took, so
  // observedRate is the subject's charged taker fee and standard/overlay are its own components.
  const rows = ctx.timeline.filter((r) => !r.restIsSubject && r.observedRate != null && r.standardPerpTaker != null);
  if (!rows.length) {
    checks.push(C('base-VIP crossover: better base VIP kept until the overlay beats it', true, 'no subject taker fills captured', true));
    return checks;
  }

  // Regime A — overlay ACTIVE but WORSE (higher) than standard: best-of must charge the STANDARD rate
  // (the better base VIP), strictly below the overlay rate (the overlay is NOT applied here).
  const worseOverlay = rows.filter((r) => r.takerOverlayActive && r.overlayPerpTaker != null && r.overlayPerpTaker > r.standardPerpTaker * (1 + eps));
  if (worseOverlay.length) {
    const bad = worseOverlay.filter((r) => !(close(r.observedRate, r.standardPerpTaker, eps) && r.observedRate < r.overlayPerpTaker * (1 - eps)));
    checks.push(C('base-VIP kept: while the active overlay is worse than standard, the subject is charged its (better) standard rate, not the overlay',
      bad.length === 0,
      bad.length ? bad.map((r) => ({ cycle: r.cycle, charged: r.observedRate, standard: r.standardPerpTaker, overlay: r.overlayPerpTaker }))
                 : `${worseOverlay.length} fills charged the better base VIP (standard) while the overlay was shallower`));
  } else {
    checks.push(C('base-VIP kept: while the active overlay is worse than standard, the subject is charged its (better) standard rate, not the overlay', true,
      'no fills observed with an active overlay worse than standard (the campaign overlay was never shallower than the base VIP in this run)', true));
  }

  // No-harm invariant — across ALL subject taker fills, the charged fee never EXCEEDS the standard
  // rate at fill time. Enrolling is strictly non-worsening: best-of guarantees min(standard, overlay).
  const worsened = rows.filter((r) => r.observedRate > r.standardPerpTaker * (1 + eps));
  checks.push(C('no-harm: enrolling never charged the subject ABOVE its standard base-VIP rate (best-of is a floor)',
    worsened.length === 0,
    worsened.length ? worsened.map((r) => ({ cycle: r.cycle, charged: r.observedRate, standard: r.standardPerpTaker })) : `${rows.length} subject taker fills <= standard`));

  // Crossover — once the overlay became BETTER (cheaper) than standard, a real fill followed the
  // OVERLAY rate (the competition tier took over). Required only if the run actually reached a
  // campaign tier cheaper than the subject's standard tier.
  const betterOverlay = rows.filter((r) => r.takerOverlayActive && r.overlayPerpTaker != null && r.overlayPerpTaker < r.standardPerpTaker * (1 - eps));
  if (betterOverlay.length) {
    const tookOver = betterOverlay.some((r) => close(r.observedRate, r.overlayPerpTaker, eps) && r.observedRate < r.standardPerpTaker * (1 - eps));
    const last = betterOverlay[betterOverlay.length - 1];
    checks.push(C('crossover: once the overlay beat the base VIP, a real fill was charged the (better) overlay rate',
      tookOver,
      { betterOverlayFills: betterOverlay.length, sampleCharged: betterOverlay.map((r) => r.observedRate).slice(0, 5), standardAtCross: last.standardPerpTaker, overlayAtCross: last.overlayPerpTaker }));
  } else {
    checks.push(C('crossover: once the overlay beat the base VIP, a real fill was charged the (better) overlay rate', true,
      'the campaign overlay never became cheaper than the subject standard tier in this run (raise volume / target tier to exercise the crossover)', true));
  }

  const aMin = worseOverlay.length ? Math.min(...worseOverlay.map((r) => r.observedRate)) : null;
  const bMin = betterOverlay.length ? Math.min(...betterOverlay.map((r) => r.observedRate)) : null;
  console.log(`\nPhase 6 — base-VIP vs overlay crossover: ${worseOverlay.length} fills with overlay WORSE than base VIP (charged base VIP ${pct(aMin)}), ${betterOverlay.length} fills with overlay BETTER (charged overlay ${pct(bMin)}).`);

  return checks;
}

module.exports = { phaseBaseVipCrossover };
