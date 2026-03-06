import type { MarketRegistry } from "@unimarket/markets";

import { startPeriodicWorker } from "./periodic-worker.js";
import { buildAdminOverviewModel, recordEquitySnapshotsFromOverview } from "../services/admin-overview.js";

const DEFAULT_INTERVAL_MS = 300_000;

export const recordEquitySnapshots = async (
  registry: MarketRegistry,
): Promise<{ created: number; skipped: number }> => {
  const overview = await buildAdminOverviewModel({ registry, includeSymbolMetadata: false });
  return recordEquitySnapshotsFromOverview({ overview });
};

export const startEquitySnapshotter = (registry: MarketRegistry): (() => void) => {
  return startPeriodicWorker({
    name: "equity-snapshots",
    defaultIntervalMs: DEFAULT_INTERVAL_MS,
    envVar: "EQUITY_SNAPSHOT_INTERVAL_MS",
    run: () => recordEquitySnapshots(registry),
    onResult: (result) => {
      if (result.created > 0) {
        console.log(`[equity-snapshots] created ${result.created} snapshots`);
      }
    },
  });
};
