import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  appendFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { totalmem, cpus } from "node:os";
import { buildLeadsPdf } from "./scripts/leads-pdf.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC = join(ROOT, "public");
// In Docker, DATA_DIR must be the same absolute path on the host and in this
// container: scrape jobs are started on the host's Docker daemon, which
// resolves the -v mount paths below on the host, not in this container.
const DATA = process.env.DATA_DIR || join(ROOT, "data");
const JOBS = join(DATA, "jobs");
const PORT = Number(process.env.PORT || 3847);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const SITE_NAME = process.env.SITE_NAME || "Selantra WebScrape";
const PUBLIC_URL = process.env.PUBLIC_URL || "";

// The browser stores this derived token, never the password itself. It changes
// whenever ACCESS_PASSWORD changes, which logs every device out.
const SESSION_TOKEN = ACCESS_PASSWORD
  ? createHmac("sha256", ACCESS_PASSWORD).update("webscrape-session-v1").digest("hex")
  : "";
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginFailures = new Map(); // ip -> { count, resetAt }
// Job and trend ids are the first 8 hex chars of a UUID.
const ID_PATTERN = /^[a-f0-9]{8}$/;

const DEFAULT_SCAN_CATEGORIES = [
  "plumbers",
  "electricians",
  "hair salons",
  "restaurants",
  "dentists",
  "accountants",
  "beauty salons",
  "mechanics",
  "gyms",
  "lawyers",
];

// gosom -depth = how far it scrolls each Maps result list (its own default is 10).
// gosom exits by itself once every search and business is done. Its
// -exit-on-inactivity flag is not used: before the first job finishes it
// measures idle time from year 0001 and quits at the first 1-minute check,
// killing any search that takes longer than a minute to scroll (deep scans).
// This watchdog only stops a scraper that has stopped making progress.
const SCRAPER_IDLE_LIMIT_MS = 20 * 60_000;

// The scraper's headless browsers can eat all RAM and freeze the whole VM
// (dashboard and SSH included). Cap it so only the scraper gets killed, and
// size parallel browser tabs to the CPUs available.
// Each browser tab needs roughly 1.5 GB to be comfortable, so a 1 GB VM
// (Oracle's E2.1.Micro) gets a single tab instead of one per CPU.
const TOTAL_MEMORY_MB = Math.floor(totalmem() / 1048576);
const SCRAPER_MEMORY_MB = Math.max(384, Math.floor(TOTAL_MEMORY_MB * 0.6));
const DEFAULT_CONCURRENCY = Math.max(
  1,
  Math.min(4, cpus().length, Math.floor(TOTAL_MEMORY_MB / 1536))
);
const SMALL_SERVER = TOTAL_MEMORY_MB < 3000;
// Searches per fresh scraper container (see runScrapeJob).
const SEARCHES_PER_SCRAPER = SMALL_SERVER ? 1 : 10;
const OOM_EXIT_CODE = 137;
const DEFAULT_DEPTH = 10;
const MAX_DEPTH = 30;
const MAX_QUERIES = 400;

let activeJob = null;

// Google Trends (free) via tools/trends.py.
const TRENDS = join(DATA, "trends");
const TRENDS_PYTHON = process.env.TRENDS_PYTHON || "python3";
const TRENDS_SCRIPT = join(ROOT, "tools", "trends.py");
const TREND_TIMEFRAMES = ["today 3-m", "today 12-m", "today 5-y"];
const MAX_TREND_TERMS = 10;
const TREND_TIMEOUT_MS = 20 * 60_000;
let activeTrend = null;
let trendsAvailable = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

mkdirSync(JOBS, { recursive: true });
mkdirSync(TRENDS, { recursive: true });

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

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

    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
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

function csvToObjects(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  if (table.length < 2) return [];
  const headers = table[0];
  return table.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? "";
    });
    return obj;
  });
}

const rowCountCache = new Map(); // path -> { size, rows }

/**
 * Data rows in a CSV without building objects (quote-aware, so newlines inside
 * reviews don't count). Cached by file size: the progress monitor calls this
 * every 5s and growing scrape files can be several MB.
 */
function csvRowCount(path) {
  if (!existsSync(path)) return 0;
  const { size } = statSync(path);
  const cached = rowCountCache.get(path);
  if (cached && cached.size === size) return cached.rows;
  const text = readFileSync(path, "utf8");
  let records = 0;
  let inQuotes = false;
  let lineHasData = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 34) inQuotes = !inQuotes; // "
    else if (ch === 10 && !inQuotes) {
      if (lineHasData) records++;
      lineHasData = false;
      continue;
    }
    if (ch !== 13 && ch !== 10) lineHasData = true;
  }
  if (lineHasData) records++;
  const rows = Math.max(0, records - 1); // minus header
  rowCountCache.set(path, { size, rows });
  return rows;
}

/** Append one batch's CSV to the combined results (header only once), then delete it. */
function appendCsvPart(targetPath, partPath) {
  if (!existsSync(partPath)) return;
  const text = readFileSync(partPath, "utf8").replace(/^\uFEFF/, "");
  const firstBreak = text.indexOf("\n");
  if (text.trim() && firstBreak !== -1) {
    if (!existsSync(targetPath)) {
      writeFileSync(targetPath, text, "utf8");
    } else {
      const body = text.slice(firstBreak + 1);
      const existing = readFileSync(targetPath, "utf8");
      const sep = existing.endsWith("\n") ? "" : "\n";
      if (body.trim()) appendFileSync(targetPath, sep + body, "utf8");
    }
  }
  unlinkSync(partPath);
}

function loadJob(id) {
  const metaPath = join(JOBS, id, "job.json");
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, "utf8"));
}

function saveJob(job) {
  const dir = join(JOBS, job.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job.json"), JSON.stringify(job, null, 2), "utf8");
}

const saveTimers = new Map();

/** Coalesce frequent progress updates into at most one disk write per second. */
function scheduleSave(job) {
  if (saveTimers.has(job.id)) return;
  saveTimers.set(
    job.id,
    setTimeout(() => {
      saveTimers.delete(job.id);
      saveJob(job);
    }, 1000)
  );
}

function appendLog(job, line) {
  job.log.push({ at: new Date().toISOString(), line });
  if (job.log.length > 500) job.log = job.log.slice(-500);
  scheduleSave(job);
}

/** Feed chunked process output to onLine one complete line at a time. */
function lineSplitter(onLine) {
  let pending = "";
  return (text) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line.trim());
  };
}

function searchLabel(jobDescription) {
  const m = jobDescription.match(/\/maps\/search\/([^,}\s]+)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " "));
  } catch {
    return m[1].replace(/\+/g, " ");
  }
}

/**
 * Turn gosom's JSON log lines into progress counters and readable log lines.
 * Each search and each business page logs "job finished" when done.
 */
function handleScraperLine(job, line) {
  if (/^[║╔╚═]/.test(line) || line.startsWith("posthog")) return; // banner, telemetry noise

  let ev = null;
  if (line.startsWith("{")) {
    try {
      ev = JSON.parse(line);
    } catch {
      ev = null;
    }
  }
  if (!ev) {
    appendLog(job, line);
    return;
  }

  const p = job.progress;
  if (ev.message === "job finished" && typeof ev.job === "string") {
    if (ev.job.includes("/maps/search/")) {
      p.searchesDone++;
      p.lastActivityAt = Date.now();
      const label = searchLabel(ev.job);
      const verb = ev.status === "failed" ? "failed" : "done";
      appendLog(job, `Search ${p.searchesDone}/${p.searchesTotal} ${verb}: ${label}`);
    } else if (ev.job.includes("/maps/place/") && ev.status !== "failed") {
      p.placesDone++;
      p.lastActivityAt = Date.now();
      p.businessesFound = Math.max(p.businessesFound, p.placesDone);
      if (p.placesDone % 25 === 0) appendLog(job, `${p.placesDone} businesses scraped so far`);
      scheduleSave(job);
    }
    return;
  }
  if (ev.message === "starting scrapemate") {
    appendLog(job, "Scraper engine started, opening Google Maps...");
  } else if (ev.level === "error" && ev.message !== "error while processing job") {
    appendLog(job, `Scraper error: ${ev.error || ev.message}`);
  }
}

function handleFilterLine(job, line) {
  const p = job.progress;
  const checking = line.match(/^\[audit\] checking (\d+) websites/);
  const checked = line.match(/^\[audit\] (\d+)\/(\d+) websites checked/);
  if (checking) {
    p.phase = "auditing";
    p.auditTotal = Number(checking[1]);
    appendLog(job, `Checking ${p.auditTotal} websites for outdated or broken sites...`);
  } else if (checked) {
    p.auditDone = Number(checked[1]);
    p.auditTotal = Number(checked[2]);
    appendLog(job, `Websites checked: ${p.auditDone}/${p.auditTotal}`);
  }
}

function cleanList(values) {
  return [...new Set((values || []).map((v) => String(v).trim()).filter(Boolean))];
}

/**
 * Every category in every suburb (or just the city), e.g. "plumbers in Randburg, Johannesburg".
 * Each search gets an id that the scraper copies into every result row (input_id),
 * so the market analysis knows which area and business type a row came from.
 */
function buildSearches(location, categories, suburbs) {
  const loc = String(location || "").trim();
  if (!loc) throw new Error("City is required.");

  const cats = cleanList(categories);
  const list = cats.length > 0 ? cats : DEFAULT_SCAN_CATEGORIES;
  const subs = cleanList(suburbs);
  const areas = subs.length ? subs.map((s) => ({ area: s, place: `${s}, ${loc}` })) : [{ area: loc, place: loc }];

  return areas.flatMap(({ area, place }) =>
    list.map((category) => ({ query: `${category} in ${place}`, area, category }))
  ).map((search, i) => ({ id: `q${i}`, ...search }));
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

/** Newest lead file for a job (leads.csv; older jobs only have no-website-leads.csv). */
function leadsFile(id) {
  const all = join(JOBS, id, "leads.csv");
  return existsSync(all) ? all : join(JOBS, id, "no-website-leads.csv");
}

function getAuthToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return String(req.headers["x-access-token"] || "").trim();
}

/** Constant-time string comparison (hashing first hides length differences). */
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function isAuthenticated(req) {
  if (!ACCESS_PASSWORD) return true;
  return safeEqual(getAuthToken(req), SESSION_TOKEN);
}

/** Caddy is the only client in production; it sets X-Forwarded-For. */
function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function loginBlocked(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || Date.now() > entry.resetAt) {
    loginFailures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }
}

/** The id segment of /api/<resource>/<id>[/...], or null if it isn't a valid id. */
function routeId(url) {
  const id = url.pathname.split("/")[3] || "";
  return ID_PATTERN.test(id) ? id : null;
}

function requireAuth(req, res) {
  if (isAuthenticated(req)) return true;
  json(res, 401, { error: "Login required." });
  return false;
}

/**
 * Run a program without a shell (arguments are never re-parsed, so paths with
 * spaces and user text are safe on every OS). Optional timeoutMs kills it.
 */
function runCommand(cmd, args, { onStdout, onStderr, timeoutMs } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env, windowsHide: true });

    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }, timeoutMs)
      : null;

    // Keep only the tail: long scrapes print far more than we ever need.
    const TAIL = 8000;
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => {
      const text = d.toString();
      stdout = (stdout + text).slice(-TAIL);
      onStdout?.(text);
    });

    child.stderr?.on("data", (d) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-TAIL);
      onStderr?.(text);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`Timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
        err.timedOut = true;
        return reject(err);
      }
      if (code === 0) return resolvePromise({ stdout, stderr });
      const lastLine = (stderr || stdout).trim().split(/\r?\n/).pop() || "";
      const err = new Error(lastLine.slice(0, 300) || `Exit code ${code}`);
      err.exitCode = code;
      reject(err);
    });
  });
}

async function dockerAvailable() {
  try {
    await runCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

async function runScrapeJob(job) {
  const jobDir = join(JOBS, job.id);
  const queriesPath = join(jobDir, "queries.txt");
  const resultsPath = join(jobDir, "results.csv");

  mkdirSync(jobDir, { recursive: true });
  writeFileSync(queriesPath, job.queries.join("\n") + "\n", "utf8");

  job.status = "scraping";
  job.startedAt = new Date().toISOString();
  job.progress = {
    phase: "scraping",
    searchesTotal: job.queries.length,
    searchesDone: 0,
    placesDone: 0,
    businessesFound: 0,
    auditDone: 0,
    auditTotal: 0,
  };
  saveJob(job);
  appendLog(
    job,
    `Starting scrape for ${job.location}: ${job.queries.length} searches, depth ${job.depth}` +
      (job.auditSites ? ", auditing websites" : "")
  );

  // Searches run in batches, each in a fresh scraper container. Headless
  // Chrome's memory only grows during a run, so restarting it between
  // batches hands everything back to the OS, and a batch that crashes
  // (e.g. out of memory) costs only its own searches, not the whole scan.
  const searches = job.searches || job.queries.map((query, i) => ({ id: `q${i}`, query }));
  writeFileSync(join(jobDir, "searches.json"), JSON.stringify(searches, null, 2), "utf8");
  const batches = [];
  for (let i = 0; i < searches.length; i += SEARCHES_PER_SCRAPER) {
    batches.push(searches.slice(i, i + SEARCHES_PER_SCRAPER));
  }
  const multiBatch = batches.length > 1;
  if (multiBatch) {
    appendLog(
      job,
      `Running ${batches.length} batches of up to ${SEARCHES_PER_SCRAPER} search${
        SEARCHES_PER_SCRAPER === 1 ? "" : "es"
      }, with a fresh scraper (and freed memory) for each.`
    );
  }

  let ranOutOfMemory = false;
  let searchesBefore = 0;
  const onScraperLine = (line) => handleScraperLine(job, line);

  try {
    for (const [index, batch] of batches.entries()) {
      if (job.stopRequested) break;
      const batchQueries = join(jobDir, `queries-${index}.txt`);
      const batchResults = join(jobDir, `results-${index}.csv`);
      // "query #!# id": gosom searches the query and writes the id as input_id.
      writeFileSync(batchQueries, batch.map((b) => `${b.query} #!# ${b.id}`).join("\n") + "\n", "utf8");

      const containerName = `gmaps-${job.id}-${index}`;
      job.currentContainer = containerName;
      const dockerArgs = [
        "run",
        "--rm",
        "--name",
        containerName,
        "--memory",
        `${SCRAPER_MEMORY_MB}m`,
        "--memory-swap",
        `${SCRAPER_MEMORY_MB}m`,
        "-v",
        "gmaps-playwright-cache:/opt",
        "-v",
        `${batchQueries}:/queries.txt:ro`,
        "-v",
        `${jobDir}:/out`,
        "gosom/google-maps-scraper",
        "-input",
        "/queries.txt",
        "-results",
        `/out/results-${index}.csv`,
        "-depth",
        String(job.depth),
        "-c",
        String(job.concurrency),
      ];
      // Email crawling visits each listing's website: only worth it when sites become leads.
      if (job.auditSites) dockerArgs.push("-email");

      let stoppedIdle = false;
      const batchStart = Date.now();
      const monitor = setInterval(() => {
        const p = job.progress;
        // Businesses written so far: covers scraper versions whose logs we can't count.
        const rows = csvRowCount(resultsPath) + csvRowCount(batchResults);
        if (rows > p.businessesFound) {
          p.businessesFound = rows;
          p.lastActivityAt = Date.now();
          scheduleSave(job);
        }
        const lastActivity = Math.max(p.lastActivityAt || 0, batchStart);
        if (!stoppedIdle && Date.now() - lastActivity > SCRAPER_IDLE_LIMIT_MS) {
          stoppedIdle = true;
          appendLog(
            job,
            `No progress for ${SCRAPER_IDLE_LIMIT_MS / 60_000} minutes. Stopping this scraper and keeping what it found.`
          );
          // SIGTERM: gosom flushes its CSV and exits cleanly.
          runCommand("docker", ["stop", containerName]).catch(() => {});
        }
      }, 5000);

      try {
        await runCommand("docker", dockerArgs, {
          onStdout: lineSplitter(onScraperLine),
          onStderr: lineSplitter(onScraperLine),
        });
      } catch (err) {
        if (job.stopRequested) {
          // Stopped from the dashboard: docker stop makes gosom flush and exit.
        } else if (err.exitCode === OOM_EXIT_CODE && !stoppedIdle) {
          ranOutOfMemory = true;
          appendLog(
            job,
            multiBatch
              ? `Batch ${index + 1}/${batches.length} ran out of memory. Keeping what it found and moving on.`
              : "The scraper ran out of memory and was stopped. Keeping what it found."
          );
        } else if (!stoppedIdle) {
          if (!multiBatch) throw err;
          appendLog(job, `Batch ${index + 1}/${batches.length} failed (${err.message}). Moving on.`);
        }
      } finally {
        clearInterval(monitor);
      }

      appendCsvPart(resultsPath, batchResults);
      // Searches that died without logging still count as done for the bar.
      searchesBefore += batch.length;
      job.progress.searchesDone = Math.max(job.progress.searchesDone, searchesBefore);
      job.progress.businessesFound = csvRowCount(resultsPath);
      scheduleSave(job);
    }

    job.currentContainer = null;
    if (job.stopRequested) {
      appendLog(job, `Stopped. Keeping the ${csvRowCount(resultsPath)} businesses found so far.`);
    }
    if (!existsSync(resultsPath)) {
      throw new Error(
        job.stopRequested
          ? "Stopped before any businesses were found."
          : "Scrape finished but results.csv was not created."
      );
    }
    if (csvToObjects(resultsPath).length === 0) {
      throw new Error(
        ranOutOfMemory
          ? "The scraper ran out of memory before finding anything. Try fewer suburbs or business types, or Quick depth."
          : "Google Maps returned no businesses. Check the city spelling, or the server's IP may be blocked by Google (try again later)."
      );
    }

    job.progress.businessesFound = csvToObjects(resultsPath).length;
    job.progress.phase = "filtering";
    job.status = "filtering";
    saveJob(job);
    appendLog(
      job,
      job.auditSites
        ? "Scrape done. Filtering leads and auditing websites..."
        : "Scrape done. Filtering no-website leads..."
    );

    const filterArgs = [join(ROOT, "scripts", "filter-no-website.mjs"), resultsPath, jobDir];
    if (job.auditSites) filterArgs.push("--audit");
    await runCommand("node", filterArgs, {
      onStdout: lineSplitter((line) => handleFilterLine(job, line)),
    });

    // Free market-gap analysis from the same results; never fails the scan.
    try {
      await runCommand("node", [
        join(ROOT, "scripts", "market-insights.mjs"),
        resultsPath,
        jobDir,
        join(jobDir, "searches.json"),
      ]);
      job.hasMarket = existsSync(join(jobDir, "market.json"));
    } catch (err) {
      appendLog(job, `Market analysis skipped: ${err.message}`);
    }

    const summaryPath = join(jobDir, "summary.json");
    job.summary = existsSync(summaryPath)
      ? JSON.parse(readFileSync(summaryPath, "utf8"))
      : null;
    job.leadCount = csvToObjects(leadsFile(job.id)).length;
    job.status = "completed";
    job.progress.phase = "completed";
    job.finishedAt = new Date().toISOString();
    appendLog(job, `Done. ${job.leadCount} leads with contact info.`);
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    appendLog(job, `ERROR: ${err.message}`);
  } finally {
    activeJob = null;
    clearTimeout(saveTimers.get(job.id));
    saveTimers.delete(job.id);
    saveJob(job);
  }
}

async function checkTrendsAvailable() {
  try {
    await runCommand(TRENDS_PYTHON, ["-c", "import pytrends, pandas"]);
    trendsAvailable = existsSync(TRENDS_SCRIPT);
  } catch {
    trendsAvailable = false;
  }
  return trendsAvailable;
}

function loadTrend(id) {
  const file = join(TRENDS, id, "trend.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function saveTrend(trend) {
  mkdirSync(join(TRENDS, trend.id), { recursive: true });
  writeFileSync(join(TRENDS, trend.id, "trend.json"), JSON.stringify(trend, null, 2), "utf8");
}

function listTrends() {
  return readdirSync(TRENDS)
    .map((id) => loadTrend(id))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, 10)
    .map(({ id, terms, timeframe, resolution, status, createdAt }) => ({
      id, terms, timeframe, resolution, status, createdAt,
    }));
}

function toNumber(value) {
  const n = Number(value);
  return value === "" || !Number.isFinite(n) ? null : n;
}

/** Collect trends.py's CSV outputs into one JSON object for the dashboard. */
function readTrendResults(prefix) {
  const summary = csvToObjects(`${prefix}_summary.csv`).map((r) => ({
    term: r.term,
    avgInterest: toNumber(r.avg_interest),
    latest: toNumber(r.latest_4wk_avg),
    momentumPct: toNumber(r.momentum_pct),
    vsAveragePct: toNumber(r.vs_average_pct),
    direction: r.direction,
    peakWeek: r.peak_week,
    peakMonth: r.peak_month,
    lowMonth: r.low_month,
  }));

  const overTime = csvToObjects(`${prefix}_over_time.csv`);
  const series = {};
  for (const term of summary.map((r) => r.term)) {
    series[term] = overTime.map((row) => toNumber(row[term]) ?? 0);
  }

  const regionRows = csvToObjects(`${prefix}_regions.csv`);
  const topRegions = {};
  for (const term of summary.map((r) => r.term)) {
    topRegions[term] = regionRows
      .map((row) => ({ region: row.region || row.geoName || "", value: toNumber(row[term]) ?? 0 }))
      .filter((r) => r.region && r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
  }

  const rising = csvToObjects(`${prefix}_rising.csv`).map((r) => ({
    term: r.term,
    query: r.rising_query,
    growth: r.growth,
  }));

  return {
    summary,
    dates: overTime.map((row) => row.date),
    series,
    topRegions,
    rising,
  };
}

async function runTrendJob(trend) {
  const dir = join(TRENDS, trend.id);
  const prefix = join(dir, "trends");
  trend.status = "running";
  trend.startedAt = new Date().toISOString();
  saveTrend(trend);

  const log = (line) => {
    if (!line.startsWith("[")) return; // skip the script's printed tables
    trend.log.push(line);
    if (trend.log.length > 100) trend.log = trend.log.slice(-100);
    saveTrend(trend);
  };

  try {
    await runCommand(
      TRENDS_PYTHON,
      [
        TRENDS_SCRIPT,
        "--terms", trend.terms.join(","),
        "--geo", "ZA",
        "--timeframe", trend.timeframe,
        "--resolution", trend.resolution,
        "--out-prefix", prefix,
      ],
      { onStdout: lineSplitter(log), onStderr: lineSplitter(log), timeoutMs: TREND_TIMEOUT_MS }
    );
    trend.result = readTrendResults(prefix);
    trend.status = "completed";
  } catch (err) {
    trend.status = "failed";
    trend.error = err.timedOut
      ? "Google Trends took too long (over 20 minutes). Try again later or with fewer terms."
      : /refusing|429/i.test(err.message)
        ? "Google Trends is rate-limiting this server. Wait 10-15 minutes and try again, or use fewer terms."
        : err.message;
  } finally {
    trend.finishedAt = new Date().toISOString();
    activeTrend = null;
    saveTrend(trend);
  }
}

/**
 * After a crash or reboot, work that was running can never finish: mark it
 * failed so the dashboard doesn't wait on it forever, and remove scraper
 * containers left behind (they would keep using memory).
 */
async function recoverInterruptedWork() {
  const now = new Date().toISOString();
  for (const job of listJobs()) {
    if (!["queued", "scraping", "filtering"].includes(job.status)) continue;
    job.status = "failed";
    job.error = "Interrupted: the server restarted during this scan. Please run it again.";
    job.finishedAt = job.finishedAt || now;
    job.log = [...(job.log || []), { at: now, line: `ERROR: ${job.error}` }];
    saveJob(job);
  }
  for (const id of readdirSync(TRENDS)) {
    const trend = loadTrend(id);
    if (!trend || !["queued", "running"].includes(trend.status)) continue;
    trend.status = "failed";
    trend.error = "Interrupted: the server restarted during this check. Please run it again.";
    trend.finishedAt = trend.finishedAt || now;
    saveTrend(trend);
  }
  try {
    const { stdout } = await runCommand("docker", ["ps", "-aq", "--filter", "name=^gmaps-"]);
    const ids = stdout.split(/\s+/).filter(Boolean);
    if (ids.length) {
      await runCommand("docker", ["rm", "-f", ...ids]);
      console.log(`  Removed ${ids.length} leftover scraper container(s).`);
    }
  } catch {
    /* docker unavailable: nothing to clean */
  }
}

// Business photos come from Google's image CDN. Fetch only from there (no
// arbitrary URLs from scraped data), small, and only formats PDFs can embed.
const PHOTO_HOSTS = /(^|\.)(googleusercontent\.com|ggpht\.com)$/i;
const MAX_PHOTO_BYTES = 600_000;

async function fetchPhoto(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !PHOTO_HOSTS.test(parsed.hostname)) return null;
  const res = await fetch(parsed, {
    redirect: "error",
    signal: AbortSignal.timeout(6000),
    headers: { Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.1" },
  });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_PHOTO_BYTES) return null;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return isJpeg || isPng ? bytes : null;
}

/**
 * Leads for the PDF, enriched from the raw results: the business type and
 * suburb that were searched (via input_id -> searches.json), and photos for
 * scans made before leads.csv kept them.
 */
function leadsForReport(id) {
  const leads = csvToObjects(leadsFile(id));
  const searchesPath = join(JOBS, id, "searches.json");
  const searches = new Map(
    (existsSync(searchesPath) ? JSON.parse(readFileSync(searchesPath, "utf8")) : []).map((s) => [s.id, s])
  );
  const byLink = new Map(csvToObjects(join(JOBS, id, "results.csv")).map((r) => [r.link, r]));
  return leads.map((lead) => {
    const raw = byLink.get(lead.google_maps_link) || {};
    const search = searches.get(String(raw.input_id || "").trim());
    return {
      ...lead,
      thumbnail: lead.thumbnail || raw.thumbnail || "",
      search_type: search?.category || "",
      area: search?.area || "",
    };
  });
}

function reportSubtitle(job) {
  const date = new Date(job.finishedAt || job.createdAt || Date.now()).toLocaleDateString("en-ZA", {
    day: "numeric", month: "short", year: "numeric",
  });
  const parts = [`Scanned ${date}`];
  if (job.suburbs?.length) parts.push(job.suburbs.join(", "));
  if (job.categories?.length) parts.push(job.categories.join(", "));
  return parts.join(" · ");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);

  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = extname(filePath);
  const body = readFileSync(filePath);
  const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
  // no-cache = always revalidate, so a deploy shows up on the next load without
  // a hard refresh; the ETag makes unchanged files a cheap 304.
  const headers = { "Cache-Control": "no-cache", ETag: etag };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(body);
}

function listJobs() {
  if (!existsSync(JOBS)) return [];
  return readdirSync(JOBS)
    .map((id) => loadJob(id))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      const docker = await dockerAvailable();
      const authed = isAuthenticated(req);
      return json(res, 200, {
        ok: true,
        docker,
        port: PORT,
        siteName: SITE_NAME,
        publicUrl: PUBLIC_URL || null,
        authRequired: Boolean(ACCESS_PASSWORD),
        memoryMb: TOTAL_MEMORY_MB,
        trends: trendsAvailable,
        smallServer: SMALL_SERVER,
        authenticated: authed,
        activeJob: activeJob?.id ?? null,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!ACCESS_PASSWORD) {
        return json(res, 200, { ok: true, authRequired: false });
      }
      const ip = clientIp(req);
      if (loginBlocked(ip)) {
        return json(res, 429, { error: "Too many wrong passwords. Try again in 15 minutes." });
      }
      const body = await readBody(req);
      const password = String(body.password || "");
      if (!safeEqual(password, ACCESS_PASSWORD)) {
        recordLoginFailure(ip);
        return json(res, 401, { error: "Wrong password." });
      }
      loginFailures.delete(ip);
      return json(res, 200, { ok: true, token: SESSION_TOKEN });
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      if (!requireAuth(req, res)) return;
      // Summaries only: the full logs are fetched per job.
      const jobs = listJobs()
        .slice(0, 20)
        .map(({ id, location, suburbs, status, createdAt, finishedAt, leadCount, auditSites }) => ({
          id,
          location,
          suburbs,
          status,
          createdAt,
          finishedAt,
          leadCount,
          auditSites,
        }));
      return json(res, 200, { jobs });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      if (!requireAuth(req, res)) return;
      const id = routeId(url);
      if (!id) return json(res, 404, { error: "Job not found" });
      // The running job lives in memory; disk writes are throttled.
      const job = activeJob?.id === id ? activeJob : loadJob(id);
      if (!job) return json(res, 404, { error: "Job not found" });
      // The dashboard polls every 2s and shows the last 80 lines; don't send 500.
      const { searches, ...rest } = job;
      return json(res, 200, { job: { ...rest, log: (job.log || []).slice(-80) } });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/leads/")) {
      if (!requireAuth(req, res)) return;
      const id = routeId(url);
      if (!id) return json(res, 404, { error: "Job not found" });
      const job = loadJob(id);
      if (!job) return json(res, 404, { error: "Job not found" });
      return json(res, 200, {
        jobId: id,
        leads: csvToObjects(leadsFile(id)),
        summary: job.summary ?? null,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/trends") {
      if (!requireAuth(req, res)) return;
      if (trendsAvailable === null) await checkTrendsAvailable();
      return json(res, 200, {
        available: trendsAvailable,
        active: activeTrend?.id ?? null,
        trends: listTrends(),
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/trends/")) {
      if (!requireAuth(req, res)) return;
      const id = routeId(url);
      if (!id) return json(res, 404, { error: "Not found" });
      const trend = activeTrend?.id === id ? activeTrend : loadTrend(id);
      if (!trend) return json(res, 404, { error: "Not found" });
      return json(res, 200, { trend });
    }

    if (req.method === "POST" && url.pathname === "/api/trends") {
      if (!requireAuth(req, res)) return;
      if (activeTrend) {
        return json(res, 409, { error: "A trends check is already running.", id: activeTrend.id });
      }
      if (!(await checkTrendsAvailable())) {
        return json(res, 503, {
          error: "Trends isn't installed on this server yet (needs Python + pytrends). It installs with the next update.",
        });
      }
      const body = await readBody(req);
      const rawTerms = Array.isArray(body.terms) ? body.terms : String(body.terms || "").split(/[,\n]/);
      const terms = cleanList(rawTerms).map((t) => t.slice(0, 60));
      if (!terms.length) return json(res, 400, { error: "Add at least one search term." });
      if (terms.length > MAX_TREND_TERMS) {
        return json(res, 400, { error: `Use at most ${MAX_TREND_TERMS} terms per check.` });
      }
      if (activeTrend) {
        return json(res, 409, { error: "A trends check is already running.", id: activeTrend.id });
      }
      const trend = {
        id: randomUUID().slice(0, 8),
        terms,
        timeframe: TREND_TIMEFRAMES.includes(body.timeframe) ? body.timeframe : "today 12-m",
        resolution: body.resolution === "CITY" ? "CITY" : "REGION",
        status: "queued",
        createdAt: new Date().toISOString(),
        log: [],
        result: null,
        error: null,
      };
      saveTrend(trend);
      activeTrend = trend;
      runTrendJob(trend);
      return json(res, 202, { trend });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/market/")) {
      if (!requireAuth(req, res)) return;
      const id = routeId(url);
      const format = url.pathname.split("/")[4];
      if (!id || !loadJob(id)) return json(res, 404, { error: "Job not found" });
      const file = join(JOBS, id, format === "csv" ? "market.csv" : "market.json");
      if (!existsSync(file)) return json(res, 404, { error: "No market analysis for this scan" });
      if (format === "csv") {
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="market-${id}.csv"`,
        });
        return res.end(readFileSync(file));
      }
      return json(res, 200, JSON.parse(readFileSync(file, "utf8")));
    }

    if (req.method === "GET" && /^\/api\/report\/[a-f0-9]{8}\/pdf$/.test(url.pathname)) {
      if (!requireAuth(req, res)) return;
      const id = routeId(url);
      const job = loadJob(id);
      if (!job || !existsSync(leadsFile(id))) return json(res, 404, { error: "No leads for this scan" });
      // Cached until the leads change (photos make generation take a few seconds).
      const pdfPath = join(JOBS, id, "leads.pdf");
      const fresh = existsSync(pdfPath) && statSync(pdfPath).mtimeMs >= statSync(leadsFile(id)).mtimeMs;
      if (!fresh) {
        const pdf = await buildLeadsPdf({
          leads: leadsForReport(id),
          title: `Leads - ${job.location}`,
          subtitle: reportSubtitle(job),
          fetchImage: fetchPhoto,
        });
        writeFileSync(pdfPath, pdf);
      }
      const name = `leads-${String(job.location).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${id}.pdf`;
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      });
      return res.end(readFileSync(pdfPath));
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/download/")) {
      if (!requireAuth(req, res)) return;
      const id = routeId(url);
      if (!id || !loadJob(id)) return json(res, 404, { error: "Job not found" });
      const leadsPath = leadsFile(id);
      if (!existsSync(leadsPath)) return json(res, 404, { error: "No leads file" });
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="leads-${id}.csv"`,
      });
      res.end(readFileSync(leadsPath));
      return;
    }

    if (req.method === "POST" && /^\/api\/scrape\/[a-f0-9]{8}\/stop$/.test(url.pathname)) {
      if (!requireAuth(req, res)) return;
      const id = routeId(url);
      if (!activeJob || activeJob.id !== id) {
        return json(res, 409, { error: "That scan isn't running." });
      }
      if (activeJob.status !== "scraping") {
        return json(res, 409, { error: "Almost done: the scan is already processing its results." });
      }
      if (!activeJob.stopRequested) {
        activeJob.stopRequested = true;
        appendLog(activeJob, "Stopping: finishing up and keeping what was found so far...");
        if (activeJob.currentContainer) {
          runCommand("docker", ["stop", activeJob.currentContainer]).catch(() => {});
        }
      }
      return json(res, 202, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/scrape") {
      if (!requireAuth(req, res)) return;

      if (activeJob) {
        return json(res, 409, {
          error: "A scrape is already running. Wait for it to finish.",
          jobId: activeJob.id,
        });
      }

      const docker = await dockerAvailable();
      if (!docker) {
        return json(res, 503, {
          error: "Scraper engine is offline. Contact admin or retry shortly.",
        });
      }

      const body = await readBody(req);
      const location = String(body.location || "").trim();
      if (!location) {
        return json(res, 400, { error: "City is required." });
      }
      const categories = Array.isArray(body.categories) ? body.categories : [];
      const suburbs = Array.isArray(body.suburbs) ? cleanList(body.suburbs) : [];
      const searches = buildSearches(location, categories, suburbs);
      const queries = searches.map((search) => search.query);
      if (queries.length > MAX_QUERIES) {
        return json(res, 400, {
          error: `That is ${queries.length} searches (max ${MAX_QUERIES}). Use fewer suburbs or business types.`,
        });
      }

      // Re-check: another request may have started a scan during the awaits above.
      if (activeJob) {
        return json(res, 409, { error: "A scrape is already running. Wait for it to finish.", jobId: activeJob.id });
      }
      const job = {
        id: randomUUID().slice(0, 8),
        location,
        categories,
        suburbs,
        queries,
        searches,
        // Deep scrolling multiplies browser memory; keep tiny servers shallow.
        depth: Math.min(
          clampInt(body.depth, 1, MAX_DEPTH, DEFAULT_DEPTH),
          SMALL_SERVER ? 3 : MAX_DEPTH
        ),
        concurrency: clampInt(body.concurrency, 1, 16, DEFAULT_CONCURRENCY),
        auditSites: Boolean(body.auditSites),
        status: "queued",
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        leadCount: 0,
        summary: null,
        error: null,
        log: [],
      };

      saveJob(job);
      activeJob = job;
      runScrapeJob(job);

      return json(res, 202, { job });
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      return serveStatic(req, res);
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(`[${req.method} ${url.pathname}]`, err);
    const expected = /Body too large|Invalid JSON|City is required/.test(err.message);
    json(res, expected ? 400 : 500, { error: expected ? err.message : "Something went wrong on the server." });
  }
});

checkTrendsAvailable();
await recoverInterruptedWork();

server.listen(PORT, () => {
  console.log("");
  console.log(`  ${SITE_NAME}`);
  console.log("  ---------------------");
  console.log(`  Port: ${PORT}`);
  if (PUBLIC_URL) console.log(`  URL:  ${PUBLIC_URL}`);
  if (ACCESS_PASSWORD) console.log("  Auth: password protected");
  console.log("");
});
