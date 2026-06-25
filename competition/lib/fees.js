'use strict';
// Fee readback: the authoritative best-of resolution endpoint + per-fill charged-fee lookups.

const { getJson, sleep } = require('./http');

const bps = (v) => (v == null ? null : parseFloat(v) / 10000);

// GET {tradingBase}/account/fee-tier-effective (JWT-scoped) — the AUTHORITATIVE
// best-of resolution: standard VIP tier, competition overlay (with the per-participant
// campaign_volume_usd accumulator), and the effective (charged) rates.
async function getFeeTierEffective(rl, opts, jwt) {
  const url = `${opts.tradingBase.replace(/\/$/, '')}/account/fee-tier-effective`;
  const r = await getJson(rl, url, { Authorization: `Bearer ${jwt}` }, opts.maxRetries);
  const b = r.body;
  if (!r.ok || !b || !b.effective) return null;
  const o = b.overlay || {};
  return {
    standardPerpTaker: bps(b.standard?.perp_taker_bps),
    standardPerpMaker: bps(b.standard?.perp_maker_bps),
    standardSpotTaker: bps(b.standard?.spot_taker_bps),
    standardSpotMaker: bps(b.standard?.spot_maker_bps),
    standardTier: b.standard?.fee_tier,
    standardYellow: parseFloat(b.standard?.yellow_balance || '0') || 0,
    overlayActive: !!o.active,
    overlaySlug: o.slug || null,
    overlayCampaignVol: o.active ? (parseFloat(o.campaign_volume_usd || '0') || 0) : null,
    overlayCampaignYellow: o.active ? (parseFloat(o.campaign_yellow_balance || '0') || 0) : null,
    overlayPerpTaker: o.active ? bps(o.perp_taker_bps) : null,
    overlayPerpMaker: o.active ? bps(o.perp_maker_bps) : null,
    overlaySpotTaker: o.active ? bps(o.spot_taker_bps) : null,
    overlaySpotMaker: o.active ? bps(o.spot_maker_bps) : null,
    effPerpTaker: bps(b.effective.perp_taker_bps),
    effPerpMaker: bps(b.effective.perp_maker_bps),
    effSpotTaker: bps(b.effective.spot_taker_bps),
    effSpotMaker: bps(b.effective.spot_maker_bps),
    raw: b,
  };
}

// Blend fills for one order_uuid. A single order can fill across BOTH roles — e.g. a limit that
// partially crosses the spread takes some liquidity (taker) before the remainder rests (maker). The
// blended effRate then mixes two fee schedules and is NOT a valid single-role rate. So we also split
// notional/fee by is_maker and expose role-pure rates: assert the maker side on makerEffRate (the
// maker slice only) and the taker side on takerEffRate; mixedRoles flags an order that did both.
// Returns { notional, fee, effRate, isMaker, fills, makerEffRate, takerEffRate, mixedRoles, ... }.
async function getFillForOrder(rl, opts, jwt, appSessionId, market, orderUuid) {
  const url = `${opts.tradingBase.replace(/\/$/, '')}/perpetual/trades?app_session_id=${encodeURIComponent(appSessionId)}&market=${encodeURIComponent(market)}&page_size=100`;
  const r = await getJson(rl, url, { Authorization: `Bearer ${jwt}` }, opts.maxRetries);
  const trades = Array.isArray(r.body?.trades) ? r.body.trades : [];
  const mine = trades.filter((t) => t.order_uuid === orderUuid);
  if (mine.length === 0) return null;
  let notional = 0, fee = 0, isMaker = false;
  let mkNotional = 0, mkFee = 0, mkFills = 0, tkNotional = 0, tkFee = 0, tkFills = 0;
  for (const t of mine) {
    const n = parseFloat(t.amount) * parseFloat(t.price);
    const f = parseFloat(t.fee);
    notional += n; fee += f;
    if (t.is_maker) { isMaker = true; mkNotional += n; mkFee += f; mkFills++; }
    else { tkNotional += n; tkFee += f; tkFills++; }
  }
  // Per-fill trade ids that composed this order's fill (best-effort across field names); the
  // order_uuid is always present and is the primary trade identifier we surface in logs.
  const tradeIds = mine.map((t) => t.trade_id ?? t.id ?? t.uuid ?? t.trade_uuid ?? null).filter((x) => x != null).map(String);
  return {
    notional, fee, effRate: notional > 0 ? fee / notional : 0, isMaker, fills: mine.length, orderUuid, tradeIds,
    makerEffRate: mkNotional > 0 ? mkFee / mkNotional : null,
    takerEffRate: tkNotional > 0 ? tkFee / tkNotional : null,
    makerFills: mkFills, takerFills: tkFills, mixedRoles: mkFills > 0 && tkFills > 0,
  };
}

async function waitForFill(rl, opts, jwt, appSessionId, market, orderUuid) {
  const deadline = Date.now() + opts.fillTimeoutMs;
  while (Date.now() < deadline) {
    const f = await getFillForOrder(rl, opts, jwt, appSessionId, market, orderUuid);
    if (f) return f;
    await sleep(500);
  }
  return null;
}

module.exports = { getFeeTierEffective, getFillForOrder, waitForFill };
