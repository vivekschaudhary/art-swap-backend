/**
 * M5 Swaps scenarios (docs/v1-design.md §5.5, §6.1, §7.8, §12, §16.4).
 *
 * Contract details (also recorded in the design doc):
 * - Accepting a swap reserves both items. Other pending swaps on those items become `unavailable`.
 * - Only the recipient accepts or declines. Only the requester withdraws.
 * - Completion happens after both sides confirm receipt. Each side gets a clone of the item it
 *   received, as a draft with source `swap_received` and origin_item_id set. The originals become `swapped`.
 * - Expiry runs through the cron route. Tests move a swap past its deadline with the test-only
 *   route POST /v1/__test/backdate-swap, which sets expires_at to one second ago.
 * - Idempotency-Key on POST /v1/swaps: the same key and body replays the same response.
 */
import { describe, expect, it } from "vitest";
import { send, type CapturedResponse } from "../../lib/http.ts";
import { formatMismatches, match } from "../../lib/match.ts";
import { auth, signIn } from "../../lib/session.ts";
import { makeTrade, createSwap, swapOf, itemOf } from "../../lib/trade.ts";
import { onboardAt, createPublishedItem } from "../../lib/listings.ts";

const CRON_SECRET = process.env.EVALS_CRON_SECRET ?? "local-cron-secret-0123456789";

function expectProblem(res: CapturedResponse, status: number, code: string) {
  expect(res.status, res.text).toBe(status);
  expect(res.contentType).toMatch(/^application\/problem\+json/);
  const problems = match({ code, status, request_id: "$nonempty" }, res.json);
  expect(problems, formatMismatches(problems)).toEqual([]);
}

describe("M5 creating a swap", () => {
  it("creates a pending swap with a 28-day expiry and item snapshots", async () => {
    const t = await makeTrade("create");
    const res = await createSwap(t, { note: "Would you swap?" });
    expect(res.status, res.text).toBe(201);
    const body = res.json as { status: string; expires_at: string; my_role: string; requester: { items: { snapshot: { title: string } }[] } };
    expect(body.status).toBe("pending");
    expect(body.my_role).toBe("requester");
    const days = (new Date(body.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27.9);
    expect(days).toBeLessThan(28.1);
  });

  it("requesting an item you own → 422 SWAP_OWN_ITEM", async () => {
    const t = await makeTrade("own-requested");
    const res = await send({
      method: "POST",
      path: "/v1/swaps",
      headers: auth(t.requester),
      body: { requested_item_id: t.offeredItem, offered_item_id: t.offeredItem, fulfillment_method: "local_pickup" },
    });
    expectProblem(res, 422, "SWAP_OWN_ITEM");
  });

  it("offering someone else's item → 422 SWAP_OWN_ITEM", async () => {
    const t = await makeTrade("not-mine");
    const res = await send({
      method: "POST",
      path: "/v1/swaps",
      headers: auth(t.requester),
      body: { requested_item_id: t.requestedItem, offered_item_id: t.requestedItem, fulfillment_method: "local_pickup" },
    });
    expectProblem(res, 422, "SWAP_OWN_ITEM");
  });

  it("shipping is not available in v1 → 422 FULFILLMENT_NOT_SUPPORTED", async () => {
    const t = await makeTrade("shipping");
    const res = await createSwap(t, { fulfillment_method: "shipping" });
    expectProblem(res, 422, "FULFILLMENT_NOT_SUPPORTED");
  });

  it("an item that isn't available → 409 SWAP_ITEM_UNAVAILABLE", async () => {
    const t = await makeTrade("draft-offer");
    const draft = await send({ method: "POST", path: "/v1/items", headers: auth(t.requester), body: { title: "Still a draft" } });
    const draftId = (draft.json as { id: string }).id;
    const res = await send({
      method: "POST",
      path: "/v1/swaps",
      headers: auth(t.requester),
      body: { requested_item_id: t.requestedItem, offered_item_id: draftId, fulfillment_method: "local_pickup" },
    });
    expectProblem(res, 409, "SWAP_ITEM_UNAVAILABLE");
  });

  it("a second pending swap for the same item by the same requester → 409 SWAP_DUPLICATE", async () => {
    const t = await makeTrade("duplicate");
    expect((await createSwap(t)).status).toBe(201);
    expectProblem(await createSwap(t), 409, "SWAP_DUPLICATE");
  });

  it("replaying the same Idempotency-Key returns the same swap and creates one", async () => {
    const t = await makeTrade("idempotent");
    const headers = { ...auth(t.requester), "idempotency-key": `k-${Date.now()}` };
    const body = { requested_item_id: t.requestedItem, offered_item_id: t.offeredItem, fulfillment_method: "local_pickup" };
    const first = await send({ method: "POST", path: "/v1/swaps", headers, body });
    const second = await send({ method: "POST", path: "/v1/swaps", headers, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(first.status);
    expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
  });

  it("blocked in either direction → 403 USER_BLOCKED", async () => {
    const t = await makeTrade("blocked");
    await send({ method: "POST", path: "/v1/blocks", headers: auth(t.recipient), body: { user_id: t.requester.userId } });
    expectProblem(await createSwap(t), 403, "USER_BLOCKED");
  });
});

describe("M5 accepting and declining", () => {
  it("the recipient accepts: swap accepted, both items reserved", async () => {
    const t = await makeTrade("accept");
    const created = (await createSwap(t)).json as { id: string };
    const current = await swapOf(t.recipient, created.id);
    const res = await send({
      method: "POST",
      path: `/v1/swaps/${created.id}/accept`,
      headers: { ...auth(t.recipient), "if-match": String(current.version) },
    });
    expect(res.status, res.text).toBe(200);
    expect((res.json as { status: string }).status).toBe("accepted");
    expect((await itemOf(t.recipient, t.requestedItem)).status).toBe("reserved");
    expect((await itemOf(t.requester, t.offeredItem)).status).toBe("reserved");
  });

  it("accepting invalidates other pending swaps on the same item", async () => {
    const t = await makeTrade("invalidate");
    const first = (await createSwap(t)).json as { id: string };
    const other = await signIn(`m5-other-${Date.now().toString(36)}@example.test`);
    await onboardAt(other, 44.2, -92.2);
    const otherItem = await createPublishedItem(other, "Other offer");
    const second = (await send({
      method: "POST",
      path: "/v1/swaps",
      headers: auth(other),
      body: { requested_item_id: t.requestedItem, offered_item_id: otherItem, fulfillment_method: "local_pickup" },
    })).json as { id: string };

    await send({ method: "POST", path: `/v1/swaps/${first.id}/accept`, headers: auth(t.recipient) });
    expect((await swapOf(t.recipient, first.id)).status).toBe("accepted");
    expect((await swapOf(other, second.id)).status).toBe("unavailable");
  });

  it("only the recipient can accept → 403 FORBIDDEN for the requester", async () => {
    const t = await makeTrade("wrong-party");
    const created = (await createSwap(t)).json as { id: string };
    const res = await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.requester) });
    expectProblem(res, 403, "FORBIDDEN");
  });

  it("accepting with a stale If-Match → 412 VERSION_CONFLICT", async () => {
    const t = await makeTrade("stale");
    const created = (await createSwap(t)).json as { id: string; version: number };
    const res = await send({
      method: "POST",
      path: `/v1/swaps/${created.id}/accept`,
      headers: { ...auth(t.recipient), "if-match": String(created.version + 5) },
    });
    expectProblem(res, 412, "VERSION_CONFLICT");
  });

  it("accepting a declined swap → 409 SWAP_INVALID_TRANSITION", async () => {
    const t = await makeTrade("declined-accept");
    const created = (await createSwap(t)).json as { id: string };
    expect((await send({ method: "POST", path: `/v1/swaps/${created.id}/decline`, headers: auth(t.recipient), body: {} })).status).toBe(200);
    expectProblem(await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.recipient) }), 409, "SWAP_INVALID_TRANSITION");
  });

  it("two accepts racing for the same item: exactly one wins", async () => {
    const t = await makeTrade("race");
    const a = (await createSwap(t)).json as { id: string };
    const rival = await signIn(`m5-rival-${Date.now().toString(36)}@example.test`);
    await onboardAt(rival, 44.3, -92.3);
    const rivalItem = await createPublishedItem(rival, "Rival offer");
    const b = (await send({
      method: "POST",
      path: "/v1/swaps",
      headers: auth(rival),
      body: { requested_item_id: t.requestedItem, offered_item_id: rivalItem, fulfillment_method: "local_pickup" },
    })).json as { id: string };

    const [r1, r2] = await Promise.all([
      send({ method: "POST", path: `/v1/swaps/${a.id}/accept`, headers: auth(t.recipient) }),
      send({ method: "POST", path: `/v1/swaps/${b.id}/accept`, headers: auth(t.recipient) }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(["SWAP_ITEM_UNAVAILABLE", "SWAP_INVALID_TRANSITION"]).toContain((loser.json as { code: string }).code);
  });

  it("the recipient declines; only the requester can withdraw", async () => {
    const t = await makeTrade("decline-withdraw");
    const one = (await createSwap(t)).json as { id: string };
    expect((await send({ method: "POST", path: `/v1/swaps/${one.id}/decline`, headers: auth(t.recipient), body: {} })).status).toBe(200);
    expect((await swapOf(t.recipient, one.id)).status).toBe("declined");

    const two = (await createSwap(t)).json as { id: string };
    expectProblem(await send({ method: "POST", path: `/v1/swaps/${two.id}/withdraw`, headers: auth(t.recipient) }), 403, "FORBIDDEN");
    expect((await send({ method: "POST", path: `/v1/swaps/${two.id}/withdraw`, headers: auth(t.requester) })).status).toBe(200);
    expect((await swapOf(t.requester, two.id)).status).toBe("withdrawn");
  });
});

describe("M5 cancelling and expiry", () => {
  it("cancelling an accepted swap needs a reason and frees both items", async () => {
    const t = await makeTrade("cancel");
    const created = (await createSwap(t)).json as { id: string };
    await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.recipient) });

    expectProblem(await send({ method: "POST", path: `/v1/swaps/${created.id}/cancel`, headers: auth(t.requester), body: {} }), 400, "VALIDATION_FAILED");

    const res = await send({ method: "POST", path: `/v1/swaps/${created.id}/cancel`, headers: auth(t.requester), body: { reason: "Changed my mind" } });
    expect(res.status, res.text).toBe(200);
    expect((await swapOf(t.requester, created.id)).status).toBe("cancelled");
    expect((await itemOf(t.recipient, t.requestedItem)).status).toBe("available");
  });

  it("a pending swap past its deadline expires through the cron job", async () => {
    const t = await makeTrade("expire");
    const created = (await createSwap(t)).json as { id: string };
    const back = await send({ method: "POST", path: "/v1/__test/backdate-swap", body: { swap_id: created.id } });
    expect(back.status, back.text).toBe(204);

    const run = await send({ method: "GET", path: "/internal/jobs/cron/swaps-expire", headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(run.status, run.text).toBe(200);
    expect((await swapOf(t.recipient, created.id)).status).toBe("expired");
  });

  it("the expiry job rejects requests without the cron secret", async () => {
    const res = await send({ method: "GET", path: "/internal/jobs/cron/swaps-expire" });
    expectProblem(res, 401, "UNAUTHENTICATED");
  });

  it("accepting an expired swap → 409 SWAP_EXPIRED", async () => {
    const t = await makeTrade("late-accept");
    const created = (await createSwap(t)).json as { id: string };
    await send({ method: "POST", path: "/v1/__test/backdate-swap", body: { swap_id: created.id } });
    expectProblem(await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.recipient) }), 409, "SWAP_EXPIRED");
  });
});

describe("M5 completion and history", () => {
  it("both sides confirming completes the swap and transfers ownership by clone", async () => {
    const t = await makeTrade("complete");
    const created = (await createSwap(t)).json as { id: string };
    await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.recipient) });

    const first = await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.recipient) });
    expect(first.status).toBe(200);
    expect((await swapOf(t.recipient, created.id)).status).toBe("accepted");

    const second = await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.requester) });
    expect(second.status, second.text).toBe(200);
    expect((await swapOf(t.requester, created.id)).status).toBe("completed");

    // Originals are retired.
    expect((await itemOf(t.recipient, t.requestedItem)).status).toBe("swapped");
    expect((await itemOf(t.requester, t.offeredItem)).status).toBe("swapped");

    // Each side received a clone as a draft, with provenance back to the original.
    const mine = await send({ method: "GET", path: "/v1/me/drafts?limit=50", headers: auth(t.requester) });
    const clones = (mine.json as { data: { source: string; origin_item_id: string | null }[] }).data;
    expect(clones.some((c) => c.source === "swap_received" && c.origin_item_id === t.requestedItem)).toBe(true);
  });

  it("the clone carries copies of the photos", async () => {
    const t = await makeTrade("clone-media");
    const created = (await createSwap(t)).json as { id: string };
    await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.recipient) });
    await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.recipient) });
    await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.requester) });

    const drafts = (await send({ method: "GET", path: "/v1/me/drafts?limit=50", headers: auth(t.requester) })).json as {
      data: { id: string; origin_item_id: string | null }[];
    };
    const clone = drafts.data.find((d) => d.origin_item_id === t.requestedItem);
    expect(clone, "a clone should exist").toBeDefined();
    const item = await itemOf(t.requester, clone!.id);
    expect(item.media.length).toBeGreaterThan(0);
    expect(item.media.some((m) => m.status === "ready")).toBe(true);
  });

  it("completed swaps appear in both users' history", async () => {
    const t = await makeTrade("history");
    const created = (await createSwap(t)).json as { id: string };
    await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.recipient) });
    await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.recipient) });
    await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.requester) });
    for (const who of [t.requester, t.recipient]) {
      const h = await send({ method: "GET", path: "/v1/me/history", headers: auth(who) });
      expect((h.json as { data: { id: string }[] }).data.map((s) => s.id)).toContain(created.id);
    }
  });

  it("the swap timeline records each step in order", async () => {
    const t = await makeTrade("timeline");
    const created = (await createSwap(t)).json as { id: string };
    await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.recipient) });
    await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.recipient) });
    await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.requester) });
    const types = (await swapOf(t.requester, created.id)).events.map((e) => e.type);
    expect(types).toEqual(["created", "accepted", "received_confirmed", "received_confirmed", "completed"]);
  });

  it("cancelling a completed swap → 409 SWAP_INVALID_TRANSITION", async () => {
    const t = await makeTrade("cancel-done");
    const created = (await createSwap(t)).json as { id: string };
    await send({ method: "POST", path: `/v1/swaps/${created.id}/accept`, headers: auth(t.recipient) });
    await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.recipient) });
    await send({ method: "POST", path: `/v1/swaps/${created.id}/confirm-received`, headers: auth(t.requester) });
    expectProblem(await send({ method: "POST", path: `/v1/swaps/${created.id}/cancel`, headers: auth(t.requester), body: { reason: "Too late" } }), 409, "SWAP_INVALID_TRANSITION");
  });
});

describe("M5 visibility and listing", () => {
  it("lists incoming and outgoing swaps for each side", async () => {
    const t = await makeTrade("lists");
    const created = (await createSwap(t)).json as { id: string };
    const incoming = await send({ method: "GET", path: "/v1/swaps?role=incoming", headers: auth(t.recipient) });
    const outgoing = await send({ method: "GET", path: "/v1/swaps?role=outgoing", headers: auth(t.requester) });
    expect((incoming.json as { data: { id: string }[] }).data.map((s) => s.id)).toContain(created.id);
    expect((outgoing.json as { data: { id: string }[] }).data.map((s) => s.id)).toContain(created.id);
  });

  it("a stranger cannot see a swap → 404 NOT_FOUND", async () => {
    const t = await makeTrade("stranger");
    const created = (await createSwap(t)).json as { id: string };
    const stranger = await signIn(`m5-stranger-${Date.now().toString(36)}@example.test`);
    expectProblem(await send({ method: "GET", path: `/v1/swaps/${created.id}`, headers: auth(stranger) }), 404, "NOT_FOUND");
  });
});
