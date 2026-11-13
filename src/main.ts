import { serve } from "@hono/node-server";
import { loadEnv } from "./config/env.js";
import { createPool, pingDatabase } from "./db/client.js";
import { createObjectStore } from "./adapters/object-store.js";
import { createLogger } from "./logging/logger.js";
import { createApp } from "./http/app.js";
import { registerDocs } from "./http/docs.js";
import { registerRoutes } from "./routes/index.js";
import { startWorker } from "./worker/run.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const pool = createPool(env.DATABASE_URL);
const objectStore = createObjectStore({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});

if (env.APP_ROLE === "worker") {
  const stop = startWorker(logger);
  const shutdown = async () => {
    stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  const app = createApp({ logger, env: env.NODE_ENV });
  registerRoutes(app, {
    env: env.NODE_ENV,
    health: {
      pingDatabase: () => pingDatabase(pool),
      pingObjectStore: () => objectStore.ping(env.S3_BUCKET_PRIVATE),
    },
  });
  registerDocs(app);

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port, env: env.NODE_ENV }, "api listening");
  });

  const shutdown = () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
