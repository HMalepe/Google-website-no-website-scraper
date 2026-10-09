import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLeadsPdf, pdfText, groupLeads } from "../scripts/leads-pdf.mjs";

test("pdfText keeps Latin-1, maps smart punctuation, drops emoji", () => {
  assert.equal(pdfText("Thandi’s Café — “Best” 💇‍♀️"), `Thandi's Café - "Best"`);
});

test("PDF lists every business, with clickable phone, email and maps links", async () => {
  const leads = Array.from({ length: 14 }, (_, i) => ({
    business_name: `Biz ${i}`, status: i ? "NO_WEBSITE" : "OUTDATED_SITE", score: String(100 - i),
    category: i % 2 ? "Plumber" : "Hair salon", phone: `082 555 10${String(i).padStart(2, "0")}`,
    email: i === 0 ? "info@biz0.co.za" : "", google_maps_link: "https://www.google.com/maps/place/x",
    reasons: i === 0 ? "no HTTPS" : "", has_website: i ? "no" : "yes", website: i ? "" : "http://biz0.co.za",
  }));
  const pdf = await buildLeadsPdf({ leads, title: "Leads - Test", subtitle: "today" });
  const raw = pdf.toString("latin1");
  assert.ok(raw.startsWith("%PDF-"));
  const pages = (raw.match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 2, "14 cards should span pages");
  assert.ok(raw.includes("tel:0825551000"), "phone is a tel: link");
  assert.ok(raw.includes("mailto:info@biz0.co.za"), "email is a mailto: link");
  assert.ok(raw.includes("https://www.google.com/maps/place/x"), "maps link");
});

test("empty scan still produces a one-page PDF", async () => {
  const pdf = await buildLeadsPdf({ leads: [], title: "Leads", subtitle: "" });
  assert.equal((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1);
});

test("groups by the business type searched for, best leads first", () => {
  const groups = groupLeads([
    { business_name: "A", search_type: "barbers", category: "Barber shop", score: "85" },
    { business_name: "B", search_type: "barbers", category: "Hairdresser", score: "100" },
    { business_name: "C", search_type: "", category: "Plumber", score: "90" },
    { business_name: "D", category: "", score: "70" },
  ]);
  assert.deepEqual(groups.map(([name, list]) => [name, list.map((l) => l.business_name)]), [
    ["Barbers", ["B", "A"]],
    ["Other", ["D"]],
    ["Plumber", ["C"]],
  ]);
});
