import type pg from "pg";
import type { ObjectStore } from "../adapters/object-store.js";
import type { Logger } from "../logging/logger.js";
import { processMedia } from "../catalog/process-media.js";
import { mediaGc } from "./media-gc.js";
import type { JobData } from "../adapters/job-queue.js";
import type { CronJob, Topic } from "./topics.js";

export type JobDeps = {
  db: pg.Pool;
  store: ObjectStore;
  logger: Logger;
  privateBucket: string;
  publicBucket: string;
};

/** Queue handlers, keyed by topic. Each one only does work that is safe to repeat. */
export function queueHandlers(deps: JobDeps): Record<Topic, (data: JobData) => Promise<void>> {
  return {
    "media-process": async (data) => {
      await processMedia(deps, String(data.mediaId));
    },
  };
}

/** Cron handlers, keyed by name. */
export function cronHandlers(deps: JobDeps): Record<CronJob, () => Promise<Record<string, unknown>>> {
  return {
    "media-gc": () => mediaGc({ db: deps.db, store: deps.store, privateBucket: deps.privateBucket }),
  };
}
