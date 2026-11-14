import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { send } from "./http.ts";
import type { Session } from "./session.ts";
import { auth } from "./session.ts";

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));
export const photoWithGps = () => readFileSync(`${FIXTURE_DIR}photo-with-gps.jpg`);

type UploadSlot = { media_id: string; upload_url: string; headers: Record<string, string>; expires_at: string };

/** Requests a presigned slot, PUTs the bytes straight to the object store, then calls complete. */
export async function uploadMedia(s: Session, itemId: string, bytes: Buffer, mime = "image/jpeg") {
  const init = await send({
    method: "POST",
    path: `/v1/items/${itemId}/media/uploads`,
    headers: auth(s),
    body: { files: [{ mime, bytes: bytes.length }] },
  });
  if (init.status !== 200) return { init };
  const slot = (init.json as { uploads: UploadSlot[] }).uploads[0]!;
  const put = await fetch(slot.upload_url, { method: "PUT", headers: slot.headers, body: new Uint8Array(bytes) });
  const complete = await send({
    method: "POST",
    path: `/v1/items/${itemId}/media/complete`,
    headers: auth(s),
    body: { media_ids: [slot.media_id] },
  });
  return { init, put: put.status, complete, mediaId: slot.media_id };
}

type ItemBody = { media: { id: string; status: string; urls: Record<string, string>; variants?: Record<string, { w: number; h: number }> }[] };

/** Polls the item until its media reaches a terminal state, or fails after the deadline. */
export async function waitForMediaReady(s: Session, itemId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await send({ method: "GET", path: `/v1/items/${itemId}`, headers: auth(s) });
    const media = (res.json as ItemBody).media ?? [];
    if (media.length > 0 && media.every((m) => m.status === "ready" || m.status === "failed")) return media;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`media not processed within ${timeoutMs}ms`);
}

/** Reads the raw bytes of a served variant. */
export async function fetchVariant(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`variant ${url} returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
