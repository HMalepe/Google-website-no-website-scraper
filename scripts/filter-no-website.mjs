#!/usr/bin/env node
/**
 * Build a ranked lead list from a gosom Google Maps results.csv:
 *   NO_WEBSITE      no site, or a dead Google Business Site (score 95-100)
 *   SOCIAL_ONLY     only a Facebook/Instagram/etc. link (score 90)
 *   FREE_SUBDOMAIN  free builder subdomain, no own domain (score 70)
 *   OUTDATED_SITE   real site that fails the audit (--audit only, score <= 85)
 * Every lead keeps location + any contact: phone, email, or WhatsApp.
 *
 * Usage: node filter-no-website.mjs [results.csv] [outDir] [--audit] [--min-score=30]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const AUDIT = flags.includes("--audit");
const MIN_SCORE = Number(
  (flags.find((f) => f.startsWith("--min-score=")) ?? "--min-score=30").split("=")[1]
);
const inputPath = resolve(positional[0] ?? resolve(root, "output", "results.csv"));
const outDir = resolve(positional[1] ?? resolve(root, "output"));

const OUT_HEADERS = [
  "score",
  "status",
  "business_name",
  "has_website",
  "website",
  "reasons",
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
const ID_KEYS = ["place_id", "cid", "data_id", "link"];
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

// Google shut down Business Profile websites in 2024; these links are dead.
const DEAD_BUILDER_HOSTS = ["business.site", "g.page"];

// Free site-builder subdomains: the business has no domain of its own.
const FREE_SUBDOMAIN_HOSTS = [
  "sites.google.com",
  "wixsite.com",
  "weebly.com",
  "webnode.page",
  "webnode.com",
  "godaddysites.com",
  "blogspot.com",
  "wordpress.com",
  "jimdosite.com",
  "square.site",
  "carrd.co",
  "mystrikingly.com",
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

function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Classify a listing's website field into a lead status (or HAS_WEBSITE). */
function classifyWebsite(value) {
  const v = String(value ?? "").trim();
  const lower = v.toLowerCase();
  if (!v || ["n/a", "na", "none", "-"].includes(lower)) {
    return { status: "NO_WEBSITE", score: 100, reasons: "no website listed" };
  }

  const host = hostOf(v);
  if (!host) {
    if (!lower.includes(".") || SOCIAL_ONLY_HOSTS.some((s) => lower.includes(s))) {
      return { status: "NO_WEBSITE", score: 100, reasons: `unusable website value: ${v}` };
    }
    return { status: "HAS_WEBSITE", score: 0, reasons: "" };
  }

  if (hostMatches(host, DEAD_BUILDER_HOSTS)) {
    return {
      status: "NO_WEBSITE",
      score: 95,
      reasons: "Google Business Site link (service shut down 2024)",
    };
  }
  if (hostMatches(host, SOCIAL_ONLY_HOSTS)) {
    return { status: "SOCIAL_ONLY", score: 90, reasons: `only a social/profile link (${host})` };
  }
  if (hostMatches(host, FREE_SUBDOMAIN_HOSTS)) {
    return { status: "FREE_SUBDOMAIN", score: 70, reasons: `free builder subdomain (${host})` };
  }
  return { status: "HAS_WEBSITE", score: 0, reasons: "" };
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

function buildLead(record, keys, cls) {
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
    score: cls.score,
    status: cls.status,
    business_name: name,
    has_website: NO_SITE_STATUSES.has(cls.status) ? "no" : "yes",
    website: cls.website,
    reasons: cls.reasons,
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

function reviewCount(lead) {
  return Number(String(lead.review_count ?? "").replace(/\D/g, "")) || 0;
}

/** Best leads first: worst web presence, then busiest business. */
function byScore(a, b) {
  return b.score - a.score || reviewCount(b) - reviewCount(a);
}

const NO_SITE_STATUSES = new Set(["NO_WEBSITE", "SOCIAL_ONLY"]);

// ---------------------------------------------------------------- Website audit

const CURRENT_YEAR = new Date().getFullYear();
const AUDIT_TIMEOUT_MS = 15_000;
const AUDIT_CONCURRENCY = 8;
const MAX_HTML_BYTES = 2_000_000;
const OUTDATED_MAX_SCORE = 85; // always ranks below no-website / social-only
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const BROKEN_TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

const PLACEHOLDER_MARKERS = [
  ["domain is for sale", "parked / for-sale domain"],
  ["domain may be for sale", "parked / for-sale domain"],
  ["buy this domain", "parked / for-sale domain"],
  ["sedoparking", "parked / for-sale domain"],
  ["parkingcrew", "parked / for-sale domain"],
  ["account has been suspended", "hosting account suspended"],
  ["account suspended", "hosting account suspended"],
  ["index of /", "bare directory listing"],
  ["welcome to nginx", "default server page"],
  ["apache2 ubuntu default page", "default server page"],
  ["it works!", "default server page"],
  ["future home of", "placeholder page"],
  ["under construction", "placeholder page"],
  ["coming soon", "placeholder page"],
];

function visibleText(lowHtml) {
  return lowHtml
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function yearsIn(text) {
  return (text.match(/\b(?:19|20)\d{2}\b/g) ?? [])
    .map(Number)
    .filter((y) => y <= CURRENT_YEAR + 1);
}

/** Score a fetched page. Higher = older / worse site = better lead. */
function auditHtml(html, finalUrl) {
  const low = html.toLowerCase();
  const text = visibleText(low);

  if (text.length < 3000) {
    const hit = PLACEHOLDER_MARKERS.find(([marker]) => text.includes(marker));
    if (hit) return { score: OUTDATED_MAX_SCORE, reasons: [hit[1]] };
  }

  let score = 0;
  const reasons = [];

  if (!/^https:/i.test(finalUrl)) {
    score += 25;
    reasons.push("no HTTPS");
  }
  if (!/<meta[^>]+name=["']?viewport/.test(low)) {
    score += 30;
    reasons.push("not mobile-friendly (no viewport meta)");
  }

  // Newest year anywhere near a copyright mark, so "© 2008-2026" counts as 2026.
  const dynamicYear = /getfullyear\s*\(|\{\{\s*(?:current_?)?year/.test(low);
  if (!dynamicYear) {
    const snippets = [...text.matchAll(/(?:©|&copy;|&#169;|\(c\)|copyright)([^©]{0,60})/g)];
    const copyrightYears = snippets.flatMap((m) => yearsIn(m[1]));
    if (copyrightYears.length) {
      const newest = Math.max(...copyrightYears);
      if (newest <= CURRENT_YEAR - 3) {
        score += 25;
        reasons.push(`copyright last updated ${newest}`);
      }
    } else if (!snippets.length) {
      const tailYears = yearsIn(text.slice(-1500));
      if (tailYears.length && Math.max(...tailYears) <= CURRENT_YEAR - 3) {
        score += 15;
        reasons.push(`latest year on page is ${Math.max(...tailYears)}`);
      }
    }
  }

  const legacy = ["<marquee", "<frameset", "<frame ", "<font ", "<center>", "<blink", "swfobject", ".swf", "bgcolor="]
    .filter((t) => low.includes(t));
  if (legacy.length) {
    score += 15;
    reasons.push(`legacy HTML/Flash (${legacy.slice(0, 3).join(", ")})`);
  }

  const tables = (low.match(/<table/g) ?? []).length;
  if (tables >= 4 && !/display\s*:\s*(?:flex|grid)|grid-template/.test(low)) {
    score += 10;
    reasons.push("table-based layout");
  }

  const jq =
    low.match(/jquery[-.](\d)\.(\d+)(?:\.\d+)?(?:\.min)?\.js/) ??
    low.match(/jquery\/(\d)\.(\d+)/) ??
    low.match(/jquery(?:\.min)?\.js\?ver=(\d)\.(\d+)/);
  if (jq && Number(jq[1]) <= 1) {
    score += 10;
    reasons.push(`jQuery ${jq[1]}.${jq[2]} (ancient)`);
  }

  const wp = low.match(/<meta[^>]+content=["']wordpress (\d+)\.(\d+)/);
  if (wp && Number(wp[1]) <= 4) {
    score += 10;
    reasons.push(`WordPress ${wp[1]}.${wp[2]} (pre-2019)`);
  }

  if (!/<meta[^>]+name=["']?description/.test(low)) {
    score += 5;
    reasons.push("no meta description");
  }

  const spaShell = /id=["'](?:root|app|__next|__nuxt)["']|ng-version=|data-reactroot/.test(low);
  if (text.length < 800 && !spaShell) {
    score += 10;
    reasons.push("very thin content");
  }

  return { score: Math.min(score, OUTDATED_MAX_SCORE), reasons };
}

async function readCapped(res, cap) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (size < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  if (size >= cap) await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetch one site and audit it. Returns { verdict, score, reasons }:
 * verdict "audited" (scored), "broken" (dead site = lead), "unverified" (blocked/timeout = skip).
 */
async function auditSite(url) {
  let res;
  try {
    res = await fetch(normalizeUrl(url), {
      redirect: "follow",
      signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-ZA,en;q=0.9",
      },
    });
  } catch (err) {
    const code = err?.cause?.code ?? err?.code ?? "";
    if (code === "ENOTFOUND") {
      return { verdict: "broken", score: OUTDATED_MAX_SCORE, reasons: ["domain does not resolve (site is dead)"] };
    }
    if (code === "ECONNREFUSED") {
      return { verdict: "broken", score: 80, reasons: ["server refuses connections"] };
    }
    if (BROKEN_TLS_CODES.has(code)) {
      return { verdict: "broken", score: 75, reasons: [`broken SSL certificate (${code})`] };
    }
    return { verdict: "unverified", score: 0, reasons: [`could not check: ${code || err?.name || "error"}`] };
  }

  if ([401, 403, 429].includes(res.status)) {
    res.body?.cancel().catch(() => {});
    return { verdict: "unverified", score: 0, reasons: [`blocked by site (HTTP ${res.status})`] };
  }

  const html = await readCapped(res, MAX_HTML_BYTES).catch(() => "");
  const botWall = /just a moment\.\.\.|cf-chl|attention required! \| cloudflare|captcha/i.test(html.slice(0, 20000));
  if (botWall) {
    return { verdict: "unverified", score: 0, reasons: ["behind bot protection"] };
  }
  if (res.status >= 400) {
    return { verdict: "broken", score: 80, reasons: [`site returns HTTP ${res.status}`] };
  }

  const { score, reasons } = auditHtml(html, res.url || url);
  return { verdict: "audited", score, reasons };
}

async function mapPool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function auditSites(urls) {
  const results = new Map();
  let done = 0;
  await mapPool(urls, AUDIT_CONCURRENCY, async (url) => {
    results.set(url, await auditSite(url));
    done++;
    if (done % 10 === 0 || done === urls.length) {
      console.log(`[audit] ${done}/${urls.length} websites checked`);
    }
  });
  return results;
}

// ---------------------------------------------------------------- Main

await main();

async function main() {
  if (!existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    console.error("Run scripts/scrape.ps1 first.");
    process.exit(1);
  }

  const raw = readFileSync(inputPath, "utf8").replace(/^﻿/, "");
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

  // Overlapping searches (suburb sweeps, similar categories) return the same place.
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const id =
      pick(record, ID_KEYS) ||
      `${pick(record, NAME_KEYS)}|${pick(record, ADDRESS_KEYS)}`.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(record);
  }

  const classified = unique.map((record) => {
    const website = String(record[websiteKey] ?? "").trim();
    return { record, website, ...classifyWebsite(website) };
  });

  let auditResults = new Map();
  const toAudit = [...new Set(classified.filter((c) => c.status === "HAS_WEBSITE").map((c) => c.website))];
  if (AUDIT && toAudit.length) {
    console.log(`[audit] checking ${toAudit.length} websites for outdated / broken sites...`);
    auditResults = await auditSites(toAudit);
  }

  let skippedHasWebsite = 0;
  let unverifiedSites = 0;
  const leads = [];
  for (const c of classified) {
    if (c.status === "HAS_WEBSITE") {
      const audit = auditResults.get(c.website);
      if (audit?.verdict === "unverified") unverifiedSites++;
      if (!audit || audit.verdict === "unverified" || audit.score < MIN_SCORE) {
        skippedHasWebsite++;
        continue;
      }
      c.status = "OUTDATED_SITE";
      c.score = audit.score;
      c.reasons = audit.reasons.join("; ");
    }
    leads.push(buildLead(c.record, keys, c));
  }

  const withContact = leads.filter(hasAnyContact).sort(byScore);
  const noWebsiteWithContact = withContact.filter((l) => NO_SITE_STATUSES.has(l.status));
  const noWebsiteNoContact = leads
    .filter((l) => NO_SITE_STATUSES.has(l.status) && !hasAnyContact(l))
    .sort(byScore);

  mkdirSync(outDir, { recursive: true });

  const allLeadsPath = resolve(outDir, "leads.csv");
  const leadsPath = resolve(outDir, "no-website-leads.csv");
  const noContactPath = resolve(outDir, "no-website-no-contact.csv");
  const summaryPath = resolve(outDir, "summary.json");

  writeFileSync(allLeadsPath, toCsv(OUT_HEADERS, withContact), "utf8");
  writeFileSync(leadsPath, toCsv(OUT_HEADERS, noWebsiteWithContact), "utf8");
  writeFileSync(noContactPath, toCsv(OUT_HEADERS, noWebsiteNoContact), "utf8");

  const byStatus = {};
  for (const status of ["NO_WEBSITE", "SOCIAL_ONLY", "FREE_SUBDOMAIN", "OUTDATED_SITE"]) {
    byStatus[status] = withContact.filter((l) => l.status === status).length;
  }
  const withPhone = withContact.filter((l) => l.phone).length;
  const withEmail = withContact.filter((l) => l.email).length;
  const withWhatsApp = withContact.filter((l) => l.whatsapp).length;

  const summary = {
    source: inputPath,
    priorities: ["no real website", "location", "any contact (phone/email/whatsapp)"],
    totalScraped: records.length,
    duplicatesRemoved: records.length - unique.length,
    uniqueBusinesses: unique.length,
    skippedHasWebsite,
    totalLeads: withContact.length,
    noWebsiteWithContact: noWebsiteWithContact.length,
    noWebsiteNoContact: noWebsiteNoContact.length,
    byStatus,
    audit: {
      enabled: AUDIT,
      sitesChecked: AUDIT ? toAudit.length : 0,
      unverifiedSites,
      minScore: MIN_SCORE,
    },
    contactBreakdown: {
      phone: withPhone,
      email: withEmail,
      whatsapp: withWhatsApp,
    },
    outputs: {
      allLeads: allLeadsPath,
      leads: leadsPath,
      noContact: noContactPath,
    },
    samples: withContact.slice(0, 5),
  };

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log("");
  console.log("Lead export");
  console.log("-----------");
  console.log(`Scraped total          : ${summary.totalScraped}`);
  console.log(`Duplicates removed     : ${summary.duplicatesRemoved}`);
  console.log(`Skipped (good website) : ${summary.skippedHasWebsite}${AUDIT ? ` (${unverifiedSites} unverifiable)` : ""}`);
  console.log(`All leads + contact    : ${summary.totalLeads} -> ${allLeadsPath}`);
  console.log(`  no website           : ${byStatus.NO_WEBSITE}`);
  console.log(`  social only          : ${byStatus.SOCIAL_ONLY}`);
  console.log(`  free subdomain       : ${byStatus.FREE_SUBDOMAIN}`);
  console.log(`  outdated/broken site : ${byStatus.OUTDATED_SITE}${AUDIT ? "" : " (run with --audit)"}`);
  console.log(`No website + contact   : ${summary.noWebsiteWithContact} -> ${leadsPath}`);
  console.log(`No website, no contact : ${summary.noWebsiteNoContact} -> ${noContactPath}`);
  console.log(`  phone                : ${withPhone}`);
  console.log(`  email                : ${withEmail}`);
  console.log(`  whatsapp             : ${withWhatsApp}`);
  console.log(`Summary                : ${summaryPath}`);
  console.log("");
}
