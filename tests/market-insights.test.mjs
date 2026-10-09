import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDay, hoursFlags, buildReport, mineComplaints } from "../scripts/market-insights.mjs";

test("parseDay reads Google Maps hours formats", () => {
  const cases = [
    [["9 am–5 pm"], { open: true, late: false }],
    [["12:30–10 pm"], { open: true, late: true }],
    [["Open 24 hours"], { open: true, late: true }],
    [["Closed"], { open: false, late: false }],
    [["6 pm–2 am"], { open: true, late: true }], // closes after midnight
    [["8 am–12 am"], { open: true, late: true }], // closes at midnight
    [["11 am–1:30 pm"], { open: true, late: false }],
    [["10 AM–7 PM"], { open: true, late: true }], // narrow no-break spaces
    [["9 am–12 pm", "2–6 pm"], { open: true, late: false }], // split shift
  ];
  for (const [slots, expected] of cases) assert.deepEqual(parseDay(slots), expected, JSON.stringify(slots));
});

test("hoursFlags: Sunday and evening flags, unknown when no hours", () => {
  const week = { Monday: ["9 am–5 pm"], Sunday: ["Closed"] };
  assert.deepEqual(hoursFlags(JSON.stringify(week)), { openSunday: false, openLate: false });
  assert.deepEqual(hoursFlags(""), { openSunday: null, openLate: null });
  assert.deepEqual(hoursFlags("{}"), { openSunday: null, openLate: null });
});

test("mineComplaints counts low-star themes only, once per review", () => {
  const rows = [
    { user_reviews: JSON.stringify([
      { Rating: 1, Description: "Waited 2 hours, so rude" },
      { Rating: 5, Description: "Waited a bit but lovely" },
    ]) },
  ];
  const { sample, themes } = mineComplaints(rows);
  assert.equal(sample, 1);
  const names = themes.map((t) => t.theme);
  assert.ok(names.includes("waiting / running late"));
  assert.ok(names.includes("staff attitude"));
});

test("buildReport ranks a poorly served busy area above a saturated one", () => {
  const week = (slot, sun) => JSON.stringify({ Monday: [slot], Sunday: [sun] });
  const mk = (id, i, rating, count, site, hours) => ({
    input_id: id, place_id: `${id}-${i}`, review_rating: String(rating), review_count: String(count),
    website: site, open_hours: hours, user_reviews: "[]",
  });
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => mk("q0", i, 3.9, 40, "", week("9 am–5 pm", "Closed"))),
    ...Array.from({ length: 6 }, (_, i) => mk("q1", i, 4.7, 500, "https://real.co.za", week("8 am–9 pm", "10 am–2 pm"))),
  ];
  const searches = [
    { id: "q0", area: "Randburg", category: "hair salons" },
    { id: "q1", area: "Sandton", category: "hair salons" },
  ];
  const [cat] = buildReport(rows, searches).categories;
  assert.equal(cat.category, "hair salons");
  assert.deepEqual(cat.areas.map((a) => a.area), ["Randburg", "Sandton"]);
  assert.equal(cat.areas[0].pctNoWebsite, 100);
  assert.equal(cat.areas[1].strong, 6);
  assert.match(cat.areas[0].angle, /Sunday hours are a gap/);
});

test("rows without a known search fall into one group", () => {
  const { categories } = buildReport([{ input_id: "", place_id: "x", review_count: "1" }], []);
  assert.equal(categories[0].category, "All searches");
});
