'use strict';
// Build the shared run context: resolve the competition + schedule, fund 2 accounts,
// resolve the market, read the baseline fee tier. Every phase receives this ctx.

const { fetchCompetition, competitionToTiers, fetchSchedule } = require('./lib/competition-api');
const { setupAccount, setupPrefundedAccount } = require('./lib/accounts');
const { loadUsers } = require('./lib/users');
const { resolvePerpMarket, getMarkPrice } = require('./lib/market');
const { getFeeTierEffective } = require('./lib/fees');

async function setup(rl, opts) {
  const comp = await fetchCompetition(rl, opts.base, opts.competition, opts.maxRetries);
  console.log(`Competition "${comp.slug || opts.competition}": status=${comp.status} volume_source=${comp.volume_source} window ${comp.starts_at || '?'} -> ${comp.ends_at || '?'}`);
  console.log(`  participants=${comp.participants_count ?? '?'} total_volume_usd=${comp.total_volume_usd ?? '?'} (refreshed ${comp.last_refreshed_at || '?'})`);
  const startTotalVolume = parseFloat(comp.total_volume_usd || '0') || 0;

  let tiers = competitionToTiers(comp);
  let scheduleSource;
  if (tiers) {
    scheduleSource = `competition.fee_tiers (campaign_volume_req_usd)`;
  } else {
    console.warn('⚠️  competition.fee_tiers is null — falling back to the deployment standard schedule (thresholds will be the standard VIP bands, not campaign bands).');
    tiers = await fetchSchedule(rl, opts.feeTiersUrl, opts.scheduleKey, opts.maxRetries);
    scheduleSource = `${opts.feeTiersUrl} [${opts.scheduleKey}]`;
  }
  console.log(`\nFee schedule (${scheduleSource}):`);
  for (const t of tiers) console.log(`  ${String(t.name).padEnd(8)} perp taker ${(t.takerRate * 100).toFixed(4)}% maker ${(t.makerRate * 100).toFixed(4)}%  volReq $${t.volMin.toLocaleString()}  yellowReq ${t.yellowMin}`);
  if (comp.volume_source && comp.volume_source !== 'perp' && comp.volume_source !== 'spot_perp') {
    console.warn(`⚠️  volume_source=${comp.volume_source}; this script only generates PERP volume.`);
  }
  const tgt = opts.targetVolume != null ? opts.targetVolume : (tiers[Math.min(opts.targetTier, tiers.length - 1)]?.volMin || 0) * 1.05;
  console.log(`\nTarget cumulative subject volume: $${Math.round(tgt).toLocaleString()} (tier index ${opts.targetTier})\n`);

  const makerLabel = opts.makerEnroll ? 'MAKER(liq)' : 'MAKER(liq, NON-ENROLLED)';
  let subject, maker;
  if (opts.accountSource === 'users') {
    console.log(`Loading pre-funded accounts from ${opts.usersFile} (env "${opts.env}", no faucet)...`);
    const users = loadUsers(opts.usersFile);
    if (users.length < 2) throw new Error(`need >= 2 accounts in ${opts.usersFile} (subject + maker); found ${users.length}`);
    if (opts.subjectIndex === opts.makerIndex) throw new Error('--subject-index and --maker-index must differ');
    if (!users[opts.subjectIndex] || !users[opts.makerIndex]) throw new Error(`subject-index ${opts.subjectIndex} / maker-index ${opts.makerIndex} out of range (have ${users.length} accounts)`);
    [subject, maker] = await Promise.all([
      setupPrefundedAccount(rl, opts, 'SUBJECT(taker)', users[opts.subjectIndex], true),
      setupPrefundedAccount(rl, opts, makerLabel, users[opts.makerIndex], opts.makerEnroll),
    ]);
  } else {
    console.log('Funding 2 accounts (faucet)...');
    [subject, maker] = await Promise.all([
      setupAccount(rl, opts, 'SUBJECT(taker)', true),
      setupAccount(rl, opts, makerLabel, opts.makerEnroll),
    ]);
  }

  const mkt = await resolvePerpMarket(rl, opts.tradingBase, opts.market, opts.maxRetries);
  const price = await getMarkPrice(rl, opts.tradingBase, mkt.market, opts.maxRetries);
  console.log(`\nMarket ${mkt.market} (mark ${price}, minNotional ${mkt.minNotional}, tick ${mkt.tickSize})`);
  if (!(price > 0)) { console.error('No mark price.'); process.exit(1); }

  const baseline = await getFeeTierEffective(rl, opts, subject.jwt);
  if (!baseline) { console.error('fee-tier-effective unavailable for the subject account — cannot verify.'); process.exit(1); }
  console.log(`Baseline fee-tier-effective: standard perp taker ${(baseline.standardPerpTaker * 100).toFixed(4)}% (tier ${baseline.standardTier}) | overlay ${baseline.overlayActive ? `ACTIVE [${baseline.overlaySlug}] taker ${(baseline.overlayPerpTaker * 100).toFixed(4)}% campaignVol $${baseline.overlayCampaignVol}` : 'inactive'} | effective taker ${(baseline.effPerpTaker * 100).toFixed(4)}%`);

  if (opts.stdTakerRate == null) opts.stdTakerRate = baseline.standardPerpTaker;
  if (opts.stdMakerRate == null) opts.stdMakerRate = baseline.standardPerpMaker;

  if (!baseline.overlayActive) {
    console.log(`note: overlay not active yet for this fresh account — it switches on after the campaign-volume tracker ingests the first competition volume (~1 min). Trading will trigger it; the run continues.`);
  } else if (baseline.overlaySlug && baseline.overlaySlug !== comp.slug && baseline.overlaySlug !== opts.competition) {
    console.warn(`⚠️  overlay slug "${baseline.overlaySlug}" != competition "${opts.competition}".`);
  }

  const reductionExpected = tiers.some((t) => t.takerRate < (opts.stdTakerRate ?? Infinity) - 1e-9);
  if (!reductionExpected) {
    console.warn(`⚠️  no competition tier's perp taker is below standard ${(opts.stdTakerRate * 100).toFixed(4)}% — best-of keeps standard, so EFFECTIVE won't drop (the overlay tier will still step with volume; that is asserted separately).`);
  }
  console.log('');

  return {
    rl, opts, comp, startTotalVolume, tiers, scheduleSource, tgt, subject, maker, mkt, price, baseline, reductionExpected,
    timeline: [], crossingObs: [], tradedVol: 0, cycle: 0,
    finalEff: null, campaignVol: 0, finalFloor: null, endTotalVolume: startTotalVolume,
    yellowResult: null, spotResult: null, yellowDecreaseResult: null, nonEnrolledResult: null,
  };
}

module.exports = { setup };
