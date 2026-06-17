# Number Precision & Formatting — Trading UI

---

## Quick Reference — All Number Categories

| # | Number Category | Where It Appears | Approach |
|---|---|---|---|
| 1 | Last traded price | Market list, market header, order book | BE as-is + comma |
| 2 | Bid / Ask price | Order book price column | BE as-is + comma |
| 3 | Order price | Order form, open orders, order history | BE as-is + comma |
| 4 | Trigger price | Stop / take-profit orders | BE as-is + comma |
| 5 | Mark price | Futures header, position panel | BE as-is + comma |
| 6 | Index price | Futures header | BE as-is + comma |
| 7 | Liquidation price | Position panel | BE as-is + comma |
| 8 | Entry price | Position panel | BE as-is + comma |
| 9 | 24h High / Low | Market header | BE as-is + comma |
| 10 | Order amount | Order form, open orders, order history | BE as-is + comma |
| 11 | Filled amount | Open orders, order history | BE as-is + comma |
| 12 | Remaining amount | Open orders | BE as-is + comma |
| 13 | Order total (notional) | Order form, order history | BE as-is + comma |
| 14 | Trade amount | Trade history, executed trades | BE as-is + comma |
| 15 | PnL — realized | Order history, position panel | BE as-is + comma |
| 16 | PnL — unrealized | Position panel | BE as-is + comma |
| 17 | Order book amount per level | Order book amount column | Sig digits (≥1 only) + K/M/B + comma |
| 18 | Order book cumulative total | Order book total column | Sig digits (≥1 only) + K/M/B + comma |
| 19 | 24h trading volume (base) | Market list, market header | Sig digits (≥1 only) + K/M/B + comma |
| 20 | 24h trading volume (quote) | Market list, market header | Sig digits (≥1 only) + K/M/B + comma |
| 21 | Trading fee amount | Order form, order history, trade history | Sig digits (≥1 only) + subscript + K/M/B + comma |
| 22 | Asset balance — available | Balance panel, assets table | display_precision + comma |
| 23 | Asset balance — total / locked | Balance panel, assets table | display_precision + comma |
| 24 | Deposit amount | Deposit history | display_precision + comma |
| 25 | Withdrawal amount | Withdrawal history | display_precision + comma |
| 26 | Deposit / Withdrawal MAX | Deposit & withdrawal input | BE max precision, no rounding |
| 27 | Fee rate | Order form, fee info | Percentage — 2 decimal places (e.g. `0.10%`) |
| 28 | Price change 24h | Market list, market header | Percentage — 2 decimal places (e.g. `+2.35%`) |
| 29 | Funding rate | Futures header | Percentage — 4 decimal places (e.g. `0.0100%`) |
| 30 | Leverage multiplier | Position panel, order form | Integer + `x` suffix (e.g. `10x`) |

**Approach key:**

| Approach | Rule |
|---|---|
| **BE as-is + comma** | Render exactly as returned by API. Add thousand separator. No rounding, no truncation. |
| **Sig digits (≥1 only) + K/M/B** | Values < 1: full precision. Values ≥ 1: 5 significant digits, K/M/B abbreviation for large numbers. |
| **Sig digits (≥1 only) + subscript + K/M/B** | Same as above, plus subscript zero compression for very small values (e.g. `0.0₄2593`). |
| **display_precision** | Fixed decimal places from `assets[].display_precision` in `/spot/exchangeInfo`. Trailing zeros kept. |
| **Percentage** | Fixed decimal places as noted. Always show `+` / `−` sign for change values. |
| **Integer + suffix** | Whole number only, unit suffix appended. |

---

## What Are Significant Digits?

Significant digits are the meaningful digits in a value that express its precision — regardless of where the decimal point sits.

**Counting rules:**
- Non-zero digits always count: `123` → 3 sig digits
- Zeros between non-zero digits count: `101` → 3 sig digits
- Leading zeros never count: `0.0045` → 2 sig digits
- Trailing zeros after a decimal count: `1.200` → 4 sig digits
- Trailing zeros without a decimal are ambiguous: `1200` → 2, 3, or 4 (unclear)

**Modified rule for trading UI — counting starts only when there is a non-zero integer part:**

- If the value is **< 1** (integer part is `0`): display full precision, no truncation
- If the value is **≥ 1** (has a non-zero integer part): apply 5 sig digit truncation, counting from the first integer digit

| Raw value | Displayed | Reason |
|---|---|---|
| `0.00123456` | `0.00123456` | < 1 → no truncation |
| `0.12345678` | `0.12345678` | < 1 → no truncation |
| `1.00123456` | `1.0012` | ≥ 1 → 5 sig digits: 1,0,0,1,2 |
| `1234.567` | `1,234.5` | ≥ 1 → 5 sig digits: 1,2,3,4,5 |
| `12345.67` | `12,345` | ≥ 1 → 5 sig digits: 1,2,3,4,5 |
| `1234567` | `1,234,567` | ≥ 1 → integer, all digits significant, no truncation |

> **Note:** The 5 sig digit rule applies only where noted below (order book aggregates, fees). Prices and order/trade amounts are always rendered as-is from the backend.

---

## Display Rules by Number Type

### Price

*Appears in: market list, current market header, open orders, order history, order form, order book price column, trade history, executed trades, trigger prices*

| Rule | Value |
|---|---|
| Significant digits | **No** — render exactly as returned by the API |
| K / M / B abbreviation | **No** |
| Subscript notation | **No** |
| Thousand separator (comma) | **Yes** |

Since inputs are already constrained by `tick_size`, the backend will only ever return values that conform to the market precision. No client-side trimming or rounding should be applied.

**Examples (ETHYTEST.USD, tick = 0.1):**

| API response | Displayed |
|---|---|
| `0.00000123` | `0.00000123` |
| `1234.5` | `1,234.5` |
| `54321.0` | `54,321.0` |
| `1234567.0` | `1,234,567.0` |

---

### Order Book Amounts & Totals

*Appears in: order book amount column, order book total/cumulative column, total market volume in market selector*

| Rule | Value |
|---|---|
| Significant digits | 5 |
| K / M / B abbreviation | **Yes** |
| Thousand separator (comma) | **Yes** |

**Examples:**

| Raw | Displayed | Reason |
|---|---|---|
| `0.123456` | `0.123456` | < 1 → no truncation |
| `0.00123456` | `0.00123456` | < 1 → no truncation |
| `1234.56` | `1,234.5` | ≥ 1 → 5 sig digits |
| `123456` | `123.45K` | ≥ 1 → 5 sig digits + K |
| `1234567` | `1.2345M` | ≥ 1 → 5 sig digits + M |

---

### Order Amounts & Trade Amounts

*Appears in: open orders, order history, order form amount field (display), trade history*

| Rule | Value |
|---|---|
| Significant digits | **No** — render exactly as returned by the API |
| K / M / B abbreviation | **No** |
| Thousand separator (comma) | **Yes** |

Since inputs are already constrained by `step_size`, the backend will only ever return values that conform to the market precision. No client-side trimming or rounding should be applied.

**Examples (ETHYTEST.USD, step = 0.001):**

| API response | Displayed |
|---|---|
| `0.001` | `0.001` |
| `1234.560` | `1,234.560` |
| `123456.000` | `123,456.000` |

---

### Trading Fees

*Appears in: fee displays across orders and trades*

| Rule | Value |
|---|---|
| Significant digits | 5 |
| K / M / B abbreviation | **Yes** |
| Subscript notation | **Yes** *(for very small values)* |
| Thousand separator (comma) | **Yes** |

Subscript notation compresses leading zeros after the decimal: the subscript digit indicates how many zeros were omitted.

**Examples:**

| Raw | Displayed |
|---|---|
| `0.00002593` | `0.0₄2593` |
| `0.0012` | `0.0012` |
| `123.456` | `123.46` |

---

## Input Fields — Price, Trigger Price & Amount

### Price & Trigger Price Input

- Follows **5 significant digit** input limitation
- The minimum granularity a user can enter is defined by the market's **`PRICE_FILTER.tick_size`**
- Maximum decimal places = decimal places in `tick_size` (typically up to 8)

| Market | tick_size | Max decimals in input |
|---|---|---|
| ETHYTEST.USD | `0.1` | 1 |
| BTCYTEST.USD | — *(not defined)* | 8 |
| SOLYTEST.USD | `0.001` | 3 |
| BNBYTEST.USD | `0.01` | 2 |
| FXRPYTEST.USD | `0.0001` | 4 |
| YELLOWYTEST.USD | `0.000001` | 6 |
| XAUTYTEST.USD | `0.01` | 2 |

### Amount Input

- Follows **5 significant digit** input limitation
- The minimum granularity a user can enter is defined by the market's **`LOT_SIZE.step_size`**
- Maximum decimal places = decimal places in `step_size` (typically up to 8)
- Values below `min_qty` or above `max_qty` must be rejected

| Market | step_size | Max decimals in input | min_qty | max_qty |
|---|---|---|---|---|
| ETHYTEST.USD | `0.001` | 3 | `0.001` | `50,000` |
| BTCYTEST.USD | `0.0001` | 4 | `0.0001` | `50,000` |
| SOLYTEST.USD | `0.0001` | 4 | `0.0001` | `100,000` |
| BNBYTEST.USD | `0.001` | 3 | `0.001` | `50,000` |
| FXRPYTEST.USD | `0.001` | 3 | `0.001` | `10,000,000` |
| YELLOWYTEST.USD | `0.1` | 1 | `0.1` | `10,000,000` |
| XAUTYTEST.USD | `0.000001` | 6 | `0.000001` | `10,000` |

---

## Balances

### Asset Balances, Deposit Amounts, Withdrawal Amounts

*Appears in: assets table, balance panel, deposit history, withdrawal history*

| Rule | Value |
|---|---|
| Precision | `display_precision` from API `/spot/exchangeInfo` → `assets[].display_precision` |
| Thousand separator (comma) | **Yes** |
| Trailing zeros | Kept to fill `display_precision` |

**`display_precision` per asset:**

| Asset | display_precision |
|---|---|
| YTEST.USD | 2 |
| ETH | 8 |
| BTC | 3 |
| SOL | 6 |
| BNB | 6 |
| FXRP | 6 |
| YELLOW | 4 |
| XAUT | 2 |

**Examples (YTEST.USD, display_precision = 2):**

| Raw | Displayed |
|---|---|
| `123.456789` | `123.45` |
| `1234.5` | `1,234.50` |
| `123456.789` | `123,456.78` |

### Withdraw / Deposit MAX Button

Uses **maximum precision returned by the backend** — no rounding or truncation — to allow users to sweep dust from accounts.

---

## Reference — Full Market Filter Config

### ETHYTEST.USD
- `PRICE_FILTER`: min `1,000` · max `100,000` · tick `0.1`
- `LOT_SIZE`: min `0.001` · max `50,000` · step `0.001`
- `MIN_NOTIONAL`: `1`
- Fees: maker `0.1%` · taker `0.3%`

### BTCYTEST.USD
- `PRICE_FILTER`: min `10,000` · max `1,000,000` · tick *(not defined)*
- `LOT_SIZE`: min `0.0001` · max `50,000` · step `0.0001`
- `MIN_NOTIONAL`: `1`
- Fees: maker `0.2%` · taker `0.3%`

### SOLYTEST.USD
- `PRICE_FILTER`: min `10` · max `10,000` · tick `0.001`
- `LOT_SIZE`: min `0.0001` · max `100,000` · step `0.0001`
- `MIN_NOTIONAL`: `10`
- Fees: maker `0.1%` · taker `0.2%`

### BNBYTEST.USD
- `PRICE_FILTER`: min `50` · max `5,000` · tick `0.01`
- `LOT_SIZE`: min `0.001` · max `50,000` · step `0.001`
- `MIN_NOTIONAL`: `10`
- Fees: maker `0.1%` · taker `0.2%`

### FXRPYTEST.USD
- `PRICE_FILTER`: min `0.0001` · max `10` · tick `0.0001`
- `LOT_SIZE`: min `0.001` · max `10,000,000` · step `0.001`
- `MIN_NOTIONAL`: `5`
- Fees: maker `0.1%` · taker `0.2%`

### YELLOWYTEST.USD
- `PRICE_FILTER`: min `0.000001` · max `100` · tick `0.000001`
- `LOT_SIZE`: min `0.1` · max `10,000,000` · step `0.1`
- `MIN_NOTIONAL`: `5`
- Fees: maker `0.1%` · taker `0.2%`

### XAUTYTEST.USD
- `PRICE_FILTER`: min `500` · max `10,000` · tick `0.01`
- `LOT_SIZE`: min `0.000001` · max `10,000` · step `0.000001`
- `MIN_NOTIONAL`: `10`
- Fees: maker `0.1%` · taker `0.2%`
