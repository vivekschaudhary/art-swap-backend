/**
 * M4 Discovery scenarios (docs/v1-design.md §5.4, §7.7, §16.4).
 *
 * Contract details these scenarios pin down (also recorded in the design doc):
 * - Feed items carry `distance_km_rounded`: a whole number, at least 1.
 * - Feed requires onboarding. Without a location, it returns 403 ONBOARDING_REQUIRED.
 * - Swiping your own item returns 422 VALIDATION_FAILED.
 * - Undoing a swipe is idempotent: DELETE returns 204 whether or not a swipe existed.
 * - Likes are right-swiped items that are still available. Pending-swap filtering arrives with M5.
 *
 * Each run uses its own map area so results from earlier runs can't affect its assertions.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { send, type CapturedResponse } from "../../lib/http.ts";
import { formatMismatches, match } from "../../lib/match.ts";
import { signIn, auth, type Session } from "../../lib/session.ts";
import { onboardAt, createPublishedItem } from "../../lib/listings.ts";

const run = Date.now().toString(36);
const emailFor = (name: string) => `m4-${name}-${run}@example.test`;

// A random area per run, in the middle of the Pacific-free land mass of the US Midwest.
const base = { lat: 40 + (Math.random() - 0.5) * 2, lng: -95 + (Math.random() - 0.5) * 2 };
const kmToLat = (km: number) => km / 111;
const kmToLng = (km: number) => km / (111 * Math.cos((base.lat * Math.PI) / 180));

function expectProblem(res: CapturedResponse, status: number, code: string) {
  expect(res.status, res.text).toBe(status);
  expect(res.contentType).toMatch(/^application\/problem\+json/);
  const problems = match({ code, status, request_id: "$nonempty" }, res.json);
  expect(problems, formatMismatches(problems)).toEqual([]);
}

type FeedItem = { id: string; distance_km_rounded: number; owner: { id: string } };

async function feedFor(s: Session, query = "limit=50"): Promise<{ data: FeedItem[]; next_cursor: string | null }> {
  const res = await send({ method: "GET", path: `/v1/feed?${query}`, headers: auth(s) });
  expect(res.status, res.text).toBe(200);
  return res.json as { data: FeedItem[]; next_cursor: string | null };
}

let viewer: Session;
let nearSeller: Session;
let midSeller: Session;
let farSeller: Session;
let blockedSeller: Session;
let nearItem: string;
let midItem: string;
let farItem: string;
let blockedItem: string;

beforeAll(async () => {
  viewer = await signIn(emailFor("viewer"));
  await onboardAt(viewer, base.lat, base.lng);

  nearSeller = await signIn(emailFor("near"));
  await onboardAt(nearSeller, base.lat + kmToLat(3), base.lng + kmToLng(3));
  nearItem = await createPublishedItem(nearSeller, "Near item");

  midSeller = await signIn(emailFor("mid"));
  await onboardAt(midSeller, base.lat + kmToLat(10), base.lng);
  midItem = await createPublishedItem(midSeller, "Mid item");

  farSeller = await signIn(emailFor("far"));
  await onboardAt(farSeller, base.lat + kmToLat(500), base.lng);
  farItem = await createPublishedItem(farSeller, "Far item");

  blockedSeller = await signIn(emailFor("blocked"));
  await onboardAt(blockedSeller, base.lat + kmToLat(2), base.lng - kmToLng(2));
  blockedItem = await createPublishedItem(blockedSeller, "Blocked-seller item");
});

describe("M4 feed access", () => {
  it("a user without a location gets 403 ONBOARDING_REQUIRED", async () => {
    const newcomer = await signIn(emailFor("newcomer"));
    const res = await send({ method: "GET", path: "/v1/feed", headers: auth(newcomer) });
    expectProblem(res, 403, "ONBOARDING_REQUIRED");
  });

  it("GET /v1/feed without credentials → 401 UNAUTHENTICATED", async () => {
    const res = await send({ method: "GET", path: "/v1/feed" });
    expectProblem(res, 401, "UNAUTHENTICATED");
  });
});

describe("M4 feed contents", () => {
  it("shows nearby available items from other users, with rounded distance", async () => {
    const feed = await feedFor(viewer);
    const near = feed.data.find((i) => i.id === nearItem);
    expect(near, "the nearby item should be in the feed").toBeDefined();
    expect(Number.isInteger(near!.distance_km_rounded)).toBe(true);
    expect(near!.distance_km_rounded).toBeGreaterThanOrEqual(1);
  });

  it("excludes items beyond the viewer's search radius", async () => {
    const feed = await feedFor(viewer);
    expect(feed.data.map((i) => i.id)).not.toContain(farItem);
  });

  it("excludes the viewer's own items", async () => {
    const own = await createPublishedItem(viewer, "My own item");
    const feed = await feedFor(viewer);
    expect(feed.data.map((i) => i.id)).not.toContain(own);
  });

  it("orders nearer distance buckets first", async () => {
    const feed = await feedFor(viewer);
    const ids = feed.data.map((i) => i.id);
    expect(ids.indexOf(nearItem)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(midItem)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(nearItem)).toBeLessThan(ids.indexOf(midItem));
  });

  it("never exposes coordinates in the feed", async () => {
    const res = await send({ method: "GET", path: "/v1/feed?limit=50", headers: auth(viewer) });
    expect(res.text).not.toMatch(/"lat"|"lng"|"location"\s*:\s*\{\s*"lat/);
  });

  it("paginates with a cursor without duplicates or gaps", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page++) {
      const q = cursor ? `limit=5&cursor=${encodeURIComponent(cursor)}` : "limit=5";
      const feed = await feedFor(viewer, q);
      seen.push(...feed.data.map((i) => i.id));
      cursor = feed.next_cursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size, "no duplicates across pages").toBe(seen.length);
    expect(seen).toContain(nearItem);
    expect(seen).toContain(midItem);
  });
});

describe("M4 blocks", () => {
  it("hides a blocked user's items from the feed", async () => {
    const before = await feedFor(viewer);
    expect(before.data.map((i) => i.id)).toContain(blockedItem);

    const block = await send({ method: "POST", path: "/v1/blocks", headers: auth(viewer), body: { user_id: blockedSeller.userId } });
    expect(block.status).toBe(204);

    const after = await feedFor(viewer);
    expect(after.data.map((i) => i.id)).not.toContain(blockedItem);

    // The block is symmetric: the blocked user doesn't see the blocker's items either.
    const mine = await createPublishedItem(viewer, "Visible only to non-blocked users");
    const reverse = await feedFor(blockedSeller);
    expect(reverse.data.map((i) => i.id)).not.toContain(mine);
  });
});

describe("M4 swipes", () => {
  it("a right swipe returns next_action compose_swap", async () => {
    const res = await send({
      method: "POST",
      path: "/v1/swipes",
      headers: auth(viewer),
      body: { item_id: midItem, direction: "right" },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ next_action: "compose_swap" });
  });

  it("a left swipe removes the item from the feed and returns next_action none", async () => {
    const res = await send({
      method: "POST",
      path: "/v1/swipes",
      headers: auth(viewer),
      body: { item_id: nearItem, direction: "left" },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ next_action: "none" });
    const feed = await feedFor(viewer);
    expect(feed.data.map((i) => i.id)).not.toContain(nearItem);
  });

  it("undoing a left swipe brings the item back", async () => {
    const undo = await send({ method: "DELETE", path: `/v1/swipes/${nearItem}`, headers: auth(viewer) });
    expect(undo.status).toBe(204);
    const feed = await feedFor(viewer);
    expect(feed.data.map((i) => i.id)).toContain(nearItem);
  });

  it("undoing a swipe that doesn't exist is still 204", async () => {
    const undo = await send({ method: "DELETE", path: `/v1/swipes/${farItem}`, headers: auth(viewer) });
    expect(undo.status).toBe(204);
  });

  it("swiping your own item → 422 VALIDATION_FAILED", async () => {
    const own = await createPublishedItem(viewer, "Swipe on my own");
    const res = await send({ method: "POST", path: "/v1/swipes", headers: auth(viewer), body: { item_id: own, direction: "right" } });
    expectProblem(res, 422, "VALIDATION_FAILED");
  });

  it("swiping an item that isn't visible → 404 NOT_FOUND", async () => {
    const res = await send({ method: "POST", path: "/v1/swipes", headers: auth(viewer), body: { item_id: blockedItem, direction: "right" } });
    expectProblem(res, 404, "NOT_FOUND");
  });
});

describe("M4 likes", () => {
  it("lists right-swiped items that are still available", async () => {
    const res = await send({ method: "GET", path: "/v1/me/likes?limit=50", headers: auth(viewer) });
    expect(res.status, res.text).toBe(200);
    const ids = (res.json as { data: { id: string }[] }).data.map((i) => i.id);
    expect(ids).toContain(midItem);
    expect(ids).not.toContain(nearItem);
  });

  it("removing a like with a left swipe removes it from likes", async () => {
    await send({ method: "POST", path: "/v1/swipes", headers: auth(viewer), body: { item_id: midItem, direction: "left" } });
    const res = await send({ method: "GET", path: "/v1/me/likes?limit=50", headers: auth(viewer) });
    expect((res.json as { data: { id: string }[] }).data.map((i) => i.id)).not.toContain(midItem);
  });
});
