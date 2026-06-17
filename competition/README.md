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

## Output

The script writes two files to this directory (both are **git-ignored** — they
contain live wallets and JWTs, never commit them):

| File | Contents |
|---|---|
| `enrollments-<competition>-<timestamp>.json` | Enrollment + volume results (no private keys) |
| `wallet-jwts-<competition>-<timestamp>.json` | `{ address, jwt }` pairs |

The wallet **private keys are never written to disk** — they exist only in memory
for the lifetime of the run.
