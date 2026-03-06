import type { MarketRegistry } from "@unimarket/markets";
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { accounts, fundingPayments, positions } from "../db/schema.js";
import { eventBus } from "../platform/events.js";
import { startPeriodicWorker } from "./periodic-worker.js";
import { nowIso } from "../utils.js";

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

const buildFundingPaymentId = (accountId: string, market: string, symbol: string, nextFundingAt: string): string => {
    return `fnd_${accountId}_${market}_${symbol}_${nextFundingAt}`.replace(/[^a-zA-Z0-9_]/g, "_");
};

export const applyFundingPayments = async (
    registry: MarketRegistry,
): Promise<{ applied: number; skipped: number }> => {
    const allPositions = await db.select().from(positions).all();

    let applied = 0;
    let skipped = 0;

    for (const pos of allPositions) {
        const adapter = registry.get(pos.market);
        if (!adapter) {
            skipped += 1;
            continue;
        }

        if (!adapter.capabilities.includes("funding") || typeof adapter.getFundingRate !== "function") {
            skipped += 1;
            continue;
        }

        let fundingData;
        try {
            fundingData = await adapter.getFundingRate(pos.symbol);
        } catch {
            skipped += 1;
            continue;
        }

        if (!fundingData || fundingData.rate === 0) {
            skipped += 1;
            continue;
        }

        // Fetch current mark price for payment calculation
        let markPrice;
        try {
            const quote = await adapter.getQuote(pos.symbol);
            markPrice = quote.price;
        } catch {
            skipped += 1;
            continue;
        }

        // payment = position_value × funding_rate
        // Positive rate + long position → deduct from balance (longs pay)
        // Negative rate + long position → credit to balance (longs receive)
        const positionValue = pos.quantity * markPrice;
        const payment = Number((-positionValue * fundingData.rate).toFixed(6));

        if (payment === 0) {
            skipped += 1;
            continue;
        }

        try {
            const didApply = await db.transaction(async (tx) => {
                const latestPosition = await tx.select().from(positions).where(eq(positions.id, pos.id)).get();
                if (!latestPosition) return null;

                const account = await tx.select().from(accounts).where(eq(accounts.id, latestPosition.accountId)).get();
                if (!account) return null;

                const fundingPaymentId = buildFundingPaymentId(
                    latestPosition.accountId,
                    latestPosition.market,
                    latestPosition.symbol,
                    fundingData.nextFundingAt,
                );
                const now = nowIso();
                const insertedFunding = await tx
                    .insert(fundingPayments)
                    .values({
                        id: fundingPaymentId,
                        accountId: latestPosition.accountId,
                        market: latestPosition.market,
                        symbol: latestPosition.symbol,
                        quantity: latestPosition.quantity,
                        fundingRate: fundingData.rate,
                        payment,
                        createdAt: now,
                    })
                    .onConflictDoNothing()
                    .run();
                if (insertedFunding.rowsAffected === 0) {
                    // Already processed this funding window for this position symbol.
                    return null;
                }

                const nextBalance = Number((account.balance + payment).toFixed(6));

                const accountUpdated = await tx
                    .update(accounts)
                    .set({ balance: nextBalance })
                    .where(eq(accounts.id, account.id))
                    .run();
                if (accountUpdated.rowsAffected === 0) {
                    throw new Error("Account update failed during funding application");
                }

                return {
                    userId: account.userId,
                    accountId: latestPosition.accountId,
                    market: latestPosition.market,
                    symbol: latestPosition.symbol,
                    quantity: latestPosition.quantity,
                    appliedAt: now,
                };
            });

            if (didApply) {
                eventBus.emit({
                    type: "funding.applied",
                    userId: didApply.userId,
                    accountId: didApply.accountId,
                    data: {
                        market: didApply.market,
                        symbol: didApply.symbol,
                        quantity: didApply.quantity,
                        fundingRate: fundingData.rate,
                        payment,
                        appliedAt: didApply.appliedAt,
                    },
                });
                applied += 1;
            } else {
                skipped += 1;
            }
        } catch {
            skipped += 1;
        }
    }

    return { applied, skipped };
};

export const startFundingCollector = (registry: MarketRegistry): (() => void) => {
    return startPeriodicWorker({
        name: "funding",
        defaultIntervalMs: DEFAULT_INTERVAL_MS,
        envVar: "FUNDING_INTERVAL_MS",
        run: () => applyFundingPayments(registry),
        onResult: (result) => {
            if (result.applied > 0) {
                console.log(`[funding] applied ${result.applied} funding payments`);
            }
        },
    });
};
