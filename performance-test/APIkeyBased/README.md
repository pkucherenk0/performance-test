# 🔑 API-Key (HMAC) Performance Tests (k6)

k6 scripts that authenticate with **API key + HMAC signature** (`X-API-KEY` /
`X-TIMESTAMP` / `X-SIGNATURE`). For the JWT-authenticated suite, see `../JWTbaesd`.

## 🌐 Environments

All scripts read their endpoints, market symbol and asset symbols from `config.js`.
Switch environments with `-e ENV=<name>` (default `uat`):

| Env | Trade / WS | Auth |
|---|---|---|
| `uat` | `https://api.uat.yellow.pro.neodax.app` (`/ws`) | `https://auth.uat.yellow.pro.neodax.app` |
| `stage` | `https://api.staging.yellow.pro.neodax.app` (`/ws`) | `https://auth.staging.yellow.pro.neodax.app` |

Markets are the same on both: spot `ETHUSDT`, perp `ETHUSDT-PERP` (base `ETH`, quote `USDT`).

Any value can be overridden per-run, e.g.
`-e BASE_URL=… -e SPOT_MARKET=BTCUSDT -e SPOT_CENTER=64000`.

## 🔒 Credentials

Credentials are git-ignored (`.gitignore` excludes `users.json` and `users.*.json`).
Copy the template and fill in real values — one file per environment, selected
automatically by `-e ENV=<name>` → `users.<env>.json`:

```bash
cp users.example.json users.uat.json    # then edit
cp users.example.json users.stage.json  # then edit
```

> ⚠️ API keys are environment-specific — a UAT key is not valid on stage.

**`users.<env>.json` format** (see `users.example.json`):
```json
[
  {
    "apiKey":      "YOUR_API_KEY",
    "apiSecret":   "YOUR_API_SECRET",
    "sessionId":   "0xSessionId",
    "userAddress": "0xUserAddress"
  }
]
```

## 📜 Scripts

### Orderbook populate (resting limit orders for pagination / depth testing)

Three composable scripts share their plumbing via `populate_common.js`
(auth, metrics, logging, user/side selection):

| Script | Venue | Notes |
|---|---|---|
| `spot_orderbook_populate.js` | spot only | `POST /spot/order` |
| `perp_orderbook_populate.js` | perp only | `POST /perpetual/order` |
| `orderbook_populate.js` | spot **+** perp | "all" — imports & runs the two scripts above each iteration |
| `populate_common.js` | — | shared helpers (not run directly) |

```bash
# Single venue
k6 run spot_orderbook_populate.js
k6 run perp_orderbook_populate.js

# Both venues at once (composes the two scripts above)
k6 run orderbook_populate.js

# Against stage, 4 users for 2 min
k6 run -e ENV=stage --vus 4 --duration 120s orderbook_populate.js

# Exactly 100 resting orders on one venue (1 order per iteration)
k6 run --vus 1 --iterations 100 spot_orderbook_populate.js

# Tune center prices to the live mark so orders rest instead of crossing
k6 run -e SPOT_CENTER=1679 -e PERP_CENTER=1679 orderbook_populate.js
```

**Env knobs** (all optional; per-script details in each file's header):

| Scope | Knobs |
|---|---|
| Shared | `ENV` `ACTIVE_USERS` `SPAM_DELAY_MS` `VUS` `DURATION` `SIDE=buy\|sell\|alt` |
| Spot | `SPOT_MARKET` `SPOT_CENTER` `SPOT_RANGE` `SPOT_AMOUNT` `SPOT_DECIMALS` |
| Perp | `PERP_MARKET` `PERP_CENTER` `PERP_RANGE` `PERP_AMOUNT` `PERP_DECIMALS` `LEVERAGE` `MARGIN_MODE` |

> The `orderbook_populate.js` "all" script accepts the **union** of the spot and
> perp knobs. To populate a single venue, run that venue's script directly rather
> than the "all" script.

### Other scripts

| Script | What it does |
|---|---|
| `orderbook_batch_test.js` | Batch order placement test |
| `roundtrip_test_1.js` | Order place → fill → cancel round-trip latency test |

Per-script env knobs are documented in each file's header.
