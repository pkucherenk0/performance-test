# scripts

NeoDax / yellow.pro API testing & ops tooling. This is the map of what lives here —
each folder has its own README with full details.

| Path | What it is | Quick start |
|---|---|---|
| [`ws-auth/`](ws-auth/README.md) | WebSocket auth helpers (HMAC `X-API-KEY` / `X-SIGNATURE`). | `node ws-auth/wsconnect.js` (connect + subscribe) · `node ws-auth/generate_wscat.js` (print a signed `wscat` command) |
| [`competition/`](competition/README.md) | Generate wallets, authenticate, enroll into a competition, optional volume. | `node competition/enroll-competition.js --count 20` (needs `ethers`; see `--help`) |
| [`performance-test/`](performance-test/README.md) | k6 load / orderbook-population scripts (API-key and JWT auth). | See its README — `k6 run orderbook_populate.js` |
| [`restart-service.sh`](restart-service.sh) | Kubernetes rolling restart of a Deployment / StatefulSet. | `./restart-service.sh -s order-service -n uat` (requires `KUBECONFIG`) |

## Requirements

- **Node 18+** — for `ws-auth/` and `competition/` (uses global `fetch`).
- **[k6](https://k6.io/)** — for `performance-test/`.
- **kubectl + KUBECONFIG** — for `restart-service.sh`.

Install per-folder Node deps as noted in each README (`ws`, `ethers`).

## 🔒 Credentials & secrets

This repo contains **no real credentials**. Everything that needs auth reads it
from the environment or a git-ignored file:

| Where | How to supply credentials |
|---|---|
| `ws-auth/` | Environment variables: `API_KEY`, `API_SECRET`, … (see folder README) |
| `competition/` | Wallets are generated at runtime; output JSON (with JWTs) is git-ignored |
| `performance-test/` | `users.<env>.json` next to the scripts — copy from `users.example.json` |

The following are git-ignored and must **never** be committed:

- `users.json`, `users.*.json` (except `users.example.json`)
- `competition/wallet-jwts-*.json`, `competition/enrollments-*.json`
- `.env*`, `*.pem`, `*.key`, `.claude/`

## Environments

Most scripts default to **UAT** (`*.uat.yellow.pro.neodax.app`) and support a
`stage` environment. URLs are configurable via `config.js`, CLI flags, or env vars —
see each folder's README.
