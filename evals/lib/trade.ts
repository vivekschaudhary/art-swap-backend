import { expect } from "vitest";
import { send } from "./http.ts";
import { auth, signIn, type Session } from "./session.ts";
import { onboardAt, createPublishedItem } from "./listings.ts";

export type Trade = {
  recipient: Session;
  requester: Session;
  requestedItem: string; // owned by the recipient
  offeredItem: string; // owned by the requester
};

/** Two users, one listing each, plus the requested listing. Each call uses fresh accounts. */
export async function makeTrade(tag: string, base = { lat: 44 + Math.random(), lng: -92 + Math.random() }): Promise<Trade> {
  const run = `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const recipient = await signIn(`m5-r-${run}@example.test`);
  await onboardAt(recipient, base.lat, base.lng);
  const requester = await signIn(`m5-q-${run}@example.test`);
  await onboardAt(requester, base.lat + 0.01, base.lng + 0.01);
  const requestedItem = await createPublishedItem(recipient, "Wanted by requester");
  const offeredItem = await createPublishedItem(requester, "Offered by requester");
  return { recipient, requester, requestedItem, offeredItem };
}

export async function createSwap(t: Trade, extra: Record<string, unknown> = {}) {
  return send({
    method: "POST",
    path: "/v1/swaps",
    headers: auth(t.requester),
    body: { requested_item_id: t.requestedItem, offered_item_id: t.offeredItem, fulfillment_method: "local_pickup", ...extra },
  });
}

export async function swapOf(s: Session, id: string) {
  const res = await send({ method: "GET", path: `/v1/swaps/${id}`, headers: auth(s) });
  expect(res.status, res.text).toBe(200);
  return res.json as { id: string; status: string; version: number; events: { type: string }[] };
}

export async function itemOf(s: Session, id: string) {
  const res = await send({ method: "GET", path: `/v1/items/${id}`, headers: auth(s) });
  expect(res.status, res.text).toBe(200);
  return res.json as { id: string; status: string; owner: { id: string }; source: string; origin_item_id: string | null; media: { status: string }[] };
}
