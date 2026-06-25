'use strict';
// Assertion + formatting primitives shared by every phase.
//
// A "check" is { name, pass, detail, info }. info:true checks NEVER fail the run — they are
// observational (endpoint-lag notes, skipped paths). The runner tallies pass/fail; see report.js.

// concise check constructor
const C = (name, pass, detail, info) => ({ name, pass, detail, info: !!info });

// rate -> percent string ("0.0350%"), or "-" when absent
const pct = (v) => (v == null ? '-' : (v * 100).toFixed(4) + '%');

// relative wall-clock since process start ("t+12.4s") — for latency analysis on every fill/poll line
const RUN_T0 = Date.now();
const clk = () => `t+${((Date.now() - RUN_T0) / 1000).toFixed(1)}s`;

// short id for logs (first 10 chars), or em-dash when absent
const sid = (id) => (id == null ? '—' : String(id).slice(0, 10));

// Verbosity. Default OFF -> the run reads like a test report: phase headers, result/summary lines,
// meaningful tier/role transitions, warnings, and the final assertions. --debug turns ON the full
// per-fill firehose (every routine fill + both-sides breakdown + per-cycle/poll progress lines).
// dbg(...) is for that debug-only noise; phase headers and results stay on plain console.log.
let VERBOSE = false;
const setVerbose = (v) => { VERBOSE = !!v; };
const isVerbose = () => VERBOSE;
const dbg = (...args) => { if (VERBOSE) console.log(...args); };

// best-effort map a charged rate to a schedule tier name on the matching side (taker/maker),
// used only to annotate TIER-change lines. Returns null when nothing matches within eps.
function tierNameForRate(tiers, rate, role, eps) {
  if (!Array.isArray(tiers) || rate == null) return null;
  const t = tiers.find((x) => { const r = role === 'maker' ? x.makerRate : x.takerRate; return r != null && Math.abs(r - rate) <= Math.abs(rate || 1) * eps; });
  return t ? t.name : null;
}

// Record + print a standout warning (skips, anomalies, lag notes). Carried on ctx.warnings and
// summarised at the end by report(), so silent skips can no longer hide behind ALL CHECKS PASSED.
function recordWarn(ctx, msg) {
  if (!ctx.warnings) ctx.warnings = [];
  const line = `${clk()}  ${msg}`;
  ctx.warnings.push(line);
  console.warn(`  ⚠️  ${line}`);
}

// id label for a row side: "<order_uuid> fill <first trade id>"
const idLabel = (orderUuid, tradeIds) => `${sid(orderUuid)} fill ${tradeIds && tradeIds.length ? sid(tradeIds[0]) : '—'}`;

// Stateful per-fill trade logger (one line per executed fill, ALWAYS carrying a trade id). state is a
// plain object carried on ctx (ctx.fillLog) so tier/role transitions are detected across the run.
// Tags the fill from the ENROLLED SUBJECT's perspective:
//   INITIAL   — the first fill seen (the initial trade)
//   TIER a->b — the subject's charged rate moved beyond eps from the previous fill (fee tier changed)
//   ROLE-SWAP — the subject switched taker<->maker (rate basis changed, not a tier change)
//   exec      — routine fill; just the "it executed" indicator
// Returns the tag (normalised to 'exec' for routine fills) so callers can print the full breakdown
// (logSides) only on the boundary trades.
function logTrade(state, r, eps, tiers) {
  // Segment tag state per phase: the first fill of each phase is INITIAL, and TIER/ROLE transitions
  // are detected only WITHIN a phase — so a phase boundary never mislabels a fill against the
  // previous phase's last (different-role/rate) fill.
  if (state.phase !== r.phase) { state.phase = r.phase; state.n = 0; state.lastRole = null; state.lastRate = null; }
  const role = r.subjRole;                         // 'taker' | 'maker'
  const rate = r.subjRate;                         // subject's charged rate this fill (role-correct)
  const leg = r.subjBuys ? 'open ' : 'close';
  let tag;
  if (!state.n) tag = 'INITIAL';
  else if (role !== state.lastRole) tag = 'ROLE-SWAP';
  else if (rate != null && state.lastRate != null && Math.abs(rate - state.lastRate) > Math.abs(state.lastRate) * eps) {
    const nm = tierNameForRate(tiers, rate, role, eps);
    const cv = r.overlayCampaignVol != null ? ` @ campaignVol $${Math.round(r.overlayCampaignVol).toLocaleString()}` : '';
    tag = `TIER ${pct(state.lastRate)}->${pct(rate)}${nm ? ` (${nm})` : ''}${cv}`;
  } else tag = 'exec';
  state.n = (state.n || 0) + 1;
  state.lastRole = role;
  if (rate != null) state.lastRate = rate;
  const boundary = tag.startsWith('TIER') || tag === 'INITIAL' || tag === 'ROLE-SWAP';
  // boundary trades (the fee-regime transitions — the story of the run) always print; routine
  // 'exec' fills are debug-only noise.
  if (boundary || VERBOSE) console.log(`      ${clk()}  [trade ${idLabel(r.subjOrderUuid, r.subjTradeIds)}] ${tag}  subject ${role} ${leg} charged ${pct(rate)}`);
  return boundary ? tag : 'exec';
}

// Print a fill's TAKER and MAKER fees on separate, aligned lines, labelled with which account
// (subject vs counterparty) played each role this fill. Maker shows the charged rate when a real
// maker fill was captured, otherwise the expected effective maker rate + a "no fill" note.
function logSides(r) {
  if (!VERBOSE) return;                                                  // both-sides breakdown is debug-only
  const takerWho = r.restIsSubject ? 'counterparty' : 'subject     ';   // who TOOK this fill
  const makerWho = r.restIsSubject ? 'subject     ' : 'counterparty';   // who RESTED this fill
  console.log(`      taker [${takerWho}]  charged  ${pct(r.observedRate)}  = min(std ${pct(r.standardPerpTaker)}, overlay ${pct(r.overlayPerpTaker)})  [endpoint eff ${pct(r.effPerpTaker)}]  ${r.chargedIsBestOf ? 'OK' : 'FAIL'}  trade ${idLabel(r.takerOrderUuid, r.takerTradeIds)}`);
  if (r.makerObservedRate != null) {
    console.log(`      maker [${makerWho}]  charged  ${pct(r.makerObservedRate)}  = min(std ${pct(r.makerStandardPerpMaker)}, overlay ${pct(r.makerOverlayPerpMaker)})  ${r.makerChargedIsBestOf ? 'OK' : 'FAIL'}  trade ${idLabel(r.makerOrderUuid, r.makerTradeIds)}`);
  } else {
    console.log(`      maker [${makerWho}]  expected ${pct(r.makerExpectedBestOf)}  = min(std ${pct(r.makerStandardPerpMaker)}, overlay ${pct(r.makerOverlayPerpMaker)})  (no maker fill this cycle — taker matched other book liquidity)  order ${sid(r.makerOrderUuid)}`);
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

module.exports = { C, pct, clk, sid, idLabel, tierNameForRate, recordWarn, setVerbose, isVerbose, dbg, logTrade, logSides, bandCheck };
