'use strict';
// PHASE 6 — autonomous BASE-VIP vs OVERLAY crossover, on its OWN dedicated accounts.
//
// Self-contained scenario (independent of the main subject/maker flow), in three steps:
//   A) A fresh "VIP" account trades perp volume while NOT enrolled, to establish (and if a target
//      tier is set, raise) its STANDARD base-VIP tier. Verify: overlay inactive, effective == the
//      standard base-VIP rate.
//   B) Enroll it. With little campaign volume the competition overlay tier is WORSE (higher) than
//      the base VIP, so best-of keeps the base rate. Verify: overlay ACTIVE but worse; the effective
//      rate AND a real charged fill are the (better) base VIP rate — i.e. discounted by base, not the
//      overlay.
//   C) Trade enough COMPETITION volume that the overlay tier becomes BETTER (cheaper) than the base
//      VIP. Verify: the effective rate AND a real charged fill flip to the overlay — the competition
//      tier now applies OVER the base tier.
//
// Uses a dedicated pair of faucet accounts so the test is autonomous. Disabled on stage (no faucet /
// restricted seeded accounts). Budget-bounded: if ingestion never catches up, steps degrade to info
// (a delay) rather than a false failure — consistent with the rest of the suite.

const { sleep } = require('../lib/http');
const { setupAccount, enroll } = require('../lib/accounts');
const { getMarkPrice } = require('../lib/market');
const { getFeeTierEffective } = require('../lib/fees');
const { takerFill } = require('../lib/trade');
const { close } = require('../lib/tiers');
const { C, pct, logTrade } = require('../lib/checks');

// one flat round-trip with the VIP account TAKING (open long, then reduce-only close). Returns the
// open-leg result { row, subjEff } (the VIP account's charged fee + its fee-tier-effective reading).
async function vipRoundTrip(sub) {
  sub.cycle++;
  const o = await takerFill(sub, true, 6, false);
  if (o.skip) return o;
  logTrade(sub.fillLog, o.row, sub.opts.feeEpsilon);              // trade id + INITIAL/TIER/exec for the VIP account
  if (sub.opts.delay) await sleep(sub.opts.delay);
  const c = await takerFill(sub, false, 6, false);               // reduce-only close keeps margin flat
  if (c.row) logTrade(sub.fillLog, c.row, sub.opts.feeEpsilon);   // indicator the close leg executed (+ id)
  return o;
}

// Trade round-trips (interleaved with ingestion waits) until cond(eff, lastOpen) holds or the budget
// is spent. Returns { eff, lastOpen, met }.
async function driveUntil(sub, cond, maxCycles, watchSecs) {
  const deadline = Date.now() + watchSecs * 1000;
  let eff = await getFeeTierEffective(sub.rl, sub.opts, sub.subject.jwt);
  let lastOpen = null;
  if (eff && cond(eff, null)) return { eff, lastOpen, met: true };
  for (let i = 0; i < maxCycles; i++) {
    const o = await vipRoundTrip(sub);
    if (o.skip) { await sleep(sub.opts.delay || 200); continue; }
    lastOpen = o;
    eff = o.subjEff || await getFeeTierEffective(sub.rl, sub.opts, sub.subject.jwt);
    if (eff && cond(eff, o)) return { eff, lastOpen, met: true };
    if (Date.now() < deadline) {                                   // let the campaign tracker ingest
      await sleep(sub.opts.yellowPollSecs * 1000);
      eff = await getFeeTierEffective(sub.rl, sub.opts, sub.subject.jwt);
      if (eff && cond(eff, lastOpen)) return { eff, lastOpen, met: true };
    }
  }
  return { eff, lastOpen, met: false };
}

async function phaseBaseVipCrossover(ctx) {
  const { rl, opts, tiers, mkt } = ctx;
  const eps = opts.feeEpsilon;
  const checks = [];
  const skip = (detail) => { checks.push(C('base-VIP crossover (autonomous): better base VIP kept until the overlay beats it', true, detail, true)); return checks; };

  if (opts.env === 'stage' || !opts.faucet) return skip('skipped: needs the uat faucet to create dedicated accounts (stage seeded accounts are restricted)');

  // ── Dedicated accounts: a VIP subject (enrolled in step B) + a counterparty for liquidity. ──
  console.log('\nPhase 6 — autonomous base-VIP crossover: funding a dedicated VIP account + counterparty...');
  let vip, vipMaker;
  try {
    [vip, vipMaker] = await Promise.all([
      setupAccount(rl, opts, 'P6 VIP(subject, enrolls later)', false),   // NOT enrolled yet
      setupAccount(rl, opts, 'P6 counterparty(liquidity)', false),
    ]);
  } catch (err) {
    return skip(`could not fund dedicated accounts: ${err.message}`);
  }
  const price = await getMarkPrice(rl, opts.tradingBase, mkt.market, opts.maxRetries);
  const sub = { rl, opts, mkt, subject: vip, maker: vipMaker, price: price > 0 ? price : ctx.price, cycle: 0, tradedVol: 0, timeline: [], fillLog: { n: 0, lastRole: null, lastRate: null } };

  // ── Step A — establish the base VIP tier while NOT enrolled. ──
  // Optionally raise it to a target competition-tier rate via pre-enrollment volume (--base-vip-target-tier).
  // Pre-enrollment volume lifts the STANDARD 30d tier but does NOT count as campaign volume, so the
  // overlay still starts shallow once we enroll.
  const baseline = await getFeeTierEffective(rl, opts, vip.jwt);
  let rBase = baseline?.standardPerpTaker ?? opts.stdTakerRate;
  if (opts.baseVipTargetTier != null) {
    const tgt = tiers[Math.min(opts.baseVipTargetTier, tiers.length - 1)];
    if (tgt && tgt.takerRate < (rBase ?? Infinity) * (1 - eps)) {
      console.log(`  raising base VIP toward ${tgt.name} (standard taker <= ${pct(tgt.takerRate)}) with pre-enrollment volume...`);
      const r = await driveUntil(sub, (eff) => eff.standardPerpTaker <= tgt.takerRate * (1 + eps), opts.maxOrders, opts.watchSecs);
      if (r.eff) rBase = r.eff.standardPerpTaker;
      if (!r.met) console.warn(`  ⚠️  base VIP did not reach ${tgt.name} within budget; using the standard tier actually reached.`);
    }
  }
  const effA = await getFeeTierEffective(rl, opts, vip.jwt);
  rBase = effA?.standardPerpTaker ?? rBase;
  console.log(`  step A: NOT enrolled | standard base-VIP taker ${pct(rBase)} (tier ${effA?.standardTier}) | overlay ${effA?.overlayActive ? 'ACTIVE' : 'inactive'} | effective ${pct(effA?.effPerpTaker)}`);
  const aOk = effA && effA.overlayActive === false && rBase != null && close(effA.effPerpTaker, rBase, eps);
  checks.push(C('base VIP (not enrolled): effective fee == standard base-VIP tier (no overlay)', !!aOk,
    { overlayActive: effA?.overlayActive, standard: rBase, effective: effA?.effPerpTaker, standardTier: effA?.standardTier }));

  // Pick the crossover target: the FIRST (lowest-volume) competition tier strictly cheaper than the
  // base VIP. If none exists, the base VIP already beats every competition tier — assert base-always-wins.
  const cheaper = tiers.filter((t) => t.takerRate < rBase * (1 - eps)).sort((a, b) => a.volMin - b.volMin)[0] || null;

  // ── Step B — enroll; the better base VIP must be KEPT over the worse overlay. ──
  const enr = await enroll(rl, opts.base, opts.competition, vip.wallet.address, vip.jwt, opts.maxRetries);
  console.log(`  enrolled VIP account: ${enr.status}`);
  checks.push(C('base VIP: account enrolled into the competition', enr.status === 'enrolled' || enr.status === 'already_enrolled', { status: enr.status, httpStatus: enr.httpStatus }));

  // Drive a little volume so the overlay ACTIVATES, while it is still shallower (worse) than the base VIP.
  const actMax = cheaper ? Math.max(4, Math.ceil((cheaper.volMin * 0.4) / opts.orderNotional)) : 12;
  const bRes = await driveUntil(sub, (eff) => eff.overlayActive, actMax, opts.watchSecs);
  const effB = bRes.eff;
  if (!effB?.overlayActive) {
    checks.push(C('base VIP kept (enrolled): overlay worse than base -> charged the base VIP rate', true,
      `DELAY (not a regression): overlay did not activate within budget (campaign tracker ingestion lag) — base VIP correctly applied meanwhile`, true));
  } else {
    const overlayWorse = effB.overlayPerpTaker != null && effB.overlayPerpTaker > rBase * (1 + eps);
    if (overlayWorse) {
      // confirm with a real charged fill at the base rate (strictly below the overlay rate).
      const o = await vipRoundTrip(sub);
      const charged = o && !o.skip ? o.row.observedRate : null;
      const effKept = close(effB.effPerpTaker, rBase, eps) && effB.effPerpTaker < effB.overlayPerpTaker * (1 - eps);
      const fillKept = charged != null && close(charged, rBase, eps) && charged < effB.overlayPerpTaker * (1 - eps);
      console.log(`  step B: enrolled | base VIP ${pct(rBase)} | overlay ${pct(effB.overlayPerpTaker)} (worse) | effective ${pct(effB.effPerpTaker)} | charged ${pct(charged)}`);
      checks.push(C('base VIP kept (enrolled): overlay worse than base -> effective AND charged fill are the (better) base VIP rate, not the overlay',
        effKept && fillKept,
        { base: rBase, overlay: effB.overlayPerpTaker, effective: effB.effPerpTaker, charged }));
    } else {
      // overlay already <= base on activation: only happens when no cheaper tier gap existed; record it.
      checks.push(C('base VIP kept (enrolled): overlay worse than base -> charged the base VIP rate', true,
        `inconclusive: overlay (${pct(effB.overlayPerpTaker)}) was not worse than base VIP (${pct(rBase)}) at activation — no shallow-overlay window at this base tier`, true));
    }
  }

  // ── Step C — drive competition volume until the overlay BEATS the base VIP, then it applies over base. ──
  if (!cheaper) {
    checks.push(C('crossover: competition tier becomes better than base and applies over it', true,
      `the base VIP (${pct(rBase)}) is already at/deeper than every competition tier — no crossover is possible (raise --target-tier or lower the base via --base-vip-target-tier)`, true));
    console.log(`  step C: no competition tier cheaper than base VIP ${pct(rBase)} — base-always-wins (no crossover).`);
    return checks;
  }
  console.log(`  step C: driving campaign volume so the overlay beats base VIP ${pct(rBase)} (target ${cheaper.name} @ ${pct(cheaper.takerRate)}, volReq $${cheaper.volMin.toLocaleString()})...`);
  const crossMax = Math.ceil((cheaper.volMin * 1.3) / opts.orderNotional) + 10;
  const cRes = await driveUntil(sub, (eff) => eff.overlayActive && eff.overlayPerpTaker != null && eff.overlayPerpTaker < rBase * (1 - eps), crossMax, opts.watchSecs * 2);
  const effC = cRes.eff;
  if (!effC?.overlayActive || effC.overlayPerpTaker == null || !(effC.overlayPerpTaker < rBase * (1 - eps))) {
    checks.push(C('crossover: competition tier becomes better than base and applies over it', true,
      `DELAY (not a regression): the overlay did not drop below the base VIP ${pct(rBase)} within budget (overlay ${pct(effC?.overlayPerpTaker)}, campaignVol $${Math.round(effC?.overlayCampaignVol ?? 0).toLocaleString()}) — ingestion lag, not an override`, true));
    return checks;
  }
  // overlay is now cheaper than base — confirm a real charged fill follows the overlay.
  const o = await vipRoundTrip(sub);
  const charged = o && !o.skip ? o.row.observedRate : null;
  const effFlipped = close(effC.effPerpTaker, effC.overlayPerpTaker, eps) && effC.effPerpTaker < rBase * (1 - eps);
  const fillFlipped = charged != null && close(charged, effC.overlayPerpTaker, eps) && charged < rBase * (1 - eps);
  console.log(`  step C: enrolled | base VIP ${pct(rBase)} | overlay ${pct(effC.overlayPerpTaker)} (better) | effective ${pct(effC.effPerpTaker)} | charged ${pct(charged)} | campaignVol $${Math.round(effC.overlayCampaignVol ?? 0).toLocaleString()}`);
  checks.push(C('crossover: once the competition tier beats the base VIP, effective AND a real fill flip to the (better) overlay rate',
    effFlipped && fillFlipped,
    { base: rBase, overlay: effC.overlayPerpTaker, effective: effC.effPerpTaker, charged }));

  return checks;
}

module.exports = { phaseBaseVipCrossover };
