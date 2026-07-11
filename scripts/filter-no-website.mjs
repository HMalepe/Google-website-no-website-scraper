#!/usr/bin/env node
/**
 * Build no-website lead list with:
 * 1) confirmed no real website
 * 2) location
 * 3) any contact: phone, email, or WhatsApp
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const inputArg = process.argv[2];
const outArg = process.argv[3];
const inputPath = resolve(inputArg ?? resolve(root, "output", "results.csv"));
const outDir = resolve(outArg ?? resolve(root, "output"));

const OUT_HEADERS = [
  "business_name",
  "has_website",
  "website",
  "social_profile",
  "location",
  "address",
  "latitude",
  "longitude",
  "phone",
  "email",
  "whatsapp",
  "all_contacts",
  "category",
  "google_maps_link",
  "review_rating",
  "review_count",
];

const WEBSITE_KEYS = ["website", "web_site", "site", "url", "website_url"];
const NAME_KEYS = ["title", "name", "business_name"];
const PHONE_KEYS = ["phone", "phone_number", "telephone"];
const EMAIL_KEYS = ["emails", "email"];
const ADDRESS_KEYS = ["complete_address", "address", "full_address"];
const LAT_KEYS = ["latitude", "lat"];
const LNG_KEYS = ["longitude", "lng", "lon"];
const CATEGORY_KEYS = ["category", "type"];
const LINK_KEYS = ["link", "google_maps_link", "maps_link"];
const RATING_KEYS = ["review_rating", "rating"];
const REVIEW_COUNT_KEYS = ["review_count", "reviews"];
const TEXT_KEYS = ["about", "descriptions", "description", "order_online", "menu"];

const SOCIAL_ONLY_HOSTS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "tiktok.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "linktr.ee",
  "wa.me",
  "whatsapp.com",
  "api.whatsapp.com",
];

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

function pickAll(row, keys) {
  const values = [];
  for (const key of keys) {
    if (row[key] !== undefined && String(row[key]).trim()) {
      values.push(String(row[key]).trim());
    }
  }
  return values;
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

function normalizeUrl(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (v.includes(".")) return `https://${v}`;
  return v;
}

function hostOf(url) {
  try {
    return new URL(normalizeUrl(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hasRealWebsite(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return false;
  if (v === "n/a" || v === "na" || v === "none" || v === "-") return false;

  const host = hostOf(v);
  if (!host) return v.includes(".") && !SOCIAL_ONLY_HOSTS.some((s) => v.includes(s));

  return !SOCIAL_ONLY_HOSTS.some((social) => host === social || host.endsWith(`.${social}`));
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function toWhatsAppLink(phone) {
  const digits = digitsOnly(phone);
  if (!digits) return "";

  let normalized = digits;
  if (normalized.startsWith("0") && normalized.length === 10) {
    normalized = `27${normalized.slice(1)}`;
  } else if (normalized.length === 9 && /^[67]/.test(normalized)) {
    normalized = `27${normalized}`;
  }

  if (normalized.length < 10) return "";

  return `https://wa.me/${normalized}`;
}

function extractEmailsFromText(...chunks) {
  const found = new Set();
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  for (const chunk of chunks) {
    const text = String(chunk ?? "");
    const matches = text.match(re) ?? [];
    for (const m of matches) {
      const email = m.toLowerCase();
      if (!email.includes("example.com") && !email.includes("sentry")) {
        found.add(email);
      }
    }
  }

  return [...found];
}

function extractWhatsAppFromText(...chunks) {
  for (const chunk of chunks) {
    const text = String(chunk ?? "");
    const waMe = text.match(/wa\.me\/(\+?\d{8,15})/i);
    if (waMe) return `https://wa.me/${digitsOnly(waMe[1])}`;

    const apiWa = text.match(/api\.whatsapp\.com\/send\?phone=(\+?\d{8,15})/i);
    if (apiWa) return `https://wa.me/${digitsOnly(apiWa[1])}`;
  }
  return "";
}

function buildLocation(record, addressKey, latKey, lngKey) {
  const complete = pick(record, ["complete_address"]);
  const address = pick(record, ADDRESS_KEYS);
  const lat = latKey ? record[latKey] : pick(record, LAT_KEYS);
  const lng = lngKey ? record[lngKey] : pick(record, LNG_KEYS);

  if (complete) return complete;
  if (address) return address;
  if (lat && lng) return `${lat}, ${lng}`;
  return "";
}

function socialProfileOf(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  const host = hostOf(v);
  if (!host) return "";
  const isSocial = SOCIAL_ONLY_HOSTS.some(
    (social) => host === social || host.endsWith(`.${social}`)
  );
  return isSocial ? normalizeUrl(v) : "";
}

function buildLead(record, keys, socialProfile) {
  const name = pick(record, NAME_KEYS);
  const phone = pick(record, PHONE_KEYS);
  const textBlob = pickAll(record, TEXT_KEYS).join(" ");

  const emails = [
    ...extractEmailsFromText(pick(record, EMAIL_KEYS), textBlob),
  ];
  const email = emails.join("; ");

  let whatsapp = extractWhatsAppFromText(textBlob);
  if (!whatsapp && phone) whatsapp = toWhatsAppLink(phone);

  const contacts = [];
  if (phone) contacts.push(`phone: ${phone}`);
  if (email) contacts.push(`email: ${email}`);
  if (whatsapp) contacts.push(`whatsapp: ${whatsapp}`);

  const address = pick(record, ADDRESS_KEYS);
  const location = buildLocation(record, keys.address, keys.lat, keys.lng);

  return {
    business_name: name,
    has_website: "no",
    website: "",
    social_profile: socialProfile || "",
    location,
    address: pick(record, ["complete_address"]) || address,
    latitude: keys.lat ? record[keys.lat] ?? "" : pick(record, LAT_KEYS),
    longitude: keys.lng ? record[keys.lng] ?? "" : pick(record, LNG_KEYS),
    phone,
    email,
    whatsapp,
    all_contacts: contacts.join(" | "),
    category: pick(record, CATEGORY_KEYS),
    google_maps_link: pick(record, LINK_KEYS),
    review_rating: pick(record, RATING_KEYS),
    review_count: pick(record, REVIEW_COUNT_KEYS),
  };
}

function hasAnyContact(lead) {
  return Boolean(lead.phone || lead.email || lead.whatsapp);
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

const keys = {
  address: findHeader(headers, ADDRESS_KEYS),
  lat: findHeader(headers, LAT_KEYS),
  lng: findHeader(headers, LNG_KEYS),
};

const noWebsiteWithContact = [];
const noWebsiteNoContact = [];
const hasWebsiteLeads = [];
let skippedHasWebsite = 0;

for (const record of records) {
  const site = record[websiteKey] ?? "";
  if (hasRealWebsite(site)) {
    skippedHasWebsite++;
    // Keep them: the website may be broken/outdated — audited in a later step.
    const wLead = buildLead(record, keys, "");
    wLead.has_website = "yes";
    wLead.website = normalizeUrl(site);
    hasWebsiteLeads.push(wLead);
    continue;
  }

  const lead = buildLead(record, keys, socialProfileOf(site));
  if (hasAnyContact(lead)) noWebsiteWithContact.push(lead);
  else noWebsiteNoContact.push(lead);
}

mkdirSync(outDir, { recursive: true });

const leadsPath = resolve(outDir, "no-website-leads.csv");
const noContactPath = resolve(outDir, "no-website-no-contact.csv");
const hasWebsitePath = resolve(outDir, "has-website.csv");
const summaryPath = resolve(outDir, "summary.json");

writeFileSync(leadsPath, toCsv(OUT_HEADERS, noWebsiteWithContact), "utf8");
writeFileSync(noContactPath, toCsv(OUT_HEADERS, noWebsiteNoContact), "utf8");
writeFileSync(hasWebsitePath, toCsv(OUT_HEADERS, hasWebsiteLeads), "utf8");

const withPhone = noWebsiteWithContact.filter((l) => l.phone).length;
const withEmail = noWebsiteWithContact.filter((l) => l.email).length;
const withWhatsApp = noWebsiteWithContact.filter((l) => l.whatsapp).length;
const withSocial = noWebsiteWithContact.filter((l) => l.social_profile).length;

const summary = {
  source: inputPath,
  priorities: ["no real website", "location", "any contact (phone/email/whatsapp)"],
  totalScraped: records.length,
  skippedHasWebsite,
  noWebsiteWithContact: noWebsiteWithContact.length,
  noWebsiteNoContact: noWebsiteNoContact.length,
  contactBreakdown: {
    phone: withPhone,
    email: withEmail,
    whatsapp: withWhatsApp,
  },
  socialOnly: withSocial,
  outputs: {
    leads: leadsPath,
    noContact: noContactPath,
    hasWebsite: hasWebsitePath,
  },
  samples: noWebsiteWithContact.slice(0, 5),
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

console.log("");
console.log("No-website lead export");
console.log("----------------------");
console.log(`Scraped total          : ${summary.totalScraped}`);
console.log(`Skipped (has website)  : ${summary.skippedHasWebsite}`);
console.log(`No website + contact   : ${summary.noWebsiteWithContact} -> ${leadsPath}`);
console.log(`No website, no contact : ${summary.noWebsiteNoContact} -> ${noContactPath}`);
console.log(`  phone                : ${withPhone}`);
console.log(`  email                : ${withEmail}`);
console.log(`  whatsapp             : ${withWhatsApp}`);
console.log(`Summary                : ${summaryPath}`);
console.log("");
