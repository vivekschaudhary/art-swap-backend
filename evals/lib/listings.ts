import { expect } from "vitest";
import { send } from "./http.ts";
import { auth, type Session } from "./session.ts";
import { uploadMedia, waitForMediaReady, photoWithGps } from "./media.ts";

/** Sets a display name and a location, which completes onboarding (design §5.2). */
export async function onboardAt(s: Session, lat: number, lng: number) {
  const name = await send({ method: "PATCH", path: "/v1/me", headers: auth(s), body: { display_name: "Test User" } });
  expect(name.status, name.text).toBe(200);
  const loc = await send({ method: "PUT", path: "/v1/me/location", headers: auth(s), body: { lat, lng, search_radius_km: 25 } });
  expect(loc.status, loc.text).toBe(200);
}

export async function artCategoryId(s: Session): Promise<string> {
  const res = await send({ method: "GET", path: "/v1/categories", headers: auth(s) });
  const art = (res.json as { id: string; slug: string }[]).find((c) => c.slug === "art");
  expect(art, "the 'art' category must be seeded").toBeDefined();
  return art!.id;
}

/** Creates a draft, adds a photo, and publishes it. Returns the item id. */
export async function createPublishedItem(s: Session, title: string): Promise<string> {
  const categoryId = await artCategoryId(s);
  const draft = await send({
    method: "POST",
    path: "/v1/items",
    headers: auth(s),
    body: { category_id: categoryId, title, condition: "good", attributes: { medium: "oil" } },
  });
  expect(draft.status, draft.text).toBe(201);
  const id = (draft.json as { id: string }).id;
  const up = await uploadMedia(s, id, photoWithGps());
  expect(up.complete?.status, JSON.stringify(up.complete?.json)).toBe(202);
  await waitForMediaReady(s, id);
  const pub = await send({ method: "POST", path: `/v1/items/${id}/publish`, headers: auth(s) });
  expect(pub.status, pub.text).toBe(200);
  return id;
}
