# Market Reference

## Polymarket (`polymarket`)

- **Symbols**: Polymarket condition IDs (hex strings like `0x1234...abcd`)
- **Data source**: Polymarket CLOB API (quotes, orderbook) + Gamma API (search, metadata)
- **Capabilities**: `search`, `quote`, `orderbook`, `resolve`
- **Price range**: $0.01 – $0.99 per contract
- **Quantity**: Number of contracts (integer)
- **Resolution**: Contracts resolve to $1.00 (yes) or $0.00 (no) when the event outcome is determined

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

## Adding New Markets

Implement the `MarketAdapter` interface:

```typescript
interface MarketAdapter {
  readonly marketId: string
  readonly displayName: string
  readonly description: string
  readonly symbolFormat: string
  readonly priceRange: [number, number] | null
  readonly capabilities: string[]

  getQuote(symbol: string): Promise<Quote>
  search(query: string): Promise<Asset[]>
  getOrderbook?(symbol: string): Promise<Orderbook>
  resolve?(symbol: string): Promise<Resolution | null>
}
```

Register the adapter at startup. All existing routes automatically work with the new market.
