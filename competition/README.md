# competition

Tooling for NeoDax trading competitions on yellow-pro-hub. Two tools, one shared library:

- **`enroll/`** — bulk-enroll fresh wallets and optionally generate volume (spot or perp).
- **`run.js`** — verify the perp **fee-tier engine** end-to-end (fee charged + steps down with
  competition volume, from both sides for both accounts).

## Requirements

```bash
npm install ethers
```

Node 18+ (uses the built-in global `fetch`).

## Layout

```
lib/                     shared library (used by BOTH tools)
  http.js                rate limiter + retrying JSON client
  accounts.js            auth / enroll / faucet / transfer / fund
  market.js              perp metadata, mark price, top-of-book, sizing, orders
  spot.js                spot fee rate, reference price, spot orders, balances
  fees.js                fee-tier-effective (best-of) + per-fill charged fee
  competition-api.js     competition endpoint + schedule fallback
  tiers.js  checks.js  trade.js  report.js   (fee-test helpers)
  enroll-runner.js       shared bulk-enroll worker pool + output writer
enroll/
  spot.js                bulk enroll + SPOT volume
  perp.js                bulk enroll + PERP volume
run.js                   fee-tier verification entry point
config.js  setup.js      fee-test config + shared-context builder
cases/                   fee-test phases (one file each)
```

> All entry points share the **same environment contract**: `--base`, `--auth-base`,
> `--trading-base` and `--faucet-url` must point at the **same environment** — the auth JWT and the
> spot/perps accounts are environment-scoped.

## Environments (`--env uat | stage`)

Every entry point takes `--env` (default `uat`). It swaps the endpoint set and the funding model
(`lib/env.js`); individual endpoints can still be overridden (`--base`/`--trading-base`/…).

| | **uat** (default) | **stage** |
|---|---|---|
| Endpoints | `*.uat.yellow.pro.neodax.app` | `*.staging.yellow.pro.neodax.app` |
| Faucet | yes | **no** |
| Accounts | fresh random wallets, auto-funded each run | **pre-funded** wallets from `users.stage.json`, topped up manually |
| YELLOW phases (3 & 5) | run | auto-skip (the 24h-avg crossing needs a faucet spike) |

**Stage setup:** copy `users.example.json` → `users.stage.json` (git-ignored) and list ≥ 2 funded
accounts. Each entry is `{ "privateKey": "0x…" }` (preferred — the script mints JWTs on demand, so
nothing expires during a long soak), or `{ "mnemonic": "…" }`, or `{ "jwt": "…", "sessionId": "0x…" }`.
Fund the listed addresses with USDT (the run will move spot→perps if perps is short). The fee test
uses entry `--subject-index` (default 0) as the enrolled subject and `--maker-index` (default 1) as
the counterparty; require ≥ `--min-perp-usd` (default 20000) USDT of perp collateral per account.

```bash
node run.js --env stage --competition <slug>                 # uses users.stage.json [0]=subject, [1]=maker
node run.js --env stage --competition <slug> --subject-index 4 --maker-index 1   # fresh subject from the pool
```

See **[STAGE.md](STAGE.md)** for the full stage runbook (funding, pool sizing, troubleshooting).

## Enrollment (`enroll/spot.js`, `enroll/perp.js`)

Generate ETH wallets, authenticate each (challenge / verify), enroll each in a competition using its
own JWT, and optionally faucet + trade to produce competition volume. Spot and perp differ only in
the volume flow:

| | `enroll/spot.js` | `enroll/perp.js` |
|---|---|---|
| Funding | faucet USDT + ETH to spot | faucet USDT to spot, then **transfer spot → perps** |
| Trades | spot `MARKET` orders | perp `MARKET` round-trips (open + reduce-only close) |

```bash
# Spot: defaults (20 wallets, UAT, volume on)
node enroll/spot.js
node enroll/spot.js --count 50 --no-volume                 # enroll only
node enroll/spot.js --competition edition-1 --count 25 --concurrency 4

# Perp: enroll + perp volume
node enroll/perp.js --count 10 --orders 3 --market ETHUSDT-PERP
node enroll/perp.js --help                                 # full flag list
```

Common flags: `--count` `--competition` `--concurrency` `--rps` `--max-retries` `--delay`
`--terms` (set `false` to exercise the 422 TERMS_NOT_ACCEPTED path) `--volume`/`--no-volume`.
Spot adds `--faucet-eth` `--min-notional`/`--max-notional`; perp adds `--transfer-usdt` `--leverage`
`--collateral` `--close`/`--no-close`. UAT perp symbols have no separator, e.g. `ETHUSDT-PERP`,
`BTCUSDT-PERP` — resolved against `GET /perpetual/exchangeInfo` (lot/notional filters honoured).

> Market orders only produce real volume if the book already has opposing liquidity; rejected /
> zero-fill orders are logged but are not fatal.

## Fee-tier verification (`run.js`, TC-P0-8)

Checks the **perp fee-tier engine**: the fee charged after a trade matches the engine's resolved
tier and **steps down as cumulative competition volume grows** — verified from **both sides**
(taker & maker) for **both accounts** (the enrolled subject and the non-enrolled counterparty).

```bash
node run.js --competition pablo-15
node run.js --competition pablo-15 --target-tier 3 --order-notional 100000
node run.js --no-yellow --no-spot-check                    # faster smoke run
node run.js --help                                         # full flag list
```

How it works (sequential phases over one shared, funded context):

1. **Live schedule, never hardcoded.** Primary source is `GET {base}/api/v1/competitions/{slug}` —
   its `fee_tiers[]` carry the **campaign** thresholds (`campaign_volume_req_usd`) and `perp_*_bps`
   rates, plus `volume_source` and `total_volume_usd`. Falls back to the deployment standard schedule
   (`--fee-tiers-url` / `--schedule-key`) while `fee_tiers` is `null`.
2. **Two funded accounts** trade BTC perp against each other (maker rests **inside the spread** so it
   is the guaranteed counterparty; taker hits it with a market order; round-trips flatten).
3. **Phase 1** drives volume, swapping roles at ~50%: first half the **subject takes** (overlay taker
   fee), second half the **subject rests as maker** (overlay maker fee) while the counterparty takes.
4. **Phase 2** waits for the per-account engine tier to catch up to the ingested volume, then captures
   confirmation fills at the deepened tier on **both** sides.
5. **Phase 3 / 5** push the tier deeper via the 24h-average **YELLOW** balance, then drain it and
   confirm the tier drops back and the fee rises (`--no-yellow` skips both).
6. **Phase 4** spot check keyed off `volume_source`: `spot_perp` → overlay **discounts** spot;
   perp-only → spot stays standard (`--no-spot-check` skips).
7. **Non-enrolled** negative control: the counterparty never enrolled, so it must get standard fees
   on every side.

Assertions are anchored to the **charged** fee (the matching engine is ground truth; the
`fee-tier-effective` endpoint can lag by ~1 fill at a transition, so hard checks are band-tolerant).
`info` checks never fail the run. Process exits non-zero if any non-info check fails.

Key flags: `--target-tier` / `--target-volume`, `--order-notional`, `--marker-fills`,
`--watch-secs` (≥60 for the 1-min tracker), `--yellow`/`--no-yellow`, `--yellow-target-tier`,
`--spot-check`/`--no-spot-check`, `--epsilon`, `--rps`. See `node run.js --help`.

## Output

| File | Tool | Contents |
|---|---|---|
| `enrollments[-perp]-<comp>-<ts>.json` | enroll | enrollment + volume results (no private keys) |
| `wallet-jwts[-perp]-<comp>-<ts>.json` | enroll | `{ address, jwt }` pairs |
| `results/fee-verify-<comp>-<ts>.json` | run.js | schedule used, per-fill timeline, checks |

All run outputs are **git-ignored** (they contain live wallets / JWTs — never commit them); see the
repo-root `.gitignore`. Wallet **private keys are never written to disk** — they exist only in memory
for the lifetime of a run.
