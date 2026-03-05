import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";

import { createApp, createDefaultRegistry } from "./app.js";
import { migrate } from "./db/client.js";
import { startReconciler } from "./reconciler.js";
import { startSettler } from "./settler.js";

const port = Number(process.env.PORT ?? 3100);
const serveWeb = process.env.SERVE_WEB_DIST === "true";

const bootstrap = async (): Promise<void> => {
  await migrate();

  const registry = createDefaultRegistry();
  const webDistPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const app = createApp({ registry, webDistPath, serveWeb });

  serve({ fetch: app.fetch, port });
  startReconciler(registry);
  startSettler(registry);

  console.log(`unimarket API is running at http://localhost:${port}`);
};

void bootstrap();
