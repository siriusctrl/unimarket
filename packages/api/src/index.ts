import { serve } from "@hono/node-server";

import { createApp, createDefaultRegistry } from "./app.js";
import { migrate } from "./db/client.js";
import { startReconciler } from "./reconciler.js";

const port = Number(process.env.PORT ?? 3100);

const bootstrap = async (): Promise<void> => {
  await migrate();

  const registry = createDefaultRegistry();
  const app = createApp({ registry });

  serve({ fetch: app.fetch, port });
  startReconciler(registry);

  console.log(`unimarket API is running at http://localhost:${port}`);
};

void bootstrap();
