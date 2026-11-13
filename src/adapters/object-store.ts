import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

/** S3-compatible object store (Cloudflare R2 in production, s3mock locally). Only the S3 API is used. */
export type ObjectStore = {
  ping(bucket: string): Promise<boolean>;
  ensureBucket(bucket: string): Promise<void>;
};

export function createObjectStore(opts: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): ObjectStore {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    forcePathStyle: true,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  return {
    async ping(bucket) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      } catch {
        return false;
      }
    },
    async ensureBucket(bucket) {
      const exists = await this.ping(bucket);
      if (!exists) await client.send(new CreateBucketCommand({ Bucket: bucket }));
    },
  };
}
