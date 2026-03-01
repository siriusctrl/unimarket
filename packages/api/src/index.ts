import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { migrate } from "./db/client.js";

const port = Number(process.env.PORT ?? 3100);

const bootstrap = async (): Promise<void> => {
  await migrate();

  const app = createApp();
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`paper-trade API is running at http://localhost:${port}`);
};

void bootstrap();
