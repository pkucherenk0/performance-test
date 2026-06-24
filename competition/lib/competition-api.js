'use strict';
// The competition fee schedule: live from the public competition endpoint (authoritative),
// with a fallback to the deployment standard schedule when fee_tiers is not yet populated.

const { req, getJson } = require('./http');

// Fetch the fee-tiers page and pull the embedded RSC schedule array.
// Returns tiers ascending by perp volume: { name, tier, makerRate, takerRate, volMin, yellowMin }.
async function fetchSchedule(rl, url, scheduleKey, maxRetries) {
  const r = await req(rl, 'GET', url, undefined, { Accept: 'text/html' }, maxRetries);
  const html = (r.text || '').replace(/\\"/g, '"');   // unescape RSC payload quotes
  const m = html.match(new RegExp(`"${scheduleKey}":(\\[.*?\\}\\s*\\])`));
  if (!m) throw new Error(`schedule key "${scheduleKey}" not found at ${url}`);
  const raw = JSON.parse(m[1]);
  const tiers = raw.map((t) => ({
    name: t.tier === 0 ? 'Base' : `VIP${t.tier}`,
    tier: t.tier,
    makerRate: parseFloat(t.perp_maker_bps) / 10000,
    takerRate: parseFloat(t.perp_taker_bps) / 10000,
    volMin: parseFloat(t.perp_volume_usd_min),
    yellowMin: parseFloat(t.yellow_min),
  })).sort((a, b) => a.volMin - b.volMin);
  return tiers;
}

// Public competition endpoint — the AUTHORITATIVE source for the competition fee
// schedule (and its campaign thresholds), plus volume_source / total_volume_usd.
// GET {base}/api/v1/competitions/{slug}
async function fetchCompetition(rl, baseUrl, slug, maxRetries) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/competitions/${encodeURIComponent(slug)}`;
  const r = await getJson(rl, url, {}, maxRetries);
  if (!r.ok || !r.body || typeof r.body !== 'object') throw new Error(`competition fetch failed (${r.httpStatus}): ${JSON.stringify(r.body)}`);
  return r.body;
}

// Map competition fee_tiers[] -> unified tier shape. Keyed off campaign_volume_req_usd.
// Returns null when fee_tiers is absent/empty (field is null until business supplies it).
function competitionToTiers(comp) {
  const ft = comp?.fee_tiers;
  if (!Array.isArray(ft) || ft.length === 0) return null;
  return ft.map((t) => ({
    name: t.tier_name || (t.tier_level === 0 ? 'Base' : `Tier${t.tier_level}`),
    tier: t.tier_level,
    makerRate: parseFloat(t.perp_maker_bps) / 10000,
    takerRate: parseFloat(t.perp_taker_bps) / 10000,
    volMin: parseFloat(t.campaign_volume_req_usd),
    yellowMin: parseFloat(t.campaign_yellow_req),
  })).sort((a, b) => a.volMin - b.volMin);
}

module.exports = { fetchSchedule, fetchCompetition, competitionToTiers };
