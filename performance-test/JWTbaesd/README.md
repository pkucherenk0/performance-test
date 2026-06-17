# 🚀 Trading Engine Performance Tests (k6)

This repository contains performance testing scripts for the Trading Engine, utilizing **k6**. The tests focus on measuring the end-to-end latency of the trading lifecycle, specifically the time between **Order Creation (HTTP)** and **Trade Execution (WebSocket)**.

## 📋 Overview

The test script (`trade_10.js`) simulates the following flow for multiple concurrent users:

1. **WebSocket Connection:** Establishes and authenticates a WS connection.
2. **Order Placement:** Sends a limit order via REST API (`POST /spot/order`).
3. **Latency Measurement:**
   * **Time to Trade:** Measures duration until the matching engine returns `state: done`.
   * **Time to Balance:** Measures duration until ETH and USD balances are updated.

## 🛠️ Prerequisites

* [k6](https://k6.io/docs/get-started/installation/) must be installed on your machine.

### Installation

**macOS:**
```bash
brew install k6
```

**Windows:**
```powershell
winget install k6
```

## 🌐 Environments

All scripts read their endpoints, market symbol and asset symbols from `config.js`.
Switch environments with `-e ENV=<name>` (default `uat`):

| Env | Trade / WS | Auth |
|---|---|---|
| `uat` | `https://api.uat.yellow.pro.neodax.app` (`/ws`) | `https://auth.uat.yellow.pro.neodax.app` |
| `stage` | `https://api.staging.yellow.pro.neodax.app` (`/ws`) | `https://auth.staging.yellow.pro.neodax.app` |

Markets are the same on both: spot `ETHUSDT`, perp `ETHUSDT-PERP` (base `ETH`, quote `USDT`).

Any value can be overridden per-run, e.g.
`-e BASE_URL=… -e SPOT_MARKET=BTCUSDT -e MAKER_FEE_RATE=0.002`.

## ⚙️ Configuration

To run these tests, you must provide valid credentials and ensure they are not tracked by git.

### 1. Secure your credentials
`.gitignore` already excludes all credential files:
```text
users.json
users.*.json
```

### 2. Create per-environment Users files
Create one file per environment next to the scripts. Each is selected automatically
by `-e ENV=<name>` → `users.<env>.json`:

* `users.uat.json`
* `users.stage.json`

> ⚠️ Credentials are environment-specific: a JWT issued by the UAT auth service is
> not valid on stage. Issue each env's tokens against its own `authUrl` (see table above).

**`users.<env>.json` format:**
```json
[
  {
    "jwt": "YOUR_JWT_TOKEN_USER_1",
    "sessionId": "0xSessionIdUser1"
  },
  {
    "jwt": "YOUR_JWT_TOKEN_USER_2",
    "sessionId": "0xSessionIdUser2"
  }
]
```

## 🏃 Usage

### Basic Run
Run against UAT (default env):
```bash
k6 run roundtrip_test.js
```

Run the same script against stage:
```bash
k6 run -e ENV=stage roundtrip_test.js
```

### Custom Load Profile
Override the defaults using CLI flags:
```bash
# 20 VUs for 30s on stage
k6 run -e ENV=stage --vus 20 --duration 30s roundtrip_test.js
```

## 📊 Metrics Explained

The test generates custom metrics to track specific system behaviors:

| Metric | Description | Target SLA |
| :--- | :--- | :--- |
| **`time_to_trade_done`** | Time from API Order (200 OK) → WebSocket `order.updated` (done). | < 100ms |
| **`time_to_balance_eth`** | Time until the ETH balance update arrives. | N/A |
| **`time_to_balance_usd`** | Time until the USD balance update arrives (tracks 2nd event). | N/A |

### Pass/Fail Checks
* **`Private Channel Subscribed`**: Verifies WS authentication.
* **`Order Execution Flow`**: Verifies the trade successfully completed.
* **`Full Balance Sync`**: Verifies both balance updates were received.

## 🔒 Security
* **Never commit `users.json` to this repository.**
* Ensure your `.gitignore` is correctly configured as shown in the Configuration section.
