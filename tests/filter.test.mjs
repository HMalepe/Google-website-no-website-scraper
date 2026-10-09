import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCsvObjects } from "../scripts/lib-csv.mjs";

const FILTER = new URL("../scripts/filter-no-website.mjs", import.meta.url).pathname;

function runFilter(csv, extraArgs = [], env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "filter-"));
  const input = join(dir, "results.csv");
  writeFileSync(input, csv);
  execFileSync(process.execPath, [FILTER, input, dir, ...extraArgs], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  return {
    leads: readCsvObjects(join(dir, "leads.csv")),
    summary: JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")),
  };
}

const CSV = `title,website,phone,place_id,review_count
No Site Mobile,,082 123 4567,p1,40
No Site Mobile,,082 123 4567,p1,40
Landline Only,,011 555 1234,p2,9
FB Only,https://www.facebook.com/x,+27 72 111 2222,p3,5
QuickFix,https://www.quickfix.com,083 000 0000,p4,3
Dead GBP,https://old.business.site,084 000 0000,p5,1
Wix,https://a.wixsite.com/b,060 000 0000,p6,1
`;

test("classifies leads, dedupes, ranks best first", () => {
  const { leads, summary } = runFilter(CSV);
  assert.equal(summary.duplicatesRemoved, 1);
  const byName = Object.fromEntries(leads.map((l) => [l.business_name, l]));
  assert.equal(byName["No Site Mobile"].status, "NO_WEBSITE");
  assert.equal(byName["FB Only"].status, "SOCIAL_ONLY");
  assert.equal(byName["Dead GBP"].status, "NO_WEBSITE");
  assert.equal(byName["Wix"].status, "FREE_SUBDOMAIN");
  assert.equal(byName["QuickFix"], undefined, "a real .com ending in x is not a social link");
  const scores = leads.map((l) => Number(l.score));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("WhatsApp links only for numbers that can have WhatsApp", () => {
  const { leads } = runFilter(CSV);
  const wa = Object.fromEntries(leads.map((l) => [l.business_name, l.whatsapp]));
  assert.equal(wa["No Site Mobile"], "https://wa.me/27821234567");
  assert.equal(wa["FB Only"], "https://wa.me/27721112222");
  assert.equal(wa["Landline Only"], "", "011 landlines can't use WhatsApp");
});

test("website audit refuses private / internal addresses (SSRF)", () => {
  const csv = `title,website,phone,place_id
Metadata,http://169.254.169.254/latest/meta-data/,082 000 0001,m1
Local,http://localhost:3847/,082 000 0002,m2
Loopback6,http://[::1]/,082 000 0003,m3
`;
  const { leads, summary } = runFilter(csv, ["--audit"]);
  assert.equal(leads.length, 0, "internal URLs must never become audited leads");
  assert.equal(summary.audit.unverifiedSites, 3);
});
