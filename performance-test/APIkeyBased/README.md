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
`-e BASE_URL=… -e SPOT_MARKET=BTCUSDT -e CENTER_PRICE=64000`.

## 🔒 Credentials

Credentials are git-ignored (`.gitignore` excludes `users.json` and `users.*.json`).
Create one file per environment next to the scripts; it is selected automatically
by `-e ENV=<name>` → `users.<env>.json`:

* `users.uat.json`
* `users.stage.json`

> ⚠️ API keys are environment-specific — a UAT key is not valid on stage.

**`users.<env>.json` format:**
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

## 🏃 Usage

```bash
# UAT (default)
k6 run orderbook_populate.js

# stage
k6 run -e ENV=stage orderbook_populate.js

# stage, spot only, 4 users for 2 min
k6 run -e ENV=stage -e VENUE=spot --vus 4 --duration 120s orderbook_populate.js
```

Per-script env knobs are documented in each file's header.
