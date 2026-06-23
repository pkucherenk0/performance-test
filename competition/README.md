# competition

Generate fresh ETH wallets, authenticate each against NeoDax (challenge / verify),
enroll them in a yellow-pro-hub trading competition, and optionally faucet + trade
to produce competition volume.

## Requirements

```bash
npm install ethers
```

Node 18+ (uses the built-in global `fetch`).

## Usage

```bash
# Defaults (20 wallets, UAT, competition "pablo-12", volume on)
node enroll-competition.js

# 50 wallets, enroll only (no faucet/trading)
node enroll-competition.js --count 50 --no-volume

# Target a specific competition with custom concurrency
node enroll-competition.js --competition edition-1 --count 25 --concurrency 4

# Full help (printed from the script header)
node enroll-competition.js --help
```

## Key flags

| Flag | Default | Meaning |
|---|---|---|
| `--count` | `20` | Number of wallets to generate + enroll |
| `--competition` | `pablo-12` | Competition slug to join |
| `--base` | `https://hub.uat.yellow.pro.neodax.app` | Hub API base |
| `--auth-base` | `https://auth.uat.yellow.pro.neodax.app` | Auth API base |
| `--concurrency` / `--rps` | `2` / `4` | Worker count / global request cap |
| `--volume` / `--no-volume` | on | Faucet + random spot market orders after enroll |
| `--trading-base` | `https://api.uat.yellow.pro.neodax.app` | Trading API (must match `--base` env) |
| `--faucet-url` | `https://faucet.uat.yellow.pro.neodax.app/api/deposit` | Faucet endpoint |
| `--market` | `ETHUSDT` | Spot market to trade |
| `--orders` | `5` | Random market orders per account |

> ⚠️ `--trading-base`, `--faucet-url`, `--base` and `--auth-base` must all point at the
> **same environment** — the auth JWT and the spot account are environment-scoped.

## Perpetuals variant

`enroll-competition-perp.js` is the perpetuals version. Auth + enrollment are
identical; the volume flow differs:

| | spot (`enroll-competition.js`) | perp (`enroll-competition-perp.js`) |
|---|---|---|
| Funding | faucet USDT + ETH to spot | faucet USDT to spot, then **transfer spot → perps** |
| Trades | spot `MARKET` orders | perp `MARKET` orders (open long/short, reduce-only close) |

The perpetuals account is created automatically on the first transfer — the
script does not create it explicitly. The market and amount precision are
resolved against `GET /perpetual/exchangeInfo`, and order sizing uses the mark
price from `GET /perpetual/funding-rates/current`.

```bash
# Defaults (20 wallets, UAT, perp volume on)
node enroll-competition-perp.js

# 50 wallets, enroll only
node enroll-competition-perp.js --count 50 --no-volume

# 10 wallets, 3 round-trip trades each on a specific market
node enroll-competition-perp.js --count 10 --orders 3 --market ETHUSDT-PERP
```

> UAT perp symbols have no separator between base and quote, e.g. `ETHUSDT-PERP`,
> `BTCUSDT-PERP`, `SOLUSDT-PERP`. The script resolves the symbol against
> `GET /perpetual/exchangeInfo` and reads each market's `LOT_SIZE` / `MIN_NOTIONAL`
> filters so order sizes always clear the venue minimums.

Perp-specific flags: `--transfer-usdt` (USDT moved spot→perps), `--leverage`,
`--market`, `--collateral`, `--close`/`--no-close`. Run `--help` for the full list.

## Output

The script writes two files to this directory (both are **git-ignored** — they
contain live wallets and JWTs, never commit them):

| File | Contents |
|---|---|
| `enrollments-<competition>-<timestamp>.json` | Enrollment + volume results (no private keys) |
| `wallet-jwts-<competition>-<timestamp>.json` | `{ address, jwt }` pairs |

The wallet **private keys are never written to disk** — they exist only in memory
for the lifetime of the run.
