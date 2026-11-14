import { PgBoss } from "pg-boss";

/**
 * Background jobs on Postgres (pg-boss, §8). The API enqueues; the worker runs handlers.
 * Jobs are retried with backoff and keyed so a repeated enqueue does nothing.
 */
export type JobQueue = {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(name: string, data: Record<string, unknown>, singletonKey?: string): Promise<void>;
  work(name: string, handler: (data: Record<string, unknown>) => Promise<void>): Promise<void>;
};

/** Every job name the app uses. Queues must exist before jobs are sent (pg-boss v12). */
export const QUEUE_NAMES = ["media.process"] as const;

export function createJobQueue(databaseUrl: string): JobQueue {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", () => {
    // Logged by the caller's logger through the worker process. Errors don't stop the API.
  });
  return {
    async start() {
      await boss.start();
      for (const name of QUEUE_NAMES) {
        if (!(await boss.getQueue(name))) await boss.createQueue(name);
      }
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 5_000 });
    },
    async send(name, data, singletonKey) {
      await boss.send(name, data, { singletonKey, retryLimit: 3, retryBackoff: true, retryDelay: 5 });
    },
    async work(name, handler) {
      await boss.work(name, async (jobs: { data: unknown }[]) => {
        for (const job of jobs) await handler(job.data as Record<string, unknown>);
      });
    },
  };
}
