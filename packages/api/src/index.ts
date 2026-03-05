import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";

import { loadApiEnv } from "./env.js";

loadApiEnv();

const bootstrap = async (): Promise<void> => {
  const [
    { createApp, createDefaultRegistry },
    { migrate },
    { startFundingCollector },
    { startLiquidator },
    { startReconciler },
    { startSettler },
  ] = await Promise.all([
    import("./app.js"),
    import("./db/client.js"),
    import("./funding-collector.js"),
    import("./liquidator.js"),
    import("./reconciler.js"),
    import("./settler.js"),
  ]);

  const port = Number(process.env.PORT ?? 3100);
  const serveWeb = process.env.SERVE_WEB_DIST === "true";

  await migrate();

  const registry = createDefaultRegistry();
  const webDistPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const app = createApp({ registry, webDistPath, serveWeb });

  serve({ fetch: app.fetch, port });
  startReconciler(registry);
  startSettler(registry);
  startFundingCollector(registry);
  startLiquidator(registry);

  console.log(`unimarket API is running at http://localhost:${port}`);
};

void bootstrap();
