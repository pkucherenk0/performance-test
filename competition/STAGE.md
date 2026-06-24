# Running on stage (`--env stage`)

Stage has **no faucet**, so unlike uat you can't spin up fresh auto-funded wallets each run. You
provide a small pool of wallets in `users.stage.json`, fund them manually once, and reuse them. This
runbook covers the fee-tier verification (`run.js`); the enrollment tools work the same way but only
do enroll-only on stage (volume needs a faucet).

---

## 1. Prerequisites

- Node 18+ and `ethers` installed (`npm install ethers` at the repo root).
- A stage competition slug that is **active** (window open) — ask the competition owner, or check
  `GET https://hub.staging.yellow.pro.neodax.app/api/v1/competitions/<slug>`.
- 2+ EVM wallets you control (private keys) that you can fund with USDT on stage.

Endpoints `--env stage` selects (override individually if needed):

| | URL |
|---|---|
| hub (`--base`) | `https://hub.staging.yellow.pro.neodax.app` |
| auth (`--auth-base`) | `https://auth.staging.yellow.pro.neodax.app` |
| trading (`--trading-base`) | `https://api.staging.yellow.pro.neodax.app` |
| faucet | none |

---

## 2. Create `users.stage.json`

Copy the template and fill in your funded wallets (the file is git-ignored):

```bash
cd competition
cp users.example.json users.stage.json
```

```json
[
  { "label": "subject", "privateKey": "0x<key-1>" },
  { "label": "maker",   "privateKey": "0x<key-2>" }
]
```

- Entry **0** is the SUBJECT (enrolled, gets the overlay); entry **1** is the MAKER (counterparty).
  Override with `--subject-index` / `--maker-index`.
- `privateKey` is preferred — the script mints JWTs on demand, so nothing expires during a long run.
  Alternatives per entry: `{ "mnemonic": "..." }` or `{ "jwt": "...", "sessionId": "0x..." }`.
- The **address** to fund is the wallet address (or `sessionId`). Print them if you only have keys:
  ```bash
  node -e 'const {Wallet}=require("ethers");for(const u of require("./users.stage.json"))console.log(u.label||"",new Wallet(u.privateKey).address)'
  ```

---

## 3. Fund the wallets

Top up **each** address with USDT on stage. You can fund either side — when perps is below
`--min-perp-usd` (default **20,000**), the run **sweeps ALL available spot collateral into perps**.
So the simplest approach: put everything on the **spot** account and let the run move it to margin.

Round-trips are **reduce-only on the close leg** (same direction as the open, opposite side), so each
cycle's margin is **released as soon as the position closes** — peak usage stays ~`order-notional /
leverage` (≈ $5k at the defaults), regardless of target tier. The only amount truly **consumed** is
fees (~$1.5–2k combined per VIP3 run; see the README table).

Sizing guidance:

| What | Amount / account | Notes |
|---|---|---|
| Working margin | **~$20k** (`--min-perp-usd`) | recoverable; raise it if you raise `--order-notional` (need ≥ `order-notional / leverage` + buffer) |
| Fees consumed / VIP3 run | ~$1.5–2k combined across both accounts | scales with target tier |

Rule of thumb: **~$50k USDT per account** sustains ~30–60 VIP3 runs before a top-up. To validate the
stage wiring cheaply first, run `--target-tier 1` (a handful of fills), then scale up.

---

## 4. Run

```bash
cd competition
node run.js --env stage --competition <stage-slug>
```

Common variants:

```bash
# Lighter/faster: lower target tier + skip spot
node run.js --env stage --competition <slug> --target-tier 2 --no-spot-check

# Pick specific pool entries (e.g. a fresh, never-enrolled subject for a clean from-base step-down)
node run.js --env stage --competition <slug> --subject-index 4 --maker-index 1

# Require more perp collateral / larger orders
node run.js --env stage --competition <slug> --order-notional 100000 --min-perp-usd 40000
```

YELLOW phases (3 & 5) **auto-skip on stage** — they rely on a faucet deposit spike to cross the
24h-average in one tick (see §6). Everything else runs: phase 1 (volume + role swap), phase 2
(deepened tier, both sides), phase 4 (spot), and the non-enrolled control.

Output: `competition/results/fee-verify-<slug>-<ts>.json` (git-ignored). Exit code 0 = all
non-info checks passed.

---

## 5. Reusing accounts across runs

- **Clean start, automatically.** At the start of every stage run, each account's open perp positions
  are flattened (`POST /perpetual/positions/close`) *before* the margin check — so leftovers from a
  previous or crashed run don't lock margin or skew the next run. You don't need to close anything by
  hand between runs.
- The SUBJECT stays **enrolled** and its campaign volume **persists** for the competition window.
  Re-running with the same subject verifies charged-rate correctness at the already-reached tier, but
  you won't see the fee step *down from Base* again.
- To re-observe the from-base step-down, point `--subject-index` at a **fresh, never-enrolled**
  funded entry each run. The MAKER can be reused indefinitely (it just provides liquidity; its own
  standard tier drifting is fine — the maker checks are band-tolerant to its schedule).
- Spent subjects still hold their (recoverable) margin — recycle them as makers or withdraw.

---

## 6. YELLOW on stage (optional, slow)

The YELLOW tier path needs the **24h hour-weighted average** of the balance to cross a tier's
`campaign_yellow_req`. On uat the script faucets ~24× the req so one hourly tick crosses it; on stage
there's no spike, so:

- **Up:** pre-hold ≥ the target tier's req (top tier VIP6 = **28,000 YELLOW**) for **>24h** so the
  average already qualifies, then run with `--yellow` forced... note phases still skip while
  `faucet=false`. Practically: treat YELLOW as a separate **24h+ soak**, not a quick run.
- **Down:** selling YELLOW only drops the tier after the average **decays** (~24h).
- YELLOW isn't consumed — it moves subject→maker in the decrease step and stays in your pool.

For routine fee-tier verification on stage, leave YELLOW skipped (the default).

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `users file not found: .../users.stage.json` | create it from `users.example.json` (step 2) |
| `... has N USDT on perps, need >= 20000` | fund that address (step 3), or lower `--min-perp-usd` |
| `auth failed at verify` | wrong key, or stage auth env mismatch — keep all `--*-base` on stage |
| `competition fetch failed` | slug not active on stage / wrong `--competition` |
| `no taker fill visible` | the stage perp book is thin — the maker rests inside the spread, but if the book is crossed/empty it falls back; retry or pick a more liquid `--market` |
| overlay never activates | the campaign-volume tracker needs ~1 min + enough volume; raise `--watch-secs` / `--target-tier` |
