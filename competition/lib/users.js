'use strict';
// Loads pre-funded accounts for non-faucet envs (stage) from users.<env>.json (git-ignored).
//
// Each entry may be one of:
//   { "privateKey": "0x..." }              -> the script signs the auth challenge itself (preferred;
//                                              JWTs are minted on demand, so nothing expires mid-soak)
//   { "mnemonic": "word word ..." }         -> same, derived from a seed phrase
//   { "jwt": "...", "sessionId": "0x..." }  -> use a pre-issued JWT directly (skips auth; JWTs expire)
// An optional "label" is echoed in logs.
//
// The address (= app_session_id) is the wallet address (or sessionId for jwt entries) — fund THAT
// address manually on stage.

const fs = require('fs');
const path = require('path');
const { Wallet } = require('ethers');

function walletFromMnemonic(m) {
  if (typeof Wallet.fromPhrase === 'function') return Wallet.fromPhrase(m);   // ethers v6
  if (typeof Wallet.fromMnemonic === 'function') return Wallet.fromMnemonic(m); // ethers v5
  throw new Error('this ethers version exposes neither Wallet.fromPhrase nor Wallet.fromMnemonic');
}

function loadUsers(usersFile) {
  const file = path.isAbsolute(usersFile) ? usersFile : path.resolve(__dirname, '..', usersFile);
  if (!fs.existsSync(file)) {
    throw new Error(`users file not found: ${file}\n  Create it (copy users.example.json -> ${path.basename(file)}) and fund the addresses. It is git-ignored.`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`failed to parse ${file}: ${e.message}`); }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${file} must be a non-empty JSON array of accounts`);

  return raw.map((u, i) => {
    if (u.privateKey) { const w = new Wallet(u.privateKey); return { kind: 'wallet', wallet: w, address: w.address, label: u.label }; }
    if (u.mnemonic)   { const w = walletFromMnemonic(u.mnemonic); return { kind: 'wallet', wallet: w, address: w.address, label: u.label }; }
    if (u.jwt && u.sessionId) return { kind: 'jwt', jwt: u.jwt, address: u.sessionId, label: u.label };
    throw new Error(`${file}[${i}] must have "privateKey", "mnemonic", or {"jwt","sessionId"}`);
  });
}

module.exports = { loadUsers };
