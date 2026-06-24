'use strict';
// Assertion + formatting primitives shared by every phase.
//
// A "check" is { name, pass, detail, info }. info:true checks NEVER fail the run — they are
// observational (endpoint-lag notes, skipped paths). The runner tallies pass/fail; see report.js.

// concise check constructor
const C = (name, pass, detail, info) => ({ name, pass, detail, info: !!info });

// rate -> percent string ("0.0350%"), or "-" when absent
const pct = (v) => (v == null ? '-' : (v * 100).toFixed(4) + '%');

// Print a fill's TAKER and MAKER fees on separate, aligned lines, labelled with which account
// (subject vs counterparty) played each role this fill. Maker shows the charged rate when a real
// maker fill was captured, otherwise the expected effective maker rate + a "no fill" note.
function logSides(r) {
  const takerWho = r.restIsSubject ? 'counterparty' : 'subject     ';   // who TOOK this fill
  const makerWho = r.restIsSubject ? 'subject     ' : 'counterparty';   // who RESTED this fill
  console.log(`      taker [${takerWho}]  charged  ${pct(r.observedRate)}  = min(std ${pct(r.standardPerpTaker)}, overlay ${pct(r.overlayPerpTaker)})  [endpoint eff ${pct(r.effPerpTaker)}]  ${r.chargedIsBestOf ? 'OK' : 'FAIL'}`);
  if (r.makerObservedRate != null) {
    console.log(`      maker [${makerWho}]  charged  ${pct(r.makerObservedRate)}  = min(std ${pct(r.makerStandardPerpMaker)}, overlay ${pct(r.makerOverlayPerpMaker)})  ${r.makerChargedIsBestOf ? 'OK' : 'FAIL'}`);
  } else {
    console.log(`      maker [${makerWho}]  expected ${pct(r.makerExpectedBestOf)}  = min(std ${pct(r.makerStandardPerpMaker)}, overlay ${pct(r.makerOverlayPerpMaker)})  (no maker fill this cycle — taker matched other book liquidity)`);
  }
}

// Lag-tolerant band check: every charged rate must sit inside [min(expected), max(expected)]
// (epsilon-expanded). At a tier transition the fee-tier-effective snapshot leads/trails the live
// charge by ~1 fill, so a single fill can be charged the ADJACENT tier's rate — that rate is still
// one of the expected values seen across the series, so the band tolerates it (a true mis-charge
// would fall outside both tiers).
function bandCheck(name, rows, rateOf, expOf, eps) {
  const exp = rows.map(expOf).filter((v) => v != null);
  if (!rows.length || !exp.length) return C(name, true, 'no captured fills for this role', true);
  const lo = Math.min(...exp) * (1 - eps), hi = Math.max(...exp) * (1 + eps);
  const bad = rows.filter((r) => { const v = rateOf(r); return v == null || v < lo || v > hi; });
  return C(name, bad.length === 0, bad.length ? bad.map((r) => ({ cycle: r.cycle, phase: r.phase, charged: rateOf(r), expected: expOf(r) })) : `${rows.length} fills within [${lo.toFixed(6)}, ${hi.toFixed(6)}]`);
}

module.exports = { C, pct, logSides, bandCheck };
