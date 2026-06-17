# ws-auth

Helpers for authenticating against the NeoDax / yellow.pro WebSocket gateway using
**API-key HMAC** signing (`X-API-KEY` / `X-TIMESTAMP` / `X-SIGNATURE`).

The signature scheme: `HMAC-SHA256(apiSecret, "GET" + path + timestamp)`, hex-encoded.
The canonical field string is empty for the WS handshake (a GET with no params).

## Requirements

```bash
npm install ws   # only needed for wsconnect.js
```

Credentials are **not** hardcoded — pass them via environment variables.

## Scripts

### `wsconnect.js` — connect + subscribe

Opens a Centrifuge WebSocket connection, sends `connect`, then subscribes to a
public channel (`public.tickers.24h`).

```bash
API_KEY=... API_SECRET=... USER_ADDRESS=0x... \
WS_URL=wss://api.uat.yellow.pro.neodax.app/ws \
node wsconnect.js
```

| Env var | Default | Meaning |
|---|---|---|
| `API_KEY` | `YOUR_API_KEY` | API key |
| `API_SECRET` | `YOUR_API_SECRET` | API secret (HMAC key) |
| `USER_ADDRESS` | `0xYOUR_ADDRESS` | Wallet address (for subscriptions) |
| `WS_URL` | `wss://api.uat.yellow.pro.neodax.app/ws` | WebSocket URL |

### `generate_wscat.js` — print a signed `wscat` command

Generates a timestamped, signed `wscat` one-liner you can paste into a terminal
(valid for ~60s).

```bash
API_KEY=... API_SECRET=... DOMAIN=api.uat.yellow.pro.neodax.app \
node generate_wscat.js
```

| Env var | Default | Meaning |
|---|---|---|
| `API_KEY` | `YOUR_API_KEY` | API key |
| `API_SECRET` | `YOUR_API_SECRET` | API secret (HMAC key) |
| `DOMAIN` | `api.uat.yellow.pro.neodax.app` | Host to connect to (path is `/ws`) |

> 🔒 Never commit real keys. These scripts read everything from the environment;
> the inline defaults are placeholders.
