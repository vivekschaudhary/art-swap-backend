// Queue consumer for topic "media-process". Vercel invokes this function when a message arrives
// (see the experimentalTriggers entry in vercel.json). Failures are retried by Vercel Queues.
import { loadEnv } from "../../src/config/env.js";
import { buildJobRuntime } from "../../src/runtime.js";

const { queue } = buildJobRuntime(loadEnv());

export const POST = queue.consumerFor("media-process");
