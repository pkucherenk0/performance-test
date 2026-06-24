'use strict';
// Environment profiles. Selected with --env <name> (default uat).
//
//   uat   — has a faucet: accounts are fresh random wallets, auto-funded each run.
//   stage — NO faucet: accounts are pre-funded wallets you top up manually, listed in
//           users.stage.json (git-ignored). See users.example.json for the shape.
//
// Endpoints can still be overridden individually (--base/--auth-base/--trading-base/--faucet-url);
// applyEnv only fills the ones you did NOT pass explicitly.

const ENVIRONMENTS = {
  uat: {
    base:        'https://hub.uat.yellow.pro.neodax.app',
    authBase:    'https://auth.uat.yellow.pro.neodax.app',
    tradingBase: 'https://api.uat.yellow.pro.neodax.app',
    faucetUrl:   'https://faucet.uat.yellow.pro.neodax.app/api/deposit',
    faucet:        true,        // faucet available -> fresh wallets, auto-funded
    accountSource: 'faucet',
  },
  stage: {
    base:        'https://hub.staging.yellow.pro.neodax.app',
    authBase:    'https://auth.staging.yellow.pro.neodax.app',
    tradingBase: 'https://api.staging.yellow.pro.neodax.app',
    faucetUrl:   null,          // no faucet on stage
    faucet:        false,       // pre-funded wallets from users.<env>.json, topped up manually
    accountSource: 'users',
  },
};

// Apply the selected env's endpoints/flags onto opts. `explicit` is a Set of endpoint keys the
// user passed on the CLI (those are preserved). Sets faucet / accountSource from the env (not
// user-overridable) and defaults usersFile to users.<env>.json.
function applyEnv(opts, explicit = new Set()) {
  const env = ENVIRONMENTS[opts.env];
  if (!env) { console.error(`Unknown --env "${opts.env}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}`); process.exit(2); }
  for (const k of ['base', 'authBase', 'tradingBase', 'faucetUrl']) {
    if (!explicit.has(k)) opts[k] = env[k];
  }
  opts.faucet = env.faucet;
  opts.accountSource = env.accountSource;
  if (!opts.usersFile) opts.usersFile = `users.${opts.env}.json`;
  return opts;
}

module.exports = { ENVIRONMENTS, applyEnv };
