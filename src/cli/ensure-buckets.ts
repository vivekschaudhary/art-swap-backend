// Local and CI only: creates the buckets the API expects in an S3-compatible dev store (s3mock).
// Production buckets are created in the provider dashboard. Idempotent. Retries while the store boots.
import { loadEnv } from "../config/env.js";
import { createObjectStore } from "../adapters/object-store.js";

const env = loadEnv();
const store = createObjectStore({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});

const buckets = [env.S3_BUCKET_PUBLIC, env.S3_BUCKET_PRIVATE];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    for (const bucket of buckets) await store.ensureBucket(bucket);
    process.stdout.write(`buckets ready: ${buckets.join(", ")}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`waiting for object store (attempt ${attempt}): ${(err as Error).name}\n`);
    await sleep(1_000);
  }
}
process.stderr.write("object store did not become ready\n");
process.exit(1);
