#!/usr/bin/env node
/**
 * Audit businesses that HAVE a website and flag the ones whose site is
 * dead weight — a second lead category next to the no-website list.
 *
 * Per site (no scraping of third parties — we fetch the business's own site):
 *   - lapsed domain: DNS no longer resolves (they let it die = hot lead)
 *   - unreachable: DNS fine but the site doesn't load
 *   - no SSL: https fails / redirects to plain http
 *   - not mobile-friendly: no viewport meta tag
 *   - outdated copyright year in the footer (2+ years old)
 *   - tech-stack gaps: no analytics pixel, no booking widget
 *   - optional: Google PageSpeed Insights score if PAGESPEED_API_KEY is set
 *     (official free API, https://developers.google.com/speed/docs/insights/v5/get-started)
 *
 * Only leads with at least one issue are written to bad-website-leads.csv,
 * worst sites first.
 *
 * Usage:
 *   node scripts/audit-websites.mjs <has-website.csv> <outDir>
 *
 * Env knobs:
 *   AUDIT_MAX         max sites to audit (default 50)
 *   AUDIT_TIMEOUT_MS  per-request timeout (default 10000)
 *   PAGESPEED_API_KEY enables the PageSpeed mobile score check
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";

const inputPath = resolve(process.argv[2] ?? "has-website.csv");
const outDir = resolve(process.argv[3] ?? dirname(inputPath));

const AUDIT_MAX = Number(process.env.AUDIT_MAX || 50);
const TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS || 10000);
const PAGESPEED_API_KEY = String(process.env.PAGESPEED_API_KEY || "").trim();
const CURRENT_YEAR = new Date().getFullYear();

const AUDIT_HEADERS = [
  "website_issues",
  "issue_count",
  "domain_lapsed",
  "ssl",
  "mobile_friendly",
  "copyright_year",
  "has_analytics",
  "has_booking",
  "pagespeed_score",
];

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

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

// ---------- HTML checks ----------

export function analyzeHtml(html) {
  const h = String(html ?? "");
  const result = {
    mobileFriendly: /<meta[^>]+name=["']?viewport["']?/i.test(h),
    hasAnalytics:
      /googletagmanager\.com|google-analytics\.com|gtag\(|fbq\(|fbevents\.js|clarity\.ms|hotjar|plausible\.io|matomo/i.test(
        h
      ),
    hasBooking:
      /calendly|booksy|fresha|setmore|simplybook|timify|appointy|acuityscheduling|book\s+(online|now)/i.test(
        h
      ),
    copyrightYear: null,
  };

  // Latest year that appears next to a copyright mark.
  const re = /(?:©|&copy;|&#169;|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi;
  let m;
  while ((m = re.exec(h))) {
    const year = Number(m[1]);
    if (year >= 1990 && year <= CURRENT_YEAR + 1) {
      if (!result.copyrightYear || year > result.copyrightYear) result.copyrightYear = year;
    }
  }

  return result;
}

// ---------- Site fetching ----------

async function fetchSite(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-ZA,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    const html = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, html: "", error: err.cause?.code || err.name };
  } finally {
    clearTimeout(timer);
  }
}

async function domainResolves(host) {
  try {
    await dns.lookup(host);
    return true;
  } catch (err) {
    if (err.code === "ENOTFOUND") return false;
    return true; // DNS hiccup — don't claim the domain lapsed
  }
}

async function pageSpeedScore(url) {
  if (!PAGESPEED_API_KEY) return "";
  const api =
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed" +
    `?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${PAGESPEED_API_KEY}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000); // PageSpeed is slow
  try {
    const res = await fetch(api, { signal: controller.signal });
    if (!res.ok) return "";
    const data = await res.json();
    const score = data?.lighthouseResult?.categories?.performance?.score;
    return typeof score === "number" ? String(Math.round(score * 100)) : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export async function auditSite(website) {
  const audit = {
    website_issues: "",
    issue_count: "0",
    domain_lapsed: "no",
    ssl: "",
    mobile_friendly: "",
    copyright_year: "",
    has_analytics: "",
    has_booking: "",
    pagespeed_score: "",
  };
  const issues = [];

  let host = "";
  try {
    host = new URL(website).hostname;
  } catch {
    return null;
  }

  if (!(await domainResolves(host))) {
    audit.domain_lapsed = "yes";
    issues.push("domain lapsed — site is gone");
    audit.website_issues = issues.join("; ");
    audit.issue_count = String(issues.length);
    return audit;
  }

  const httpsUrl = website.replace(/^http:\/\//i, "https://");
  let page = await fetchSite(httpsUrl);
  if (page.ok) {
    audit.ssl = page.finalUrl.startsWith("https://") ? "yes" : "no";
  } else {
    const httpPage = await fetchSite(website.replace(/^https:\/\//i, "http://"));
    if (httpPage.ok) {
      audit.ssl = "no";
      page = httpPage;
    } else {
      issues.push("site unreachable");
      audit.website_issues = issues.join("; ");
      audit.issue_count = String(issues.length);
      return audit;
    }
  }
  if (audit.ssl === "no") issues.push("no SSL (not secure warning in browsers)");

  const html = analyzeHtml(page.html);
  audit.mobile_friendly = html.mobileFriendly ? "yes" : "no";
  if (!html.mobileFriendly) issues.push("not mobile-friendly");

  audit.has_analytics = html.hasAnalytics ? "yes" : "no";
  if (!html.hasAnalytics) issues.push("no analytics installed");

  audit.has_booking = html.hasBooking ? "yes" : "no";

  if (html.copyrightYear) {
    audit.copyright_year = String(html.copyrightYear);
    if (html.copyrightYear <= CURRENT_YEAR - 2) {
      issues.push(`copyright stuck on ${html.copyrightYear}`);
    }
  }

  audit.pagespeed_score = await pageSpeedScore(page.finalUrl);
  if (audit.pagespeed_score && Number(audit.pagespeed_score) < 50) {
    issues.push(`slow on mobile (PageSpeed ${audit.pagespeed_score}/100)`);
  }

  audit.website_issues = issues.join("; ");
  audit.issue_count = String(issues.length);
  return audit;
}

// ---------- Main ----------

async function main() {
  if (!existsSync(inputPath)) {
    console.log("No has-website.csv to audit — skipping.");
    return;
  }

  const raw = readFileSync(inputPath, "utf8").replace(/^﻿/, "");
  const table = parseCsv(raw);
  if (table.length < 2) {
    console.log("No websites to audit.");
    writeBadLeads([], table[0] ?? []);
    return;
  }

  const headers = table[0];
  const leads = table.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? "";
    });
    return obj;
  });

  const toAudit = leads.filter((l) => String(l.website || "").trim()).slice(0, AUDIT_MAX);
  console.log(`Auditing ${toAudit.length} business websites for problems...`);
  if (!PAGESPEED_API_KEY) {
    console.log("(set PAGESPEED_API_KEY for Google PageSpeed mobile scores)");
  }

  const flagged = [];
  for (let i = 0; i < toAudit.length; i++) {
    const lead = toAudit[i];
    const audit = await auditSite(lead.website);
    if (!audit) continue;

    if (Number(audit.issue_count) > 0) {
      flagged.push({ ...lead, ...audit });
      console.log(
        `  [${i + 1}/${toAudit.length}] ${lead.business_name}: ${audit.website_issues}`
      );
    } else {
      console.log(`  [${i + 1}/${toAudit.length}] ${lead.business_name}: site looks fine`);
    }
  }

  flagged.sort((a, b) => Number(b.issue_count) - Number(a.issue_count));
  writeBadLeads(flagged, headers);

  const summaryPath = resolve(outDir, "summary.json");
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {};
  summary.badWebsites = {
    audited: toAudit.length,
    flagged: flagged.length,
    pagespeed: PAGESPEED_API_KEY ? "enabled" : "disabled (no PAGESPEED_API_KEY)",
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log("");
  console.log("Website audit");
  console.log("-------------");
  console.log(`Sites audited : ${toAudit.length}`);
  console.log(`Flagged (bad) : ${flagged.length}`);
}

function writeBadLeads(flagged, headers) {
  const outHeaders = [...headers.filter((h) => !AUDIT_HEADERS.includes(h)), ...AUDIT_HEADERS];
  const badPath = resolve(outDir, "bad-website-leads.csv");
  writeFileSync(badPath, toCsv(outHeaders, flagged), "utf8");
  console.log(`Bad-site leads: ${badPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Website audit failed: ${err.message}`);
    process.exit(1);
  });
}
