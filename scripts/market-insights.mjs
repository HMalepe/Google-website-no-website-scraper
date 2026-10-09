#!/usr/bin/env node
/**
 * Free market-gap analysis from a scan's Google Maps results (no API key).
 *
 * Per business type and area: competitors, how many are strong, customer
 * activity (reviews), and service gaps (no website, closed Sundays, no
 * evening hours), ranked by opportunity. Plus what customers complain about,
 * mined from the low-star reviews the scraper collects (~8 per business, so
 * a sample, not every review).
 *
 * Usage: node market-insights.mjs results.csv outDir [searches.json]
 *   searches.json: [{ id, query, area, category }] written by the dashboard;
 *   without it every business lands in one "All searches" group.
 * Writes outDir/market.json and outDir/market.csv.
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { readCsvObjects, toCsv } from "./lib-csv.mjs";

const STRONG_RATING = 4.5;
const STRONG_REVIEWS = 20;
const LOW_STAR = 3;

const NO_SITE_HOSTS = [
  "facebook.com", "fb.com", "fb.me", "instagram.com", "tiktok.com", "linkedin.com",
  "twitter.com", "x.com", "youtube.com", "youtu.be", "linktr.ee", "wa.me",
  "whatsapp.com", "business.site", "g.page",
];

export const COMPLAINT_THEMES = {
  "waiting / running late": /\b(wait(ed|ing)?|late|delay(ed)?|took (so |too )?long|slow|running behind|hours? (to|for))\b/,
  "booking / no response": /\b(no (answer|response|reply)|(didn'?t|never|not) (answer|reply|respond|pick)|double[- ]?booked|cancel(l?ed)?)\b/,
  "price / hidden charges": /\b(expensive|overpriced|over[- ]?charged|rip[- ]?off|too much|hidden|extra charge|pricey)\b/,
  "poor quality / damage": /\b(damag(e|ed)|burn(t|ed)?|ruin(ed)?|uneven|botch(ed)?|messy|poor (quality|work|service)|not what i (asked|wanted)|disappoint(ed|ing)|bad (cut|job|colou?r|work|service))\b/,
  "hygiene": /\b(dirty|unhygienic|hygiene|filthy|smell(y|s)?|unclean|not clean)\b/,
  "staff attitude": /\b(rude|attitude|unprofessional|ignored|disrespect(ful)?|arrogant|unfriendly)\b/,
  "parking / safety / location": /\b(parking|unsafe|security|hard to find)\b/,
  "hours / closed": /\b(closed|didn'?t open|not open|opening hours)\b/,
};

function num(value) {
  const n = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function hasRealWebsite(url) {
  const v = String(url ?? "").trim().toLowerCase();
  if (!v) return false;
  let host = "";
  try {
    host = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
  return !NO_SITE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** "9:30 pm" / "10 PM" / "12 am" -> hours as a decimal (21.5, 22, 0). */
function clockToHours(text, fallbackMeridiem) {
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  const meridiem = m[3] || fallbackMeridiem;
  if (meridiem === "pm") h += 12;
  return h + (m[2] ? Number(m[2]) / 60 : 0);
}

/**
 * Google Maps hours for one day, e.g. ["9 am–5 pm"], ["12:30–10 pm"],
 * ["Open 24 hours"], ["Closed"]. Returns { open, late } for that day.
 */
export function parseDay(slots) {
  const list = (Array.isArray(slots) ? slots : [slots])
    .map((s) => String(s ?? "").toLowerCase().replace(/[  ]/g, " ").trim())
    .filter(Boolean);
  if (!list.length || list.every((s) => s.startsWith("closed"))) return { open: false, late: false };
  let late = false;
  for (const slot of list) {
    if (slot.includes("24 hours")) return { open: true, late: true };
    const [start, end] = slot.split(/\s*[–—-]\s*/);
    if (!end) continue;
    const endMeridiem = (end.match(/(am|pm)/) || [])[1];
    const close = clockToHours(end, endMeridiem);
    // "12:30–10 pm": the start inherits the end's am/pm unless that would put it after closing.
    let open = clockToHours(start, (start.match(/(am|pm)/) || [])[1] || endMeridiem);
    if (open !== null && close !== null && !/(am|pm)/.test(start) && open > close) open -= 12;
    if (close === null) continue;
    if (close >= 19 || (open !== null && close < open) || close === 0) late = true;
  }
  return { open: true, late };
}

/** { openSunday, openLate } from gosom's open_hours JSON; null when unknown. */
export function hoursFlags(openHoursJson) {
  const hours = parseJson(openHoursJson, null);
  if (!hours || typeof hours !== "object" || !Object.keys(hours).length) {
    return { openSunday: null, openLate: null };
  }
  const days = Object.entries(hours).map(([day, slots]) => ({ day: day.toLowerCase(), ...parseDay(slots) }));
  const sunday = days.find((d) => d.day.startsWith("sun"));
  return {
    openSunday: sunday ? sunday.open : false,
    openLate: days.some((d) => d.late),
  };
}

function reviewsOf(row) {
  const reviews = [...parseJson(row.user_reviews, []), ...parseJson(row.user_reviews_extended, [])];
  return reviews
    .map((r) => ({
      rating: Number(r.Rating ?? r.rating ?? r.rating_float ?? 0),
      text: String(r.Description || r.text_original || r.text_translated || "").trim(),
    }))
    .filter((r) => r.text);
}

export function mineComplaints(rows) {
  const counts = {};
  const examples = {};
  const seen = new Set();
  let sample = 0;
  for (const row of rows) {
    for (const review of reviewsOf(row)) {
      if (!review.rating || review.rating > LOW_STAR) continue;
      const key = review.text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      sample++;
      const low = review.text.toLowerCase();
      for (const [theme, pattern] of Object.entries(COMPLAINT_THEMES)) {
        if (!pattern.test(low)) continue;
        counts[theme] = (counts[theme] || 0) + 1;
        (examples[theme] ||= []).length < 2 && examples[theme].push(review.text.slice(0, 160).replace(/\s+/g, " "));
      }
    }
  }
  const themes = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([theme, count]) => ({
      theme,
      count,
      share: sample ? Math.round((100 * count) / sample) : 0,
      examples: examples[theme] || [],
    }));
  return { sample, themes };
}

function pct(part, whole) {
  return whole ? Math.round((100 * part) / whole) : null;
}

export function gapsOf(a) {
  const bits = [];
  if (a.strong <= 2 && a.competitors >= 8) bits.push("busy but few strong players");
  if (a.pctOpenSunday !== null && a.pctOpenSunday <= 25) bits.push("Sunday hours are a gap");
  if (a.pctOpenLate !== null && a.pctOpenLate <= 25) bits.push("evening hours are a gap");
  if (a.pctNoWebsite >= 50) bits.push("most have no website (online booking is a gap)");
  if (a.avgRating && a.avgRating < 4.2) bits.push("customers rate them poorly: quality is a gap");
  return bits;
}

export function describeAngle(a) {
  return gapsOf(a).join("; ") || "no obvious gap: compete on quality and brand";
}

export function analyzeArea(area, rows) {
  const competitors = rows.length;
  const strong = rows.filter((r) => num(r.review_rating) >= STRONG_RATING && num(r.review_count) >= STRONG_REVIEWS).length;
  const rated = rows.map((r) => num(r.review_rating)).filter((x) => x > 0);
  const totalReviews = rows.reduce((sum, r) => sum + num(r.review_count), 0);
  const flags = rows.map((r) => hoursFlags(r.open_hours));
  const knownSun = flags.filter((f) => f.openSunday !== null);
  const knownLate = flags.filter((f) => f.openLate !== null);
  const result = {
    area,
    competitors,
    strong,
    avgRating: rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 100) / 100 : null,
    totalReviews,
    pctNoWebsite: pct(rows.filter((r) => !hasRealWebsite(r.website)).length, competitors),
    pctOpenSunday: pct(knownSun.filter((f) => f.openSunday).length, knownSun.length),
    pctOpenLate: pct(knownLate.filter((f) => f.openLate).length, knownLate.length),
  };
  // Demand = customer activity (reviews) per strong competitor. Each service gap
  // adds 25%, so a busy area nobody serves well outranks a busy, saturated one.
  const demand = totalReviews / (1 + strong);
  const gaps = gapsOf(result);
  result.gaps = gaps.length;
  result.opportunity = Math.round(demand * (1 + 0.25 * gaps.length));
  result.angle = describeAngle(result);
  return result;
}

export function buildReport(rows, searches) {
  const byId = new Map((searches || []).map((s) => [s.id, s]));
  const groups = new Map();
  for (const row of rows) {
    const search = byId.get(String(row.input_id || "").trim());
    const category = search?.category || "All searches";
    const area = search?.area || "All areas";
    if (!groups.has(category)) groups.set(category, new Map());
    const areas = groups.get(category);
    if (!areas.has(area)) areas.set(area, new Map());
    const id = row.place_id || row.cid || row.link || `${row.title}|${row.address}`;
    areas.get(area).set(id, row); // one entry per business per area
  }

  const categories = [...groups.entries()].map(([category, areas]) => {
    const allRows = [...areas.values()].flatMap((m) => [...m.values()]);
    return {
      category,
      areas: [...areas.entries()]
        .map(([area, m]) => analyzeArea(area, [...m.values()]))
        .sort((a, b) => b.opportunity - a.opportunity),
      complaints: mineComplaints(allRows),
    };
  });
  categories.sort((a, b) => a.category.localeCompare(b.category));
  return { generatedAt: new Date().toISOString(), categories };
}

const CSV_HEADERS = [
  "category", "area", "competitors", "strong", "avgRating", "totalReviews",
  "pctNoWebsite", "pctOpenSunday", "pctOpenLate", "gaps", "opportunity", "angle",
];

function main() {
  const [inputArg, outArg, searchesArg] = process.argv.slice(2);
  const input = resolve(inputArg ?? "output/results.csv");
  const outDir = resolve(outArg ?? "output");
  const searchesPath = searchesArg ? resolve(searchesArg) : resolve(outDir, "searches.json");
  const searches = existsSync(searchesPath) ? parseJson(readFileSync(searchesPath, "utf8"), []) : [];

  const report = buildReport(readCsvObjects(input), searches);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "market.json"), JSON.stringify(report, null, 2), "utf8");
  const flat = report.categories.flatMap((c) => c.areas.map((a) => ({ category: c.category, ...a })));
  writeFileSync(resolve(outDir, "market.csv"), toCsv(CSV_HEADERS, flat), "utf8");

  for (const c of report.categories) {
    console.log(`\n${c.category}`);
    for (const a of c.areas.slice(0, 8)) {
      console.log(`  ${a.area.padEnd(28)} comp=${a.competitors} strong=${a.strong} opp=${a.opportunity} -> ${a.angle}`);
    }
    if (c.complaints.themes.length) {
      console.log(`  complaints (${c.complaints.sample} low-star reviews): ` +
        c.complaints.themes.map((t) => `${t.theme} ${t.share}%`).join(", "));
    }
  }
}

// Run when executed directly; stay quiet when imported (tests).
if (/market-insights\.mjs$/.test(process.argv[1] || "")) main();
