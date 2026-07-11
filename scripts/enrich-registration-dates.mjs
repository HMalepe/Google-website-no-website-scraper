#!/usr/bin/env node
/**
 * Enrich no-website leads with the company registration / opening date.
 *
 * For every lead this runs a separate web search (DuckDuckGo first, Bing as
 * fallback — Google blocks automated queries with captchas, but these index
 * the same public pages, including CIPC company directories) and extracts:
 *   - SA company registration numbers (e.g. 2023/123456/07 -> year 2023)
 *   - "registration date / registered on / incorporated on" + a date
 *   - "founded / established / opened / since" + a year
 *
 * It also checks whether <businessname>.co.za is still unregistered (one DNS
 * query per lead — a ready-made pitch line) and computes a 0-100 lead_score
 * from company age, social-only presence, review sweet spot, domain
 * availability, and contactability.
 *
 * Output: rewrites no-website-leads.csv with extra columns and sorts it
 * NEWEST COMPANIES FIRST (lead_score breaks ties), and merges enrichment
 * stats into summary.json.
 *
 * Usage:
 *   node scripts/enrich-registration-dates.mjs <leads.csv> <outDir> [location]
 *
 * Env knobs:
 *   ENRICH_MAX        max leads to search (default 100)
 *   ENRICH_DELAY_MS   pause between searches (default 1500)
 *   ENRICH_TIMEOUT_MS per-request timeout (default 10000)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const inputPath = resolve(process.argv[2] ?? resolve(root, "output", "no-website-leads.csv"));
const outDir = resolve(process.argv[3] ?? dirname(inputPath));
const location = String(process.argv[4] ?? "").trim();

const MAX_LEADS = Number(process.env.ENRICH_MAX || 100);
const DELAY_MS = Number(process.env.ENRICH_DELAY_MS || 1500);
const TIMEOUT_MS = Number(process.env.ENRICH_TIMEOUT_MS || 10000);
const CURRENT_YEAR = new Date().getFullYear();

const EXTRA_HEADERS = [
  "registered_date",
  "registered_year",
  "company_age_years",
  "date_confidence",
  "date_evidence",
  "suggested_domain",
  "domain_available",
  "hiring_signal",
  "lead_score",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ---------- CSV helpers (same dialect as filter-no-website.mjs) ----------

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

// ---------- Date extraction ----------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function validYear(y) {
  const year = Number(y);
  return year >= 1900 && year <= CURRENT_YEAR ? year : null;
}

function parseFullDate(text) {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m && validYear(m[1])) return { iso: m[0], year: Number(m[1]) };

  m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-]((?:19|20)\d{2})\b/);
  if (m && validYear(m[3])) {
    return { iso: `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`, year: Number(m[3]) };
  }

  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+((?:19|20)\d{2})\b/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month && validYear(m[3])) {
      return {
        iso: `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`,
        year: Number(m[3]),
      };
    }
  }

  m = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month && validYear(m[3])) {
      return {
        iso: `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`,
        year: Number(m[3]),
      };
    }
  }

  m = text.match(/\b((?:19|20)\d{2})\b/);
  if (m && validYear(m[1])) return { iso: "", year: Number(m[1]) };

  return null;
}

/**
 * Pull a registration/opening date out of search snippet text.
 * Returns { date, year, confidence, evidence } or null.
 */
export function extractRegistration(text) {
  const t = String(text ?? "").replace(/\s+/g, " ");

  // 1) SA company registration number: the first 4 digits are the reg year.
  let m = t.match(/\b((?:19|20)\d{2})\s*\/\s*\d{6}\s*\/\s*\d{2}\b/);
  if (m && validYear(m[1])) {
    return {
      date: "",
      year: Number(m[1]),
      confidence: "high",
      evidence: `registration number ${m[0].replace(/\s+/g, "")}`,
    };
  }

  // 2) Explicit registration/incorporation wording followed by a date.
  m = t.match(
    /(registration date|date of registration|registered on|registered in|incorporated on|incorporated in|incorporation date)\s*[:\-]?\s*(.{0,40})/i
  );
  if (m) {
    const parsed = parseFullDate(m[2]);
    if (parsed) {
      return {
        date: parsed.iso,
        year: parsed.year,
        confidence: "high",
        evidence: `${m[1].toLowerCase()} ${parsed.iso || parsed.year}`,
      };
    }
  }

  // 3) Founded / established / opened / since + year.
  m = t.match(
    /\b(founded|established|est\.?|opened|started|launched|since|trading since|in business since)\s+(?:in\s+)?((?:19|20)\d{2})\b/i
  );
  if (m && validYear(m[2])) {
    return {
      date: "",
      year: Number(m[2]),
      confidence: "medium",
      evidence: `${m[1].toLowerCase()} ${m[2]}`,
    };
  }

  return null;
}

// ---------- Web search ----------

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-ZA,en;q=0.9",
      },
      signal: controller.signal,
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function extractSnippets(html, pattern) {
  const snippets = [];
  const re = new RegExp(pattern, "gis");
  let m;
  while ((m = re.exec(html)) && snippets.length < 20) {
    const text = stripTags(m[1]);
    if (text) snippets.push(text);
  }
  return snippets;
}

async function searchSnippets(query) {
  const q = encodeURIComponent(query);

  const ddg = await fetchText(`https://html.duckduckgo.com/html/?q=${q}`);
  if (ddg) {
    const snippets = [
      ...extractSnippets(ddg, '<a[^>]*class="result__snippet"[^>]*>(.*?)</a>'),
      ...extractSnippets(ddg, '<a[^>]*class="result__a"[^>]*>(.*?)</a>'),
    ];
    if (snippets.length > 0) return snippets;
  }

  const bing = await fetchText(`https://www.bing.com/search?q=${q}&setlang=en`);
  if (bing) {
    const snippets = [
      ...extractSnippets(bing, "<p[^>]*>(.*?)</p>"),
      ...extractSnippets(bing, "<h2[^>]*>(.*?)</h2>"),
    ];
    if (snippets.length > 0) return snippets;
  }

  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Growth = budget. Scan snippets we already fetched for hiring language —
 * a free bonus signal, no extra search queries.
 */
export function extractHiringSignal(text) {
  const m = String(text ?? "").match(
    /\b(now hiring|we(?:'|’| a)re hiring|hiring now|vacanc(?:y|ies)|job opening|position(?:s)? available|join our team|looking for a [a-z ]{3,30})\b/i
  );
  return m ? m[1].toLowerCase() : "";
}

async function findRegistrationDate(name, place) {
  const base = place ? `"${name}" ${place}` : `"${name}"`;
  const queries = [
    `${base} company registration date OR "registration number" OR CIPC`,
    `${base} founded OR established OR opened OR "since"`,
  ];

  let hiring = "";
  for (const query of queries) {
    const snippets = await searchSnippets(query);
    // Prefer high-confidence hits across all snippets before settling.
    let best = null;
    for (const snippet of snippets) {
      if (!hiring) hiring = extractHiringSignal(snippet);
      const hit = extractRegistration(snippet);
      if (!hit) continue;
      if (hit.confidence === "high") return { hit, hiring };
      if (!best) best = hit;
    }
    if (best) return { hit: best, hiring };
    await sleep(DELAY_MS);
  }

  return { hit: null, hiring };
}

// ---------- Domain availability (.co.za) ----------

/** Turn "Joe's Plumbing (Pty) Ltd" into "joesplumbing.co.za". */
export function suggestDomain(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/\((pty|proprietary)\.?\s*(ltd|limited)?\.?\)/g, " ")
    .replace(/\b(pty|proprietary|ltd|limited|inc|cc|t\/a|ta)\b\.?/g, " ")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
  if (slug.length < 3 || slug.length > 60) return "";
  return `${slug}.co.za`;
}

/** "yes" = unregistered, "no" = taken, "" = could not tell. */
async function checkDomainAvailable(domain) {
  if (!domain) return "";
  try {
    await dns.resolveNs(domain);
    return "no";
  } catch (err) {
    if (err.code === "ENOTFOUND" || err.code === "ENODATA") return "yes";
    return "";
  }
}

// ---------- Lead scoring ----------

/**
 * 0-100: how good a website-sales prospect this lead is.
 * Newness dominates; social-only presence and the review sweet spot
 * (proud owner, real traffic, still no site) do the rest.
 */
export function computeLeadScore(lead) {
  let score = 0;

  const year = Number(lead.registered_year) || 0;
  if (year) {
    const age = CURRENT_YEAR - year;
    if (age <= 1) score += 30;
    else if (age <= 3) score += 20;
    else if (age <= 7) score += 10;
    else score += 5;
  }

  if (String(lead.social_profile || "").trim()) score += 20;

  const rating = Number(lead.review_rating) || 0;
  const reviews = Number(lead.review_count) || 0;
  if (rating >= 4 && reviews >= 10) score += 25;
  else if (rating >= 4 && reviews >= 3) score += 15;
  else if (reviews > 0) score += 5;

  if (lead.domain_available === "yes") score += 15;

  if (String(lead.hiring_signal || "").trim()) score += 10;

  if (String(lead.phone || "").trim()) score += 5;
  if (String(lead.whatsapp || "").trim()) score += 5;

  return Math.min(score, 100);
}

// ---------- Main ----------

function sortNewestFirst(leads) {
  return [...leads].sort((a, b) => {
    const ya = Number(a.registered_year) || 0;
    const yb = Number(b.registered_year) || 0;
    if (ya !== yb) return yb - ya; // newest year first; unknown (0) last
    const sa = Number(a.lead_score) || 0;
    const sb = Number(b.lead_score) || 0;
    if (sa !== sb) return sb - sa; // then best prospects first
    // Newness proxy tie-breaker: fewer reviews usually means a newer business.
    const ra = Number(a.review_count) || 0;
    const rb = Number(b.review_count) || 0;
    return ra - rb;
  });
}

async function main() {
  if (!existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  if (table.length < 2) {
    console.log("No leads to enrich.");
    process.exit(0);
  }

  const headers = table[0];
  const leads = table.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? "";
    });
    for (const h of EXTRA_HEADERS) if (!(h in obj)) obj[h] = "";
    return obj;
  });

  const outHeaders = [...headers.filter((h) => !EXTRA_HEADERS.includes(h)), ...EXTRA_HEADERS];

  const toSearch = leads.slice(0, MAX_LEADS);
  console.log(
    `Searching registration/opening dates for ${toSearch.length} of ${leads.length} leads...`
  );

  let found = 0;
  for (let i = 0; i < toSearch.length; i++) {
    const lead = toSearch[i];
    const name = String(lead.business_name || "").trim();
    if (!name) continue;

    const { hit, hiring } = await findRegistrationDate(name, location || lead.location || "");
    if (hiring) lead.hiring_signal = hiring;
    if (hit) {
      lead.registered_date = hit.date;
      lead.registered_year = String(hit.year);
      lead.company_age_years = String(CURRENT_YEAR - hit.year);
      lead.date_confidence = hit.confidence;
      lead.date_evidence = hit.evidence;
      found++;
      console.log(`  [${i + 1}/${toSearch.length}] ${name}: ${hit.date || hit.year} (${hit.evidence})`);
    } else {
      console.log(`  [${i + 1}/${toSearch.length}] ${name}: no date found`);
    }

    if (i < toSearch.length - 1) await sleep(DELAY_MS);
  }

  console.log(`Checking .co.za domain availability for ${leads.length} leads...`);
  let domainsFree = 0;
  for (const lead of leads) {
    lead.suggested_domain = suggestDomain(lead.business_name);
    lead.domain_available = await checkDomainAvailable(lead.suggested_domain);
    if (lead.domain_available === "yes") {
      domainsFree++;
      console.log(`  ${lead.suggested_domain} is available (${lead.business_name})`);
    }
  }
  console.log(`Domains still available: ${domainsFree}`);

  for (const lead of leads) {
    lead.lead_score = String(computeLeadScore(lead));
  }

  const sorted = sortNewestFirst(leads);
  writeFileSync(inputPath, toCsv(outHeaders, sorted), "utf8");

  const summaryPath = resolve(outDir, "summary.json");
  const summary = existsSync(summaryPath)
    ? JSON.parse(readFileSync(summaryPath, "utf8"))
    : {};
  summary.registrationDates = {
    searched: toSearch.length,
    datesFound: found,
    sortedBy: "newest companies first, lead_score breaks ties (unknown dates last)",
    newestSample: sorted
      .filter((l) => l.registered_year)
      .slice(0, 5)
      .map((l) => ({
        business_name: l.business_name,
        registered_year: l.registered_year,
        registered_date: l.registered_date,
        evidence: l.date_evidence,
      })),
  };
  summary.domains = {
    checked: leads.length,
    available: domainsFree,
  };
  summary.leadScores = {
    max: Math.max(0, ...sorted.map((l) => Number(l.lead_score) || 0)),
    average:
      Math.round(
        (sorted.reduce((sum, l) => sum + (Number(l.lead_score) || 0), 0) /
          (sorted.length || 1)) * 10
      ) / 10,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log("");
  console.log("Lead enrichment");
  console.log("---------------");
  console.log(`Dates searched   : ${toSearch.length} (found ${found})`);
  console.log(`Domains available: ${domainsFree} of ${leads.length} checked`);
  console.log(`Leads file       : ${inputPath} (sorted newest first)`);
}

// Only run when executed directly (extractRegistration is exported for tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Enrichment failed: ${err.message}`);
    process.exit(1);
  });
}
