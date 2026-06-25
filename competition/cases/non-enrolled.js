'use strict';
// NON-ENROLLED counterparty (negative control): the maker never enrolled, so the competition
// overlay must NEVER apply to it — its perp fees must follow the standard schedule only.
// One clean TAKER fill by the maker: the subject posts a resting ask, the maker lifts it.

const { sleep } = require('../lib/http');
const { getMarkPrice, sizeAmount, roundTick, createOrder } = require('../lib/market');
const { getFeeTierEffective, waitForFill } = require('../lib/fees');
const { close } = require('../lib/tiers');
const { C, sid } = require('../lib/checks');

async function phaseNonEnrolled(ctx) {
  const { rl, opts, mkt, subject, maker } = ctx;
  const checks = [];
  const mEff = await getFeeTierEffective(rl, opts, maker.jwt);
  const refresh = await getMarkPrice(rl, opts.tradingBase, mkt.market, opts.maxRetries); if (refresh > 0) ctx.price = refresh;
  const amount = sizeAmount(opts.orderNotional, ctx.price, mkt);
  const askPx = roundTick(ctx.price * 1.001, mkt.tickSize, mkt.pricePrecision);
  const sub = await createOrder(rl, opts, subject.jwt, subject.appSessionId, { market: mkt.market, side: 'sell', direction: 'short', type: 'limit', amount, price: askPx, tif: 'gtc' });
  await sleep(300);
  let mFill = null;
  if (sub.ok) {
    const mk = await createOrder(rl, opts, maker.jwt, maker.appSessionId, { market: mkt.market, side: 'buy', direction: 'long', type: 'market', amount });
    if (mk.ok) mFill = await waitForFill(rl, opts, maker.jwt, maker.appSessionId, mkt.market, mk.orderUuid);
  }
  const nonEnrolledResult = {
    enroll: maker.enroll, overlayActive: mEff?.overlayActive ?? null,
    standardPerpTaker: mEff?.standardPerpTaker ?? null, effPerpTaker: mEff?.effPerpTaker ?? null,
    standardPerpMaker: mEff?.standardPerpMaker ?? null, effPerpMaker: mEff?.effPerpMaker ?? null,
    takerFillRate: mFill?.effRate ?? null, takerFillIsMaker: mFill?.isMaker ?? null,
    takerOrderUuid: mFill?.orderUuid ?? null, takerTradeIds: mFill?.tradeIds ?? [],
  };
  ctx.nonEnrolledResult = nonEnrolledResult;
  console.log(`\nNon-enrolled counterparty (maker): enroll=${maker.enroll} overlayActive=${mEff?.overlayActive} | effective taker ${mEff?.effPerpTaker != null ? (mEff.effPerpTaker * 100).toFixed(4) + '%' : '-'} vs standard ${mEff?.standardPerpTaker != null ? (mEff.standardPerpTaker * 100).toFixed(4) + '%' : '-'} | maker taker fill charged ${mFill?.effRate != null ? (mFill.effRate * 100).toFixed(4) + '%' : 'n/a'}${mFill ? ` | trade ${sid(nonEnrolledResult.takerOrderUuid)} fill ${nonEnrolledResult.takerTradeIds.length ? sid(nonEnrolledResult.takerTradeIds[0]) : '—'}` : ''}`);

  checks.push(C('non-enrolled user: competition overlay NOT active', nonEnrolledResult.overlayActive === false, { enroll: nonEnrolledResult.enroll, overlayActive: nonEnrolledResult.overlayActive }));
  const effEqStd = nonEnrolledResult.effPerpTaker != null && nonEnrolledResult.standardPerpTaker != null
    && close(nonEnrolledResult.effPerpTaker, nonEnrolledResult.standardPerpTaker, opts.feeEpsilon)
    && (nonEnrolledResult.effPerpMaker == null || nonEnrolledResult.standardPerpMaker == null || close(nonEnrolledResult.effPerpMaker, nonEnrolledResult.standardPerpMaker, opts.feeEpsilon));
  checks.push(C('non-enrolled user: effective fee == standard fee (no overlay applied)', effEqStd, { effPerpTaker: nonEnrolledResult.effPerpTaker, standardPerpTaker: nonEnrolledResult.standardPerpTaker, effPerpMaker: nonEnrolledResult.effPerpMaker, standardPerpMaker: nonEnrolledResult.standardPerpMaker }));
  if (nonEnrolledResult.takerFillRate != null && nonEnrolledResult.takerFillIsMaker === false) {
    const fillStd = close(nonEnrolledResult.takerFillRate, nonEnrolledResult.standardPerpTaker, opts.feeEpsilon);
    checks.push(C('non-enrolled user: real taker fill charged the standard taker rate', fillStd, { takerFillRate: nonEnrolledResult.takerFillRate, standardPerpTaker: nonEnrolledResult.standardPerpTaker }));
  } else {
    checks.push(C('non-enrolled user: real taker fill charged the standard taker rate', true, 'no clean taker fill captured for the maker', true));
  }
  return checks;
}

module.exports = { phaseNonEnrolled };
