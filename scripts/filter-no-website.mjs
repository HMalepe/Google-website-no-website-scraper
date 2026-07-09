#!/usr/bin/env node
/**
 * Split gosom/google-maps-scraper CSV output into:
 * - no-website-leads.csv  (best for web-design / digital outreach via phone)
 * - with-website-leads.csv (optional email enrichment targets)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const inputArg = process.argv[2];
const inputPath = resolve(inputArg ?? resolve(root, "output", "results.csv"));
const outDir = resolve(root, "output");

const WEBSITE_KEYS = ["website", "web_site", "site", "url", "website_url"];
const NAME_KEYS = ["title", "name", "business_name"];
const PHONE_KEYS = ["phone", "phone_number", "telephone"];
const EMAIL_KEYS = ["emails", "email"];
const ADDRESS_KEYS = ["address", "complete_address", "full_address"];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
      row.push(field);
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = "";
      if (ch === "\r") i++;
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }

  return rows;
}

function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, records) {
  const lines = [headers.map(escapeCsv).join(",")];
  for (const record of records) {
    lines.push(headers.map((h) => escapeCsv(record[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

function pick(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && String(row[key]).trim()) return String(row[key]).trim();
  }
  return "";
}

function hasWebsite(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return false;
  if (v === "n/a" || v === "na" || v === "none" || v === "-") return false;
  return v.includes(".") || v.startsWith("http");
}

function objectify(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = row[i] ?? "";
  });
  return obj;
}

function findHeader(headers, candidates) {
  const lower = new Map(headers.map((h) => [h.toLowerCase(), h]));
  for (const c of candidates) {
    const hit = lower.get(c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

if (!existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  console.error("Run scripts/scrape.ps1 first.");
  process.exit(1);
}

const raw = readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
const table = parseCsv(raw);

if (table.length < 2) {
  console.error("CSV has no data rows.");
  process.exit(1);
}

const headers = table[0];
const records = table.slice(1).map((row) => objectify(headers, row));

const websiteKey =
  findHeader(headers, WEBSITE_KEYS) ??
  headers.find((h) => h.toLowerCase().includes("website")) ??
  "website";

const noWebsite = [];
const withWebsite = [];

for (const record of records) {
  const site = record[websiteKey] ?? "";
  if (hasWebsite(site)) withWebsite.push(record);
  else noWebsite.push(record);
}

mkdirSync(outDir, { recursive: true });

const noWebsitePath = resolve(outDir, "no-website-leads.csv");
const withWebsitePath = resolve(outDir, "with-website-leads.csv");
const summaryPath = resolve(outDir, "summary.json");

writeFileSync(noWebsitePath, toCsv(headers, noWebsite), "utf8");
writeFileSync(withWebsitePath, toCsv(headers, withWebsite), "utf8");

const sample = (list) =>
  list.slice(0, 5).map((r) => ({
    name: pick(r, NAME_KEYS),
    phone: pick(r, PHONE_KEYS),
    address: pick(r, ADDRESS_KEYS),
    website: pick(r, WEBSITE_KEYS),
    emails: pick(r, EMAIL_KEYS),
  }));

const summary = {
  source: inputPath,
  total: records.length,
  noWebsite: noWebsite.length,
  withWebsite: withWebsite.length,
  websiteColumn: websiteKey,
  outputs: {
    noWebsiteLeads: noWebsitePath,
    withWebsiteLeads: withWebsitePath,
  },
  samples: {
    noWebsite: sample(noWebsite),
    withWebsite: sample(withWebsite),
  },
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

console.log("");
console.log("Lead filter complete");
console.log("--------------------");
console.log(`Total scraped : ${summary.total}`);
console.log(`No website    : ${summary.noWebsite}  -> ${noWebsitePath}`);
console.log(`Has website   : ${summary.withWebsite}  -> ${withWebsitePath}`);
console.log(`Summary       : ${summaryPath}`);
console.log("");
