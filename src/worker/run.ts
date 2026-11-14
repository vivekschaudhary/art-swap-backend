import type { JobQueue } from "../adapters/job-queue.js";
import type { Logger } from "../logging/logger.js";

/**
 * Worker role (APP_ROLE=worker). Registers the job handlers and heartbeats. Queue jobs run here,
 * never in the API (§3, §8). Handlers are idempotent, so retries are safe.
 */
export async function startWorker(opts: {
  logger: Logger;
  queue: JobQueue;
  handlers: Record<string, (data: Record<string, unknown>) => Promise<void>>;
  heartbeatMs?: number;
}) {
  for (const [name, handler] of Object.entries(opts.handlers)) {
    await opts.queue.work(name, handler);
  }
  opts.logger.info({ role: "worker", jobs: Object.keys(opts.handlers) }, "worker started");
  const timer = setInterval(() => opts.logger.info({ role: "worker" }, "worker heartbeat"), opts.heartbeatMs ?? 30_000);
  return async () => {
    clearInterval(timer);
    await opts.queue.stop();
  };
}
