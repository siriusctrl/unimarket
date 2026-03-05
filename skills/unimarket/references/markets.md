# Market Reference

## Cross-Market Trading Constraints

- Order `quantity` is decimal-capable at schema validation.
- Final order checks are market/symbol specific and should be discovered via:
  - `GET /api/markets/:market/trading-constraints?symbol=...`
- Default behavior (if a market adapter does not expose constraints):
  - `minQuantity: 1`
  - `quantityStep: 1`
  - `supportsFractional: false` (integer quantities only)
  - `maxLeverage: null`

## Polymarket (`polymarket`)

- **Symbols**: Condition IDs (from `search`) or token IDs (for direct CLOB access)
- **Data source**: Polymarket CLOB API (quotes, orderbook) + Gamma API (search, metadata)
- **Capabilities**: `search`, `quote`, `orderbook`, `resolve`
- **Price range**: $0.01 – $0.99 per contract
- **Quantity**: Number of contracts (integer only; `quantityStep=1`, `supportsFractional=false`)
- **Resolution**: Contracts resolve to $1.00 (yes) or $0.00 (no) when the event outcome is determined
- **Order symbol normalization**: `POST /api/orders` normalizes condition IDs to a canonical token symbol before persistence
- **Trading constraints endpoint**: `GET /api/markets/polymarket/trading-constraints?symbol=<condition_or_token_id>`

## Hyperliquid (`hyperliquid`)

- **Symbols**: Ticker symbols (e.g. `BTC`, `ETH`, `SOL`). Aliases like `btc-perp` or `eth` are auto-normalized.
- **Data source**: Hyperliquid public API (`https://api.hyperliquid.xyz/info`)
- **Capabilities**: `search`, `quote`, `orderbook`, `funding`
- **Price range**: Unconstrained (crypto market prices)
- **Quantity**: Fractional size supported per symbol using `szDecimals` (for example, `szDecimals=5` => `quantityStep=0.00001`)
- **Leverage cap**: Enforced per symbol using Hyperliquid `maxLeverage`
- **Funding rate**: Applied hourly. Positive rate → longs pay; negative rate → longs receive. Tracked in portfolio as `accumulatedFunding`.
- **No resolution**: Perpetual futures do not expire or settle. Positions are closed only by explicit sell orders.
- **Trading constraints endpoint**: `GET /api/markets/hyperliquid/trading-constraints?symbol=btc-perp`

### How Perpetual Futures Trading Works
1. Search for crypto assets: `GET /api/markets/hyperliquid/search?q=BTC`
2. Check symbol trading constraints (`minQuantity`, `quantityStep`, `supportsFractional`, `maxLeverage`)
3. Check price and orderbook depth before trading
4. Buy to open a long position at the current price
5. Funding payments are applied hourly, adjusting your account balance
6. Sell to close the position and realize P&L

### Quote Fields
| Field | Description |
|-------|-------------|
| `price` | Mid price from the L2 order book |
| `bid` / `ask` | Best bid/ask from the order book |

### Funding Rate
Use `GET /api/markets/hyperliquid/funding?symbol=BTC` to check the current predicted funding rate. The portfolio endpoint includes `accumulatedFunding` per position and `totalFunding` for the account.

### How Prediction Market Trading Works
1. Buy YES contracts if you think the event will happen (price < $1.00 = potential profit)
2. Buy NO contracts if you think it won't happen
3. When the event resolves, winning contracts pay $1.00, losing contracts pay $0.00
4. You can sell contracts before resolution at the current market price

### Quote Fields
| Field | Description |
|-------|-------------|
| `price` | Current YES price ($0.01–$0.99) |
| `bid` / `ask` | Best bid/ask from the order book |
| `volume` | 24h trading volume in USD |

### Finding Markets
Use `GET /api/markets/polymarket/search?q=<query>` to search by keyword.

Omit `q` to browse all active contracts:
```
GET /api/markets/polymarket/search?limit=20&offset=0   → first 20 contracts
GET /api/markets/polymarket/search?limit=20&offset=20  → next 20 contracts
```

The `symbol` returned by `search` can be used directly with:
- `GET /api/markets/polymarket/quote`
- `GET /api/markets/polymarket/orderbook`
- `POST /api/orders`

For explicit YES/NO routing, read `results[].metadata`:
- `metadata.tokenIds` aligns with `metadata.outcomes`
- `metadata.defaultTokenId` is the default tradable token

## Adding New Markets

Implement the `MarketAdapter` interface:

```typescript
interface MarketAdapter {
  readonly marketId: string
  readonly displayName: string
  readonly description: string
  readonly symbolFormat: string
  readonly priceRange: [number, number] | null
  readonly capabilities: readonly MarketCapability[]

  normalizeSymbol?(symbol: string): Promise<string>
  getQuote(symbol: string): Promise<Quote>
  search(query: string, options?: { limit?: number; offset?: number }): Promise<Asset[]>
  getOrderbook?(symbol: string): Promise<Orderbook>
  getFundingRate?(symbol: string): Promise<FundingRate>
  getTradingConstraints?(symbol: string): Promise<TradingConstraints>
  resolve?(symbol: string): Promise<Resolution | null>
}
```

Register the adapter at startup. All existing routes automatically work with the new market.
