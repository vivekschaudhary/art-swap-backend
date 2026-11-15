import { serve } from "@hono/node-server";
import { loadEnv } from "./config/env.js";
import { buildApp, buildJobRuntime } from "./runtime.js";
import { startWorker } from "./worker/run.js";

// Local entry point (docker-compose and the local dev server). Production runs the functions in api/.
const env = loadEnv();
const rt = buildJobRuntime(env);

if (env.APP_ROLE === "worker") {
  await rt.queue.start({ consume: true });
  const stop = await startWorker({
    logger: rt.logger,
    queue: rt.queue,
    handlers: {},
  });
  const shutdown = async () => {
    await stop();
    await rt.pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  await rt.queue.start({ consume: false });
  const app = buildApp(rt);
  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    rt.logger.info({ port: info.port, env: env.NODE_ENV, jobs: env.JOB_BACKEND }, "api listening");
  });
  const shutdown = () => {
    server.close(() => {
      rt.queue
        .stop()
        .then(() => rt.pool.end())
        .finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
