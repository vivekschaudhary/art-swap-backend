import type { Logger } from "../logging/logger.js";

/**
 * Worker role (APP_ROLE=worker). M1 only proves the process starts, reaches its dependencies and
 * heartbeats. Queue jobs (media, outbox, expiry) are added with their milestones (§8).
 */
export function startWorker(logger: Logger, heartbeatMs = 30_000) {
  logger.info({ role: "worker" }, "worker started");
  const timer = setInterval(() => logger.info({ role: "worker" }, "worker heartbeat"), heartbeatMs);
  return () => clearInterval(timer);
}
