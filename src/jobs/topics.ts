/**
 * Queue topics (design §8). Vercel topic names are lowercase with dashes, so they match here too.
 * Adding a topic means adding it here, a function file under api/jobs/, and a trigger in vercel.json.
 */
export const TOPICS = ["media-process"] as const;
export type Topic = (typeof TOPICS)[number];

/** Cron jobs, invoked by Vercel Cron through /internal/jobs/cron/<name> (design §8). */
export const CRON_JOBS = ["media-gc"] as const;
export type CronJob = (typeof CRON_JOBS)[number];
