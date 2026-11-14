import { serve } from "@hono/node-server";
import { loadEnv } from "./config/env.js";
import { createPool, pingDatabase } from "./db/client.js";
import { createObjectStore } from "./adapters/object-store.js";
import { createJobQueue } from "./adapters/job-queue.js";
import { createLogger } from "./logging/logger.js";
import { createApp } from "./http/app.js";
import { registerDocs } from "./http/docs.js";
import { registerRoutes } from "./routes/index.js";
import { startWorker } from "./worker/run.js";
import { createAuth } from "./auth/auth.js";
import { createMailer } from "./adapters/mailer.js";
import { registerAuthRoutes } from "./http/auth-routes.js";
import { createAreaLabeler } from "./adapters/area-labeler.js";
import { processMedia } from "./catalog/process-media.js";
import { googleProviderConfig } from "./auth/google-config.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const pool = createPool(env.DATABASE_URL);
const objectStore = createObjectStore({
  endpoint: env.S3_ENDPOINT,
  publicEndpoint: env.S3_PUBLIC_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});
const queue = createJobQueue(env.DATABASE_URL);

if (env.APP_ROLE === "worker") {
  await queue.start();
  const stop = await startWorker({
    logger,
    queue,
    handlers: {
      "media.process": async (data) => {
        await processMedia(
          {
            db: pool,
            store: objectStore,
            privateBucket: env.S3_BUCKET_PRIVATE,
            publicBucket: env.S3_BUCKET_PUBLIC,
            logger,
          },
          String(data.mediaId),
        );
      },
    },
  });
  const shutdown = async () => {
    await stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  await queue.start();
  const auth = createAuth({
    pool,
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL,
    passkeyRpId: env.PASSKEY_RP_ID,
    passkeyOrigins: env.PASSKEY_ORIGINS,
    mailer: createMailer(env.SMTP_URL, env.MAIL_FROM),
    google: googleProviderConfig(env),
  });

  const app = createApp({ logger, env: env.NODE_ENV });
  registerAuthRoutes(app, auth);
  registerRoutes(app, {
    env: env.NODE_ENV,
    health: {
      pingDatabase: () => pingDatabase(pool),
      pingObjectStore: () => objectStore.ping(env.S3_BUCKET_PRIVATE),
    },
    identity: { db: pool, auth, labeler: createAreaLabeler({ googleApiKey: env.GOOGLE_MAPS_API_KEY, logger }) },
    catalog: {
      db: pool,
      auth,
      store: objectStore,
      queue,
      logger,
      privateBucket: env.S3_BUCKET_PRIVATE,
      publicBucket: env.S3_BUCKET_PUBLIC,
      mediaBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
    },
  });
  registerDocs(app);

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port, env: env.NODE_ENV }, "api listening");
  });

  const shutdown = () => {
    server.close(() => {
      queue
        .stop()
        .then(() => pool.end())
        .finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
