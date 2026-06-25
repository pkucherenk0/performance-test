'use strict';
// The shared per-fill primitive: one market-vs-limit match, recording BOTH sides' charged fees.

const { sleep } = require('./http');
const { getMarkPrice, getPerpTopOfBook, sizeAmount, roundTick, createOrder } = require('./market');
const { getFeeTierEffective, getFillForOrder, waitForFill } = require('./fees');
const { close } = require('./tiers');
const { recordWarn } = require('./checks');

// One round of a market-vs-limit match. By default the enrolled SUBJECT takes (market) and the
// counterparty rests (maker). swap=true FLIPS the roles so we also observe the enrolled subject's
// MAKER fee and the counterparty's TAKER fee. Overlay/campaign fields in the row are ALWAYS read
// from the enrolled subject (the participant we track) regardless of which role it played, while
// the taker/maker rate fields reflect whoever actually filled each side. Mutates ctx (price,
// tradedVol, timeline); returns { fill, row, subjEff, makerFill } or { skip, reason }.
async function takerFill(ctx, subjBuys, phase = 1, swap = false) {
  const { rl, opts, mkt, subject, maker } = ctx;
  const takerAcct = swap ? maker : subject;   // sends the market order
  const restAcct  = swap ? subject : maker;   // rests the limit (the "maker")
  const refresh = await getMarkPrice(rl, opts.tradingBase, mkt.market, opts.maxRetries);
  if (refresh > 0) ctx.price = refresh;
  const price = ctx.price;
  const amount = sizeAmount(opts.orderNotional, price, mkt);
  // Rest the maker ONE TICK INSIDE THE SPREAD so it becomes the best price on its side and is
  // the GUARANTEED counterparty for the market order. The book is populated, so a quote away from
  // the touch (the old price*1.001) gets swept over — the taker matches other liquidity and the
  // maker never fills (or fills blended maker+taker when its order crosses). Posting at
  // best-bid+tick / best-ask-tick stays passive (no cross) yet sits at the front of the queue.
  // taker buys -> maker rests a SELL (new best ask); taker sells -> maker rests a BID (new best bid).
  //
  // Positions are HEDGE-mode (long/short legs tracked separately). To keep round-trips FLAT — so
  // margin is freed instead of piling up — the open and close legs trade the SAME direction and the
  // close sets reduce_only (per the perp docs: "set direction to the leg you are trading and use
  // reduce_only to close"). The TAKER always works the LONG leg, the resting MAKER the SHORT leg:
  //   open  (subjBuys=true):  taker buy/long,  maker sell/short        (reduce_only=false)
  //   close (subjBuys=false): taker sell/long, maker buy/short, reduce_only=true  -> flattens both
  const isClose = !subjBuys;
  const makerSide = subjBuys ? 'sell' : 'buy';
  const makerDir = 'short';     // maker holds the SHORT leg across the open+close pair
  const takerDir = 'long';      // taker holds the LONG leg across the open+close pair
  const tick = mkt.tickSize > 0 ? mkt.tickSize : 0.01;
  const { bestBid, bestAsk } = await getPerpTopOfBook(rl, opts, mkt.market);
  let makerPxNum;
  if (bestBid > 0 && bestAsk > bestBid + tick / 2) {
    makerPxNum = subjBuys
      ? Math.max(bestAsk - tick, bestBid + tick)   // best ask, still strictly above best bid
      : Math.min(bestBid + tick, bestAsk - tick);  // best bid, still strictly below best ask
  } else {
    makerPxNum = subjBuys ? price * 1.001 : price * 0.999;   // book empty/1-tick spread -> mark-relative fallback
  }
  const makerPrice = roundTick(makerPxNum, mkt.tickSize, mkt.pricePrecision);
  const m = await createOrder(rl, opts, restAcct.jwt, restAcct.appSessionId, { market: mkt.market, side: makerSide, direction: makerDir, type: 'limit', amount, price: makerPrice, tif: 'gtc', reduceOnly: isClose });
  if (!m.ok) return { skip: true, reason: `maker limit rejected: ${m.error} ${m.message || ''}` };
  await sleep(300);

  // authoritative resolution BOTH role-players SHOULD be charged right now (read at fill time)
  const takerEff = await getFeeTierEffective(rl, opts, takerAcct.jwt);
  const restEff  = await getFeeTierEffective(rl, opts, restAcct.jwt);
  const subjEff  = swap ? restEff : takerEff;   // the enrolled subject's resolution, role-independent

  const s = await createOrder(rl, opts, takerAcct.jwt, takerAcct.appSessionId, { market: mkt.market, side: subjBuys ? 'buy' : 'sell', direction: takerDir, type: 'market', amount, reduceOnly: isClose });
  if (!s.ok) return { skip: true, reason: `taker market rejected: ${s.error} ${s.message || ''}` };
  const fill = await waitForFill(rl, opts, takerAcct.jwt, takerAcct.appSessionId, mkt.market, s.orderUuid);
  if (!fill) return { skip: true, reason: 'no taker fill visible (book/cross issue)' };
  ctx.tradedVol += fill.notional;

  // maker side: the resting limit just got hit -> read its maker fill + expected maker rate.
  // One short retry recovers trades that simply hadn't propagated on the first read (lag, not a missed match).
  let makerFill = await getFillForOrder(rl, opts, restAcct.jwt, restAcct.appSessionId, mkt.market, m.orderUuid);
  if (!makerFill) { await sleep(500); makerFill = await getFillForOrder(rl, opts, restAcct.jwt, restAcct.appSessionId, mkt.market, m.orderUuid); }

  // best-of of the COMPONENT tiers (standard, overlay-if-active) for each side. The matching engine
  // charges this in real time; the endpoint's own `effective` field can lag behind it.
  // Role-pure charged rates. An order that fills across both roles (a limit that partially crosses
  // the spread) blends two fee schedules in effRate; assert each side on its OWN slice so a partial
  // cross doesn't pollute the other side's rate. The taker market order is pure taker, but fall back
  // symmetrically. A mixed maker order is expected behaviour, not a bug — surface it as a warning.
  const takerRate = fill.takerEffRate ?? fill.effRate;
  const makerRate = makerFill ? (makerFill.makerEffRate ?? makerFill.effRate) : null;
  if (makerFill?.mixedRoles) recordWarn(ctx, `cycle ${ctx.cycle} maker order ${m.orderUuid.slice(0, 10)} partially crossed (${makerFill.makerFills} maker + ${makerFill.takerFills} taker fills) — measuring the maker slice only`);

  const expectedBestOf = takerEff ? (takerEff.overlayActive ? Math.min(takerEff.standardPerpTaker, takerEff.overlayPerpTaker) : takerEff.standardPerpTaker) : null;
  const chargedIsBestOf = takerEff && expectedBestOf != null && close(takerRate, expectedBestOf, opts.feeEpsilon);
  const chargedMatchesEffField = takerEff && close(takerRate, takerEff.effPerpTaker, opts.feeEpsilon);
  const effFieldIsBestOf = takerEff && expectedBestOf != null && close(takerEff.effPerpTaker, expectedBestOf, opts.feeEpsilon);
  const makerExpectedMaker = restEff ? (restEff.overlayActive ? Math.min(restEff.standardPerpMaker, restEff.overlayPerpMaker) : restEff.standardPerpMaker) : null;
  const makerChargedIsBestOf = makerFill && makerExpectedMaker != null && close(makerRate, makerExpectedMaker, opts.feeEpsilon);

  const row = {
    cycle: ctx.cycle, phase, subjBuys, swap, restIsSubject: swap,
    subjRole: swap ? 'maker' : 'taker',
    subjRate: swap ? makerRate : takerRate,
    subjExpectedBestOf: swap ? makerExpectedMaker : expectedBestOf,
    isMaker: fill.isMaker, fillNotional: Math.round(fill.notional), fee: fill.fee,
    // taker side (whoever took)
    observedRate: takerRate, takerMixedRoles: !!fill.mixedRoles,
    effPerpTaker: takerEff?.effPerpTaker ?? null, standardPerpTaker: takerEff?.standardPerpTaker ?? null,
    takerOverlayActive: takerEff?.overlayActive ?? null, overlayPerpTaker: takerEff?.overlayPerpTaker ?? null,
    expectedBestOf, chargedIsBestOf, chargedMatchesEffField, effFieldIsBestOf,
    // maker side (whoever rested)
    makerFee: makerFill?.fee ?? null,
    makerObservedRate: makerRate,
    makerMixedRoles: !!makerFill?.mixedRoles,
    makerIsMaker: makerFill?.isMaker ?? null,
    makerFillNotional: makerFill ? Math.round(makerFill.notional) : null,
    makerStandardPerpMaker: restEff?.standardPerpMaker ?? null,
    makerOverlayActive: restEff?.overlayActive ?? null,
    makerOverlayPerpMaker: restEff?.overlayPerpMaker ?? null,
    makerExpectedBestOf: makerExpectedMaker, makerChargedIsBestOf,
    // enrolled-subject overlay/campaign fields (ALWAYS the subject, independent of role)
    overlayActive: subjEff?.overlayActive ?? null, overlayPerpTaker_subject: subjEff?.overlayPerpTaker ?? null,
    overlayCampaignVol: subjEff?.overlayCampaignVol ?? null, overlaySlug: subjEff?.overlaySlug ?? null,
    // trade identifiers: per-side order_uuid + underlying fill trade ids. subj* point at whichever
    // order the enrolled subject placed this fill (taker order when it took, maker order when it rested).
    takerOrderUuid: s.orderUuid, makerOrderUuid: m.orderUuid,
    takerTradeIds: fill?.tradeIds ?? [], makerTradeIds: makerFill?.tradeIds ?? [],
    subjOrderUuid: swap ? m.orderUuid : s.orderUuid,
    subjTradeIds: swap ? (makerFill?.tradeIds ?? []) : (fill?.tradeIds ?? []),
  };
  ctx.timeline.push(row);
  return { fill, row, subjEff, makerFill };
}

module.exports = { takerFill };
