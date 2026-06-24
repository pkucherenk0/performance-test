'use strict';
// Spot helpers used by the spot-sanity and YELLOW-drain phases.

const { getJson, postJson } = require('./http');

// GET /spot/account/market-fee-rate — authoritative effective SPOT maker/taker rate.
async function getSpotFeeRate(rl, opts, jwt, appSessionId, market) {
  const url = `${opts.tradingBase.replace(/\/$/, '')}/spot/account/market-fee-rate?app_session_id=${encodeURIComponent(appSessionId)}&market=${encodeURIComponent(market)}`;
  const r = await getJson(rl, url, { Authorization: `Bearer ${jwt}` }, opts.maxRetries);
  const row = Array.isArray(r.body) ? r.body[0] : r.body;
  if (!row || row.taker_fee_rate == null) return null;
  return { makerRate: parseFloat(row.maker_fee_rate), takerRate: parseFloat(row.taker_fee_rate), source: row.source };
}

async function getSpotReferencePrice(rl, opts, market) {
  const root = opts.tradingBase.replace(/\/$/, '');
  const ob = await getJson(rl, `${root}/orderbook?symbol=${encodeURIComponent(market)}`, {}, opts.maxRetries);
  const bid = parseFloat(ob.body?.bids?.[0]?.[0]), ask = parseFloat(ob.body?.asks?.[0]?.[0]);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  const tk = await getJson(rl, `${root}/ticker/24hr?symbol=${encodeURIComponent(market)}`, {}, opts.maxRetries);
  const last = parseFloat(tk.body?.last);
  return (Number.isFinite(last) && last > 0) ? last : 0;
}

// POST /spot/order (market or limit). Returns order_uuid.
async function createSpotOrder(rl, opts, jwt, appSessionId, o) {
  const url = `${opts.tradingBase.replace(/\/$/, '')}/spot/order`;
  const body = { app_session_id: appSessionId, market: o.market, side: o.side, type: o.type, amount: o.amount };
  if (o.price) body.price = o.price;
  if (o.tif) body.time_in_force = o.tif;
  const r = await postJson(rl, url, body, { Authorization: `Bearer ${jwt}` }, opts.maxRetries);
  return { ok: r.ok && !!r.body?.order_uuid, httpStatus: r.httpStatus, orderUuid: r.body?.order_uuid || null, error: r.ok ? null : (r.body?.error || `HTTP_${r.httpStatus}`), message: r.body?.message };
}

// GET /spot/trades — count recent fills (no per-fill fee field on spot trades).
async function countSpotTrades(rl, opts, jwt, appSessionId, market) {
  const url = `${opts.tradingBase.replace(/\/$/, '')}/spot/trades?app_session_id=${encodeURIComponent(appSessionId)}&market=${encodeURIComponent(market)}&page_size=100`;
  const r = await getJson(rl, url, { Authorization: `Bearer ${jwt}` }, opts.maxRetries);
  return Array.isArray(r.body?.trades) ? r.body.trades.length : 0;
}

// GET /spot/account — available balance for one asset on the spot account.
async function getSpotAssetBalance(rl, opts, jwt, appSessionId, asset) {
  const url = `${opts.tradingBase.replace(/\/$/, '')}/spot/account?app_session_id=${encodeURIComponent(appSessionId)}&asset=${encodeURIComponent(asset)}`;
  const r = await getJson(rl, url, { Authorization: `Bearer ${jwt}` }, opts.maxRetries);
  const b = (r.body?.balances || []).find((x) => x.asset_symbol === asset);
  return b ? parseFloat(b.available_balance || '0') : 0;
}

module.exports = { getSpotFeeRate, getSpotReferencePrice, createSpotOrder, countSpotTrades, getSpotAssetBalance };
