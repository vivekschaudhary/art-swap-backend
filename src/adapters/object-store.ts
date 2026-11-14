import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** S3-compatible object store (Cloudflare R2 in production, s3mock locally). Only the S3 API is used. */
export type ObjectStore = {
  ping(bucket: string): Promise<boolean>;
  ensureBucket(bucket: string): Promise<void>;
  presignPut(opts: { bucket: string; key: string; contentType: string; expiresInSeconds: number }): Promise<string>;
  head(bucket: string, key: string): Promise<{ size: number } | null>;
  read(bucket: string, key: string): Promise<Buffer>;
  readPrefix(bucket: string, key: string, bytes: number): Promise<Buffer>;
  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  deleteKeys(bucket: string, keys: string[]): Promise<void>;
};

export type ObjectStoreOptions = {
  endpoint: string;
  /** Address clients can reach, used only to sign upload URLs. Defaults to endpoint. */
  publicEndpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function createObjectStore(opts: ObjectStoreOptions): ObjectStore {
  const credentials = { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey };
  const client = new S3Client({ endpoint: opts.endpoint, region: opts.region, forcePathStyle: true, credentials });
  const signer = new S3Client({
    endpoint: opts.publicEndpoint ?? opts.endpoint,
    region: opts.region,
    forcePathStyle: true,
    credentials,
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
      if (!(await this.ping(bucket))) await client.send(new CreateBucketCommand({ Bucket: bucket }));
    },

    async presignPut({ bucket, key, contentType, expiresInSeconds }) {
      return getSignedUrl(signer, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), {
        expiresIn: expiresInSeconds,
      });
    },

    async head(bucket, key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: res.ContentLength ?? 0 };
      } catch {
        return null;
      }
    },

    async read(bucket, key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },

    async readPrefix(bucket, key, bytes) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },

    async put(bucket, key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },

    async deleteKeys(bucket, keys) {
      if (keys.length === 0) return;
      await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
      );
    },
  };
}
