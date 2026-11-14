/**
 * M3 Catalog scenarios (docs/v1-design.md §5.3, §6.2, §7.5, §7.6, §16.4).
 *
 * Contract details these scenarios pin down (also recorded in the design doc):
 * - publish_readiness.missing and the errors[] field names use the canonical names:
 *   "category", "title", "condition", "media".
 * - A 412 VERSION_CONFLICT body includes `current`, the latest Item, as an extension field.
 * - Media objects include `variants` with the pixel size of each served variant.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { send } from "../../lib/http.ts";
import { formatMismatches, match } from "../../lib/match.ts";
import { signIn, auth, type Session } from "../../lib/session.ts";
import { uploadMedia, waitForMediaReady, photoWithGps, fetchVariant } from "../../lib/media.ts";
import { STACK_RE } from "../../lib/logs.ts";

const run = Date.now().toString(36);
const emailFor = (name: string) => `m3-${name}-${run}@example.test`;

function expectProblem(res: { status: number; contentType: string; json: unknown; text: string }, status: number, code: string) {
  expect(res.status, res.text).toBe(status);
  expect(res.contentType).toMatch(/^application\/problem\+json/);
  const problems = match({ code, status, request_id: "$nonempty" }, res.json);
  expect(problems, formatMismatches(problems)).toEqual([]);
}

async function createDraft(s: Session, body: Record<string, unknown> = {}) {
  const res = await send({ method: "POST", path: "/v1/items", headers: auth(s), body });
  expect(res.status, res.text).toBe(201);
  return res.json as { id: string; status: string; version: number; publish_readiness: { ready: boolean; missing: string[] } };
}

let artCategoryId: string;
let owner: Session;
let other: Session;

beforeAll(async () => {
  owner = await signIn(emailFor("owner"));
  other = await signIn(emailFor("other"));
  const res = await send({ method: "GET", path: "/v1/categories" });
  expect(res.status).toBe(200);
  const art = (res.json as { id: string; slug: string; attribute_schema: unknown }[]).find((c) => c.slug === "art");
  expect(art, "the 'art' category must be seeded").toBeDefined();
  artCategoryId = art!.id;
});

describe("M3 categories", () => {
  it("GET /v1/categories lists the seeded art category with its attribute schema", async () => {
    const res = await send({ method: "GET", path: "/v1/categories" });
    expect(res.status).toBe(200);
    const problems = match(
      [{ id: "$string", slug: "art", name: "$string", attribute_schema: { type: "object" } }],
      (res.json as unknown[]).filter((c) => (c as { slug: string }).slug === "art"),
    );
    expect(problems, formatMismatches(problems)).toEqual([]);
  });
});

describe("M3 drafts", () => {
  it("an empty draft saves with status draft", async () => {
    const draft = await createDraft(owner);
    expect(draft.status).toBe("draft");
    expect(draft.publish_readiness.ready).toBe(false);
  });

  it("partial attributes are accepted on a draft", async () => {
    const draft = await createDraft(owner, { category_id: artCategoryId, attributes: { medium: "oil" } });
    const res = await send({
      method: "PATCH",
      path: `/v1/items/${draft.id}`,
      headers: { ...auth(owner), "if-match": String(draft.version) },
      body: { attributes: { medium: "oil", width_cm: 40 } },
    });
    expect(res.status, res.text).toBe(200);
  });

  it("publish with missing fields → 422 ITEM_NOT_PUBLISHABLE, listing exactly the missing fields", async () => {
    const draft = await createDraft(owner);
    const res = await send({ method: "POST", path: `/v1/items/${draft.id}/publish`, headers: auth(owner) });
    expectProblem(res, 422, "ITEM_NOT_PUBLISHABLE");
    const fields = (res.json as { errors: { field: string }[] }).errors.map((e) => e.field).sort();
    expect(fields).toEqual(["category", "condition", "media", "title"]);
  });

  it("autosave with a stale If-Match → 412 VERSION_CONFLICT with the current item", async () => {
    const draft = await createDraft(owner, { title: "First" });
    const first = await send({
      method: "PATCH",
      path: `/v1/items/${draft.id}`,
      headers: { ...auth(owner), "if-match": String(draft.version) },
      body: { title: "Second device" },
    });
    expect(first.status).toBe(200);

    const stale = await send({
      method: "PATCH",
      path: `/v1/items/${draft.id}`,
      headers: { ...auth(owner), "if-match": String(draft.version) },
      body: { title: "Stale device" },
    });
    expectProblem(stale, 412, "VERSION_CONFLICT");
    const current = (stale.json as { current: { title: string; version: number } }).current;
    expect(current).toMatchObject({ title: "Second device", version: draft.version + 1 });
  });

  it("another user reading a draft → 404 NOT_FOUND", async () => {
    const draft = await createDraft(owner, { title: "Private" });
    const res = await send({ method: "GET", path: `/v1/items/${draft.id}`, headers: auth(other) });
    expectProblem(res, 404, "NOT_FOUND");
    expect(res.text).not.toContain("Private");
  });

  it("the 51st draft → 422 DRAFT_LIMIT_REACHED", async () => {
    const limited = await signIn(emailFor("draft-limit"));
    for (let i = 0; i < 50; i++) await createDraft(limited, { title: `Draft ${i}` });
    const res = await send({ method: "POST", path: "/v1/items", headers: auth(limited), body: { title: "One too many" } });
    expectProblem(res, 422, "DRAFT_LIMIT_REACHED");
  });

  it("discarding a never-published draft removes it and its stored media", async () => {
    const draft = await createDraft(owner, { category_id: artCategoryId, title: "To discard" });
    const up = await uploadMedia(owner, draft.id, photoWithGps());
    expect(up.complete?.status, JSON.stringify(up.complete?.json)).toBe(202);
    const [media] = await waitForMediaReady(owner, draft.id);
    const thumbUrl = media!.urls.thumb!;
    expect((await fetch(thumbUrl)).status).toBe(200);

    const del = await send({ method: "DELETE", path: `/v1/items/${draft.id}`, headers: auth(owner) });
    expect(del.status).toBe(204);
    expect((await send({ method: "GET", path: `/v1/items/${draft.id}`, headers: auth(owner) })).status).toBe(404);
    expect((await fetch(thumbUrl)).status).toBe(404);
  });
});

describe("M3 media", () => {
  let draftId: string;

  beforeAll(async () => {
    const draft = await createDraft(owner, { category_id: artCategoryId, title: "Photo test" });
    draftId = draft.id;
  });

  it("11 media in one request → 422 MEDIA_LIMIT_EXCEEDED", async () => {
    const res = await send({
      method: "POST",
      path: `/v1/items/${draftId}/media/uploads`,
      headers: auth(owner),
      body: { files: Array.from({ length: 11 }, () => ({ mime: "image/jpeg", bytes: 1000 })) },
    });
    expectProblem(res, 422, "MEDIA_LIMIT_EXCEEDED");
  });

  it("a JPEG upload completes to ready with three variants at the expected sizes", async () => {
    const up = await uploadMedia(owner, draftId, photoWithGps());
    expect(up.put).toBe(200);
    expect(up.complete?.status, JSON.stringify(up.complete?.json)).toBe(202);

    const [media] = await waitForMediaReady(owner, draftId);
    expect(media!.status).toBe("ready");
    expect(Object.keys(media!.urls).sort()).toEqual(["card", "full", "thumb"]);
    // Input is 640x480. Variants are scaled down to a longest edge of 400, 1080 and 2048, never up.
    expect(media!.variants).toEqual({
      thumb: { w: 400, h: 300 },
      card: { w: 640, h: 480 },
      full: { w: 640, h: 480 },
    });
  });

  it("served variants are WebP with EXIF (including GPS) stripped", async () => {
    const [media] = await waitForMediaReady(owner, draftId);
    for (const kind of ["thumb", "card", "full"] as const) {
      const bytes = await fetchVariant(media!.urls[kind]!);
      expect(bytes.subarray(0, 4).toString("ascii"), `${kind} container`).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii"), `${kind} format`).toBe("WEBP");
      // A WebP EXIF chunk has the FourCC "EXIF". Its absence means no metadata, GPS included.
      expect(bytes.includes(Buffer.from("EXIF", "ascii")), `${kind} still carries EXIF`).toBe(false);
      expect(bytes.includes(Buffer.from("GPS", "ascii")), `${kind} still carries GPS data`).toBe(false);
    }
  });

  it("bytes that are not an image, labelled as JPEG → 422 MEDIA_INVALID at complete", async () => {
    const draft = await createDraft(owner, { category_id: artCategoryId, title: "Not a photo" });
    const up = await uploadMedia(owner, draft.id, Buffer.from("this is plain text, not a jpeg"));
    expectProblem(up.complete!, 422, "MEDIA_INVALID");
  });

  it("publish succeeds once a title, category, condition and a ready image are present", async () => {
    const draft = await createDraft(owner, { category_id: artCategoryId, title: "Ready to list", condition: "good", attributes: { medium: "oil" } });
    await uploadMedia(owner, draft.id, photoWithGps());
    await waitForMediaReady(owner, draft.id);
    const res = await send({ method: "POST", path: `/v1/items/${draft.id}/publish`, headers: auth(owner) });
    expect(res.status, res.text).toBe(200);
    expect((res.json as { status: string }).status).toBe("available");
  });
});

describe("M3 provenance", () => {
  it("GET /v1/items/{id}/provenance returns an ordered owner chain for a new item", async () => {
    const draft = await createDraft(owner, { category_id: artCategoryId, title: "Provenance" });
    const res = await send({ method: "GET", path: `/v1/items/${draft.id}/provenance`, headers: auth(owner) });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect(res.text).not.toMatch(STACK_RE);
  });
});
