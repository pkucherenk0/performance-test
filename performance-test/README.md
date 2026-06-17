# performance-test (k6)

Load / population scripts for the NeoDax / yellow.pro trading API, written for
[k6](https://k6.io/). Two credential styles, each in its own folder with its own
README and git-ignored `users.<env>.json`.

> This folder is also published standalone at
> [github.com/pkucherenk0/performance-test](https://github.com/pkucherenk0/performance-test).

## Layout

| Path | Auth style | `users.json` shape |
|---|---|---|
| [`APIkeyBased/`](APIkeyBased/README.md) | API key + HMAC (`X-API-KEY` / `X-SIGNATURE`) | `[{ apiKey, apiSecret, sessionId, userAddress }]` |
| [`JWTbaesd/`](JWTbaesd/README.md) | Pasted JWT (`Authorization: Bearer`) | `[{ jwt, sessionId }]` |
| `doc.md` | — | Reference: trading-UI number precision & formatting rules |

## Credentials

Each suite reads credentials from `users.<env>.json` next to its scripts, selected
by `-e ENV=<name>` (default `uat`). These files are **git-ignored**. Copy the example
and fill in real values:

```bash
cd APIkeyBased   # or JWTbaesd
cp users.example.json users.uat.json
# edit users.uat.json with real credentials
```

## Environments

Both suites resolve endpoints from `config.js`:

| Env | Trade / WS | Auth |
|---|---|---|
| `uat` | `https://api.uat.yellow.pro.neodax.app` (`/ws`) | `https://auth.uat.yellow.pro.neodax.app` |
| `stage` | `https://api.staging.yellow.pro.neodax.app` (`/ws`) | `https://auth.staging.yellow.pro.neodax.app` |

Any value can be overridden per run, e.g. `-e ENV=stage -e SPOT_MARKET=BTCUSDT`.

See each subfolder's README for the full script list and run commands.
