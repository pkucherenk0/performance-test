'use strict';
// Pure tier math + the float-tolerant comparison used by every assertion.

// highest tier whose campaign volume requirement is met
const expectedCompTier = (tiers, cumVol) => { let c = tiers[0]; for (const t of tiers) if (cumVol >= t.volMin) c = t; return c; };

// either-threshold qualification: highest tier where campaign volume OR campaign-yellow meets the req
const expectedTierEither = (tiers, vol, yellow) => { let c = tiers[0]; for (const t of tiers) if (vol >= t.volMin || yellow >= t.yellowMin) c = t; return c; };

// relative closeness within eps (absolute when the target is 0)
const close = (a, b, eps) => (b === 0 ? Math.abs(a) <= eps : Math.abs(a - b) / Math.abs(b) <= eps);

// best-of of the component tiers from a fee-tier-effective reading (taker side)
const floorEff = (e) => (e.overlayActive ? Math.min(e.standardPerpTaker, e.overlayPerpTaker) : e.standardPerpTaker);

module.exports = { expectedCompTier, expectedTierEither, close, floorEff };
