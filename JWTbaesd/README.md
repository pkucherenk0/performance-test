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

## ⚙️ Configuration

To run these tests, you must provide valid credentials and ensure they are not tracked by git.

### 1. Secure your credentials
Create a `.gitignore` file in the root directory and add the following line to prevent accidental commits of sensitive data:
```text
users.json
```

### 2. Create the Users file
Create a file named `users.json` in the root directory and add your test user credentials (JWTs and Session IDs).

**`users.json` format:**
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
Run the test with the default configuration (10 Users, 10 Seconds):
```bash
k6 run order_test.js
```

### Custom Load Profile
Override the defaults using CLI flags:
```bash
# Run with 20 Virtual Users for 30 seconds
k6 run --vus 20 --duration 30s order_test.js
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
