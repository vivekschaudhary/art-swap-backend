import { PgBoss } from "pg-boss";
import { send as vercelSend, handleCallback as vercelHandleCallback } from "@vercel/queue";
import { TOPICS, type Topic } from "../jobs/topics.js";

/**
 * Background jobs (design §8). Two adapters, chosen by JOB_BACKEND:
 * - vercel: Vercel Queues in production. The API sends; each topic is consumed by its own
 *   Vercel Function (api/jobs/<topic>.ts), which Vercel invokes on delivery.
 * - pgboss: pg-boss on our Postgres, for local development and CI. A worker process consumes.
 *
 * Handlers must be idempotent. Both backends deliver at least once.
 */
export type JobData = Record<string, unknown>;
export type JobHandler = (data: JobData) => Promise<void>;

export type SendOptions = { singletonKey?: string; delaySeconds?: number };

export type JobQueue = {
  send(topic: Topic, data: JobData, opts?: SendOptions): Promise<void>;
  /** Registers the handler for a topic. Call before start(). */
  handle(topic: Topic, handler: JobHandler): void;
  /**
   * Prepares the backend. `consume` is true in a process that should run handlers (the pg-boss
   * worker). The Vercel backend ignores it, since Vercel delivers messages to function routes.
   */
  start(opts: { consume: boolean }): Promise<void>;
  stop(): Promise<void>;
  /** Vercel only: the Web handler for one topic's function route. */
  consumerFor(topic: Topic): (request: Request) => Promise<Response>;
};

export function createVercelJobQueue(): JobQueue {
  const handlers = new Map<Topic, JobHandler>();
  return {
    async send(topic, data, opts) {
      await vercelSend(topic, data, {
        idempotencyKey: opts?.singletonKey,
        delaySeconds: opts?.delaySeconds,
        retentionSeconds: 60 * 60 * 24,
      });
    },
    handle(topic, handler) {
      handlers.set(topic, handler);
    },
    async start() {
      // Nothing to start: Vercel invokes the consumer functions.
    },
    async stop() {},
    consumerFor(topic) {
      return vercelHandleCallback(async (message) => {
        const handler = handlers.get(topic);
        if (!handler) throw new Error(`no handler registered for ${topic}`);
        await handler(message as JobData);
      });
    },
  };
}

export function createPgBossJobQueue(databaseUrl: string): JobQueue {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", () => {
    // Surfaced by the worker's logger. Errors here must not stop the API.
  });
  const handlers = new Map<Topic, JobHandler>();
  return {
    async send(topic, data, opts) {
      await boss.send(topic, data, {
        singletonKey: opts?.singletonKey,
        startAfter: opts?.delaySeconds,
        retryLimit: 3,
        retryBackoff: true,
        retryDelay: 5,
      });
    },
    handle(topic, handler) {
      handlers.set(topic, handler);
    },
    async start({ consume }) {
      await boss.start();
      for (const topic of TOPICS) {
        if (!(await boss.getQueue(topic))) await boss.createQueue(topic);
      }
      if (!consume) return;
      for (const [topic, handler] of handlers) {
        await boss.work(topic, async (jobs: { data: unknown }[]) => {
          for (const job of jobs) await handler(job.data as JobData);
        });
      }
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 5_000 });
    },
    consumerFor() {
      throw new Error("consumerFor is only used by the Vercel backend");
    },
  };
}

export function createJobQueue(opts: { backend: "vercel" | "pgboss"; databaseUrl: string }): JobQueue {
  return opts.backend === "vercel" ? createVercelJobQueue() : createPgBossJobQueue(opts.databaseUrl);
}
