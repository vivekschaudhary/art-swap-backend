import type { JobQueue, JobHandler } from "../adapters/job-queue.js";
import type { Logger } from "../logging/logger.js";

/**
 * Worker role (APP_ROLE=worker), local only. The pg-boss adapter consumes jobs in this process.
 * On Vercel there is no worker: each topic runs in its own function (api/jobs/).
 */
export async function startWorker(opts: {
  logger: Logger;
  queue: JobQueue;
  handlers: Record<string, JobHandler>;
  heartbeatMs?: number;
}) {
  opts.logger.info({ role: "worker" }, "worker started");
  const timer = setInterval(() => opts.logger.info({ role: "worker" }, "worker heartbeat"), opts.heartbeatMs ?? 30_000);
  return async () => {
    clearInterval(timer);
    await opts.queue.stop();
  };
}
