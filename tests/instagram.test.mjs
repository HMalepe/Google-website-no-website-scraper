import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractHandle, engagementPct, parseDiscovery, lookup, handlesFromLeads, InstagramTokenError,
} from "../scripts/instagram.mjs";

test("extractHandle: profiles only", () => {
  assert.equal(extractHandle("https://www.instagram.com/thandis_hair/"), "thandis_hair");
  assert.equal(extractHandle("instagram.com/@nails.by.zee?igsh=abc"), "nails.by.zee");
  assert.equal(extractHandle("https://m.instagram.com/barber_joe"), "barber_joe");
  assert.equal(extractHandle("https://instagram.com/p/Cx123/"), null, "a post, not a profile");
  assert.equal(extractHandle("https://www.instagram.com/reels/abc"), null);
  assert.equal(extractHandle("https://www.facebook.com/thandis"), null);
  assert.equal(extractHandle("https://evilinstagram.com/x"), null);
  assert.equal(extractHandle(""), null);
});

test("engagementPct: mean likes+comments per post over followers", () => {
  assert.deepEqual(engagementPct(1000, [{ like_count: 30, comments_count: 10 }, { like_count: 10, comments_count: 0 }]), {
    value: 2.5,
    note: "",
  });
  assert.match(engagementPct(1000, [{ comments_count: 5 }]).note, /likes hidden/);
  assert.equal(engagementPct(0, [{ like_count: 1 }]).value, null);
});

test("parseDiscovery handles success and Meta errors", () => {
  const ok = parseDiscovery({ business_discovery: { followers_count: 5000, media_count: 120, media: { data: [{ like_count: 100, comments_count: 0 }] } } });
  assert.deepEqual(ok, { ok: true, followers: 5000, posts: 120, engagement: 2, note: "" });
  const err = parseDiscovery({ error: { code: 110, message: "Invalid user id" } });
  assert.equal(err.ok, false);
  assert.equal(err.code, 110);
});

test("lookup backs off on rate limits, then succeeds", async () => {
  const replies = [{ error: { code: 4, message: "Application request limit reached" } }, { business_discovery: { followers_count: 10, media_count: 1, media: { data: [] } } }];
  const waits = [];
  const res = await lookup("abc", {
    userId: "1", token: "t", fetchImpl: async () => ({ status: 200, json: async () => replies.shift() }),
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(waits, [30_000]);
});

test("lookup stops the run on a bad token", async () => {
  await assert.rejects(
    lookup("abc", { userId: "1", token: "t", fetchImpl: async () => ({ json: async () => ({ error: { code: 190, message: "expired" } }) }) }),
    InstagramTokenError
  );
});

test("handlesFromLeads dedupes and skips non-Instagram websites", () => {
  const out = handlesFromLeads([
    { website: "https://instagram.com/Joe" }, { website: "instagram.com/joe/" }, { website: "https://joe.co.za" },
  ]);
  assert.deepEqual(out.map((h) => h.handle), ["Joe"]);
});
