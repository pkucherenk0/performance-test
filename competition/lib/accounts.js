'use strict';
// Account lifecycle: auth (wallet challenge/verify) -> enroll -> faucet -> transfer -> wait funds.

const { Wallet } = require('ethers');
const { sleep, postJson, getJson } = require('./http');
const { getSpotAssetBalance } = require('./spot');
const { closeAllPositions } = require('./market');

async function authenticate(rl, authBaseUrl, wallet, maxRetries) {
  const root = authBaseUrl.replace(/\/$/, '');
  const ch = await postJson(rl, `${root}/auth/challenge`, { wallet_address: wallet.address }, {}, maxRetries);
  if (!ch.ok || !ch.body?.challenge) return { ok: false, stage: 'challenge', httpStatus: ch.httpStatus, body: ch.body };
  let signature;
  try { signature = await wallet.signMessage(ch.body.challenge); }
  catch (err) { return { ok: false, stage: 'sign', httpStatus: 0, body: { error: String(err) } }; }
  const v = await postJson(rl, `${root}/auth/verify`, { wallet_address: wallet.address, challenge: ch.body.challenge, signature }, {}, maxRetries);
  if (!v.ok || !v.body?.access_token) return { ok: false, stage: 'verify', httpStatus: v.httpStatus, body: v.body };
  return { ok: true, accessToken: v.body.access_token, refreshToken: v.body.refresh_token, expiresIn: v.body.expires_in };
}

// termsAccepted defaults true; pass false to exercise the 422 TERMS_NOT_ACCEPTED path.
async function enroll(rl, baseUrl, slug, address, jwt, maxRetries, termsAccepted = true) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/competitions/${encodeURIComponent(slug)}/enroll`;
  const r = await postJson(rl, url, { address, terms_accepted: termsAccepted }, { Authorization: `Bearer ${jwt}` }, maxRetries);
  return { address, status: r.httpStatus === 201 ? 'enrolled' : r.httpStatus === 200 ? 'already_enrolled' : 'failed', httpStatus: r.httpStatus, body: r.body };
}

async function faucet(rl, faucetUrl, appSessionId, asset, amount, maxRetries) {
  const r = await postJson(rl, faucetUrl, { app_session_id: appSessionId, asset, amount }, {}, maxRetries);
  return { ok: r.ok && r.body?.success === true, httpStatus: r.httpStatus, body: r.body };
}

async function transferSpotToPerps(rl, tradingBase, jwt, appSessionId, asset, amount, maxRetries) {
  const url = `${tradingBase.replace(/\/$/, '')}/accounts/transfer`;
  const r = await postJson(rl, url, { app_session_id: appSessionId, source_account_type: 'spot', dest_account_type: 'perps', asset_symbol: asset, amount }, { Authorization: `Bearer ${jwt}` }, maxRetries);
  return { ok: r.httpStatus === 202 || r.ok, httpStatus: r.httpStatus, transferId: r.body?.transfer_id || null, error: (r.httpStatus === 202 || r.ok) ? null : (r.body?.error || r.body?.message || `HTTP_${r.httpStatus}`) };
}

async function getPerpAvailable(rl, tradingBase, jwt, appSessionId, asset, maxRetries) {
  const url = `${tradingBase.replace(/\/$/, '')}/perpetual/balance?app_session_id=${encodeURIComponent(appSessionId)}`;
  const r = await getJson(rl, url, { Authorization: `Bearer ${jwt}` }, maxRetries);
  if (!r.ok || !Array.isArray(r.body)) return 0;
  const bal = r.body.find((b) => b.asset_symbol === asset);
  return bal ? parseFloat(bal.available_balance || '0') : 0;
}

async function waitForPerpFunds(rl, opts, jwt, appSessionId, minAmount) {
  const deadline = Date.now() + opts.transferTimeoutMs;
  let avail = 0;
  while (Date.now() < deadline) {
    avail = await getPerpAvailable(rl, opts.tradingBase, jwt, appSessionId, opts.collateral, opts.maxRetries);
    if (avail >= minAmount) return { settled: true, available: avail };
    await sleep(750);
  }
  return { settled: avail > 0, available: avail };
}

// full setup for one account: auth -> (enroll) -> faucet -> transfer -> wait funds.
// doEnroll=false leaves the account OUT of the competition (perp trading still works;
// it just never receives the competition overlay -> standard fees only).
async function setupAccount(rl, opts, label, doEnroll = true) {
  const wallet = Wallet.createRandom();
  const appSessionId = wallet.address;
  const auth = await authenticate(rl, opts.authBase, wallet, opts.maxRetries);
  if (!auth.ok) throw new Error(`${label} auth failed at ${auth.stage}: ${JSON.stringify(auth.body)}`);
  const jwt = auth.accessToken;
  const enrStatus = doEnroll ? (await enroll(rl, opts.base, opts.competition, wallet.address, jwt, opts.maxRetries)).status : 'not_enrolled';
  const f = await faucet(rl, opts.faucetUrl, appSessionId, opts.collateral, opts.faucetUsdt, opts.maxRetries);
  const xfer = await transferSpotToPerps(rl, opts.tradingBase, jwt, appSessionId, opts.collateral, opts.transferUsdt, opts.maxRetries);
  const funds = xfer.ok ? await waitForPerpFunds(rl, opts, jwt, appSessionId, parseFloat(opts.transferUsdt) * 0.9) : { settled: false, available: 0 };
  console.log(`${label}: ${wallet.address} | enroll ${enrStatus} | faucet ${f.ok ? 'ok' : 'FAIL'} | xfer ${xfer.ok ? (funds.settled ? `settled ${funds.available}` : 'pending') : 'FAIL ' + xfer.error}`);
  if (funds.available <= 0) throw new Error(`${label} has no perp funds — cannot trade`);
  return { wallet, jwt, appSessionId, enroll: enrStatus, perpAvailable: funds.available };
}

// No-faucet (stage) path: use a PRE-FUNDED account from users.<env>.json. Auth (via the wallet's
// signature, or a pre-issued JWT), enroll if requested, then ensure perp collateral WITHOUT faucet:
// if the perps side is short but spot is funded, move spot->perps; if still short, throw a clear
// "top up this address" error (cred = an entry from lib/users.loadUsers()).
async function setupPrefundedAccount(rl, opts, label, cred, doEnroll = true) {
  let jwt, address, wallet;
  if (cred.kind === 'jwt') {
    jwt = cred.jwt; address = cred.address; wallet = { address };
  } else {
    wallet = cred.wallet; address = cred.address;
    const auth = await authenticate(rl, opts.authBase, wallet, opts.maxRetries);
    if (!auth.ok) throw new Error(`${label} (${address}) auth failed at ${auth.stage}: ${JSON.stringify(auth.body)}`);
    jwt = auth.accessToken;
  }
  const appSessionId = address;
  const enrStatus = doEnroll ? (await enroll(rl, opts.base, opts.competition, address, jwt, opts.maxRetries, opts.terms)).status : 'not_enrolled';

  // Reused stage accounts may carry positions from a prior (or crashed) run — flatten them FIRST so
  // their locked margin is freed before we check/sweep available collateral. Every run starts clean.
  const flat = await closeAllPositions(rl, opts, jwt, appSessionId);
  if (flat.submitted > 0) { console.log(`${label}: closed ${flat.submitted} leftover position leg(s) from a previous run`); await sleep(1500); }
  else if (!flat.ok) console.warn(`${label}: could not flatten leftover positions: ${flat.error}`);

  let avail = await getPerpAvailable(rl, opts.tradingBase, jwt, appSessionId, opts.collateral, opts.maxRetries);
  let moved = 0;
  if (avail < opts.minPerpUsd) {
    // No faucet — manual top-ups usually land on SPOT, so sweep ALL available spot collateral into
    // perps (not just the minimum). Fund the address generously on spot and it all goes to margin.
    const spotBal = await getSpotAssetBalance(rl, opts, jwt, appSessionId, opts.collateral);
    moved = Math.floor(spotBal);
    if (moved > 0) {
      const xfer = await transferSpotToPerps(rl, opts.tradingBase, jwt, appSessionId, opts.collateral, String(moved), opts.maxRetries);
      if (xfer.ok) await waitForPerpFunds(rl, opts, jwt, appSessionId, Math.min(opts.minPerpUsd, avail + moved * 0.9));
    }
    avail = await getPerpAvailable(rl, opts.tradingBase, jwt, appSessionId, opts.collateral, opts.maxRetries);
  }
  console.log(`${label}: ${address}${cred.label ? ` (${cred.label})` : ''} | enroll ${enrStatus} | perp ${opts.collateral} ${avail}${moved ? ` (swept ${moved} from spot)` : ''}`);
  if (avail < opts.minPerpUsd) {
    throw new Error(`${label} (${address}) has ${avail} ${opts.collateral} on perps (+ spot swept), need >= ${opts.minPerpUsd}. ` +
      `No faucet on env "${opts.env}" — top up this address with more ${opts.collateral} (spot or perps).`);
  }
  return { wallet, jwt, appSessionId, enroll: enrStatus, perpAvailable: avail };
}

module.exports = { authenticate, enroll, faucet, transferSpotToPerps, getPerpAvailable, waitForPerpFunds, setupAccount, setupPrefundedAccount };
