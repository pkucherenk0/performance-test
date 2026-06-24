'use strict';
// Perp market metadata (lot/tick/min-notional), pricing (mark + top of book), order sizing, and order creation.

const { getJson, postJson } = require('./http');

function findFilter(sym, type) {
  const f = (sym.filters || []).find((x) => x.filter_type === type);
  return f ? f.config || {} : {};
}

async function resolvePerpMarket(rl, tradingBase, wanted, maxRetries) {
  const r = await getJson(rl, `${tradingBase.replace(/\/$/, '')}/perpetual/exchangeInfo`, {}, maxRetries);
  const symbols = Array.isArray(r.body?.symbols) ? r.body.symbols : [];
  const trading = symbols.filter((s) => (s.status || '').toUpperCase() === 'TRADING');
  const chosen = trading.find((s) => s.symbol === wanted) || symbols.find((s) => s.symbol === wanted) || trading[0] || symbols[0];
  if (!chosen) return { market: wanted, amountPrecision: 3, pricePrecision: 2, stepSize: 0.001, minQty: 0, minNotional: 0, resolved: false };
  const lot = findFilter(chosen, 'LOT_SIZE');
  const notional = findFilter(chosen, 'MIN_NOTIONAL');
  const priceF = findFilter(chosen, 'PRICE_FILTER');
  return {
    market: chosen.symbol,
    amountPrecision: Number.isFinite(chosen.amount_precision) ? chosen.amount_precision : 3,
    pricePrecision: Number.isFinite(chosen.price_precision) ? chosen.price_precision : 2,
    stepSize: parseFloat(lot.step_size || '') || Math.pow(10, -(chosen.amount_precision || 3)),
    tickSize: parseFloat(priceF.tick_size || '') || 0.01,
    minQty: parseFloat(lot.min_qty || '') || 0,
    minNotional: parseFloat(notional.min_notional || '') || 0,
    resolved: chosen.symbol === wanted,
  };
}

async function getMarkPrice(rl, tradingBase, market, maxRetries) {
  const root = tradingBase.replace(/\/$/, '');
  const all = await getJson(rl, `${root}/perpetual/funding-rates/current?symbols=${encodeURIComponent(market)}`, {}, maxRetries);
  const rates = all.body?.funding_rates || all.body?.fundingRates || [];
  const entry = Array.isArray(rates) ? rates.find((r) => r.market === market) : null;
  let mark = parseFloat(entry?.mark_price || entry?.markPrice || '');
  if (Number.isFinite(mark) && mark > 0) return mark;
  const one = await getJson(rl, `${root}/perpetual/funding-rate/${encodeURIComponent(market)}`, {}, maxRetries);
  mark = parseFloat(one.body?.current_funding_rate?.mark_price || '');
  return (Number.isFinite(mark) && mark > 0) ? mark : 0;
}

// GET /orderbook?symbol= — perp top of book (same endpoint serves spot + perp).
// Returns { bestBid, bestAsk } (0 when a side is empty/unavailable).
async function getPerpTopOfBook(rl, opts, market) {
  const root = opts.tradingBase.replace(/\/$/, '');
  const ob = await getJson(rl, `${root}/orderbook?symbol=${encodeURIComponent(market)}`, {}, opts.maxRetries);
  const bestBid = parseFloat(ob.body?.bids?.[0]?.[0]);
  const bestAsk = parseFloat(ob.body?.asks?.[0]?.[0]);
  return { bestBid: Number.isFinite(bestBid) ? bestBid : 0, bestAsk: Number.isFinite(bestAsk) ? bestAsk : 0 };
}

const decimalsOf = (step) => { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; };

function sizeAmount(notionalUsd, price, mkt) {
  const step = mkt.stepSize > 0 ? mkt.stepSize : Math.pow(10, -(mkt.amountPrecision || 3));
  const decimals = Math.max(decimalsOf(step), mkt.amountPrecision || 0);
  const minNotional = mkt.minNotional > 0 ? mkt.minNotional * 1.05 : 0;
  let qty = Math.max(notionalUsd, minNotional) / price;
  qty = Math.ceil(qty / step) * step;
  if (mkt.minQty > 0 && qty < mkt.minQty) qty = mkt.minQty;
  while (mkt.minNotional > 0 && qty * price < mkt.minNotional) qty += step;
  return qty.toFixed(decimals);
}

const roundTick = (price, tick, dp) => (Math.round(price / tick) * tick).toFixed(dp);

async function createOrder(rl, opts, jwt, appSessionId, o) {
  const url = `${opts.tradingBase.replace(/\/$/, '')}/perpetual/order`;
  const body = {
    app_session_id: appSessionId, market: o.market, side: o.side, direction: o.direction,
    type: o.type, amount: o.amount, reduce_only: !!o.reduceOnly, leverage: String(opts.leverage),
  };
  if (o.price) body.price = o.price;
  if (o.tif) body.time_in_force = o.tif;
  const r = await postJson(rl, url, body, { Authorization: `Bearer ${jwt}` }, opts.maxRetries);
  return { ok: r.ok && !!r.body?.order_uuid, httpStatus: r.httpStatus, orderUuid: r.body?.order_uuid || null, error: r.ok ? null : (r.body?.error || `HTTP_${r.httpStatus}`), message: r.body?.message };
}

// POST /perpetual/positions/close — batch market-IOC close every open position leg (reduce_only per
// leg). Optional `market` scopes it. The endpoint caps at 50 legs/request and sets partial=true when
// more remain, so we loop until nothing is left. Returns { ok, submitted, error }.
async function closeAllPositions(rl, opts, jwt, appSessionId, market) {
  const url = `${opts.tradingBase.replace(/\/$/, '')}/perpetual/positions/close`;
  let submitted = 0;
  for (let round = 0; round < 20; round++) {
    const body = { app_session_id: appSessionId };
    if (market) body.market = market;
    const r = await postJson(rl, url, body, { Authorization: `Bearer ${jwt}` }, opts.maxRetries);
    if (!r.ok) return { ok: false, submitted, error: r.body?.error || r.body?.message || `HTTP_${r.httpStatus}` };
    submitted += r.body?.positions_submitted || 0;
    if (!r.body?.partial) break;   // keep going while the 50-leg cap left more
  }
  return { ok: true, submitted };
}

module.exports = { resolvePerpMarket, getMarkPrice, getPerpTopOfBook, sizeAmount, roundTick, createOrder, closeAllPositions };
