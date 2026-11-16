import type { Env } from "./config/env.js";
import { createPool, pingDatabase } from "./db/client.js";
import { createObjectStore } from "./adapters/object-store.js";
import { createJobQueue, type JobQueue } from "./adapters/job-queue.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { createAuth } from "./auth/auth.js";
import { createMailer } from "./adapters/mailer.js";
import { createAreaLabeler } from "./adapters/area-labeler.js";
import { createRealtime } from "./adapters/realtime.js";
import { googleProviderConfig } from "./auth/google-config.js";
import { createApp } from "./http/app.js";
import { registerAuthRoutes } from "./http/auth-routes.js";
import { registerDocs } from "./http/docs.js";
import { registerRoutes } from "./routes/index.js";
import { registerInternalJobRoutes } from "./http/internal-jobs.js";
import { cronHandlers, queueHandlers } from "./jobs/handlers.js";
import type pg from "pg";
import type { ObjectStore } from "./adapters/object-store.js";

export type JobRuntime = {
  env: Env;
  logger: Logger;
  pool: pg.Pool;
  store: ObjectStore;
  queue: JobQueue;
};

/** Shared wiring for the job side: the database, storage, logging and the queue backend. */
export function buildJobRuntime(env: Env): JobRuntime {
  const logger = createLogger(env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL);
  const store = createObjectStore({
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  const queue = createJobQueue({ backend: env.JOB_BACKEND, databaseUrl: env.DATABASE_URL });
  const deps = { db: pool, store, logger, privateBucket: env.S3_BUCKET_PRIVATE, publicBucket: env.S3_BUCKET_PUBLIC };
  for (const [topic, handler] of Object.entries(queueHandlers(deps))) {
    queue.handle(topic as never, handler);
  }
  return { env, logger, pool, store, queue };
}

/** The full HTTP app: routes, auth, docs and internal job routes. */
export function buildApp(rt: JobRuntime) {
  const { env, pool, store, queue, logger } = rt;
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
      pingObjectStore: () => store.ping(env.S3_BUCKET_PRIVATE),
    },
    identity: { db: pool, auth, labeler: createAreaLabeler({ googleApiKey: env.GOOGLE_MAPS_API_KEY, logger }) },
    catalog: {
      db: pool,
      auth,
      store,
      queue,
      logger,
      privateBucket: env.S3_BUCKET_PRIVATE,
      publicBucket: env.S3_BUCKET_PUBLIC,
      mediaBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
    },
    discovery: { db: pool, auth, publicBucket: env.S3_BUCKET_PUBLIC, mediaBaseUrl: env.MEDIA_PUBLIC_BASE_URL },
    messaging: { db: pool, auth, realtime: createRealtime(env.ABLY_API_KEY), logger },
    swaps: {
      db: pool,
      auth,
      store,
      privateBucket: env.S3_BUCKET_PRIVATE,
      publicBucket: env.S3_BUCKET_PUBLIC,
      mediaBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
    },
  });
  registerInternalJobRoutes(app, { cronSecret: env.CRON_SECRET, handlers: cronHandlers({ db: pool, store, logger, privateBucket: env.S3_BUCKET_PRIVATE, publicBucket: env.S3_BUCKET_PUBLIC }), logger });
  registerDocs(app);
  return app;
}
