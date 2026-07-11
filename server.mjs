import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC = join(ROOT, "public");
const DATA = join(ROOT, "data");
const JOBS = join(DATA, "jobs");
const PORT = Number(process.env.PORT || 3847);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const SITE_NAME = process.env.SITE_NAME || "Selantra WebScrape";
const PUBLIC_URL = process.env.PUBLIC_URL || "";

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

let activeJob = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

mkdirSync(JOBS, { recursive: true });

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
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

function appendLog(job, line) {
  job.log.push({ at: new Date().toISOString(), line });
  if (job.log.length > 500) job.log = job.log.slice(-500);
  saveJob(job);
}

function buildQueries(location, categories) {
  const loc = String(location || "").trim();
  if (!loc) throw new Error("City is required.");

  const cats = (categories || [])
    .map((c) => String(c).trim())
    .filter(Boolean);

  const list = cats.length > 0 ? cats : DEFAULT_SCAN_CATEGORIES;
  return list.map((cat) => `${cat} in ${loc}`);
}

function getAuthToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return String(req.headers["x-access-token"] || "").trim();
}

function isAuthenticated(req) {
  if (!ACCESS_PASSWORD) return true;
  return getAuthToken(req) === ACCESS_PASSWORD;
}

function requireAuth(req, res) {
  if (isAuthenticated(req)) return true;
  json(res, 401, { error: "Login required." });
  return false;
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      shell: process.platform === "win32",
      env: process.env,
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr?.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(stderr || stdout || `Exit code ${code}`));
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
  const leadsPath = join(jobDir, "no-website-leads.csv");

  mkdirSync(jobDir, { recursive: true });
  writeFileSync(queriesPath, job.queries.join("\n") + "\n", "utf8");

  job.status = "scraping";
  job.startedAt = new Date().toISOString();
  saveJob(job);
  appendLog(job, `Starting scrape for ${job.location} (${job.queries.length} queries)`);

  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    "gmaps-playwright-cache:/opt",
    "-v",
    `${queriesPath}:/queries.txt:ro`,
    "-v",
    `${jobDir}:/out`,
    "gosom/google-maps-scraper",
    "-input",
    "/queries.txt",
    "-results",
    "/out/results.csv",
    "-depth",
    String(job.depth),
    "-c",
    String(job.concurrency),
    "-exit-on-inactivity",
    "3m",
    "-email",
  ];

  try {
    await runCommand("docker", dockerArgs, {
      onStdout: (text) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) appendLog(job, line.trim());
        }
      },
      onStderr: (text) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) appendLog(job, `[docker] ${line.trim()}`);
        }
      },
    });

    if (!existsSync(resultsPath)) {
      throw new Error("Scrape finished but results.csv was not created.");
    }

    job.status = "filtering";
    saveJob(job);
    appendLog(job, "Scrape done. Filtering no-website leads...");

    await runCommand("node", [
      join(ROOT, "scripts", "filter-no-website.mjs"),
      resultsPath,
      jobDir,
    ]);

    job.status = "dating";
    saveJob(job);
    appendLog(job, "Searching registration/opening dates (newest companies first)...");

    try {
      await runCommand(
        "node",
        [
          join(ROOT, "scripts", "enrich-registration-dates.mjs"),
          leadsPath,
          jobDir,
          job.location,
        ],
        {
          onStdout: (text) => {
            for (const line of text.split(/\r?\n/)) {
              if (line.trim()) appendLog(job, line.trim());
            }
          },
        }
      );
    } catch (err) {
      // Dates are a bonus — never fail the job over them.
      appendLog(job, `Date search skipped: ${err.message}`);
    }

    job.status = "auditing";
    saveJob(job);
    appendLog(job, "Auditing existing websites for broken/outdated sites...");

    try {
      await runCommand(
        "node",
        [
          join(ROOT, "scripts", "audit-websites.mjs"),
          join(jobDir, "has-website.csv"),
          jobDir,
        ],
        {
          onStdout: (text) => {
            for (const line of text.split(/\r?\n/)) {
              if (line.trim()) appendLog(job, line.trim());
            }
          },
        }
      );
    } catch (err) {
      appendLog(job, `Website audit skipped: ${err.message}`);
    }

    const summaryPath = join(jobDir, "summary.json");
    job.summary = existsSync(summaryPath)
      ? JSON.parse(readFileSync(summaryPath, "utf8"))
      : null;
    job.leadCount = csvToObjects(leadsPath).length;
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    appendLog(job, `Done. ${job.leadCount} no-website leads, newest companies first.`);
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    appendLog(job, `ERROR: ${err.message}`);
  } finally {
    activeJob = null;
    saveJob(job);
  }
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
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath));
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
        authenticated: authed,
        activeJob: activeJob?.id ?? null,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      const password = String(body.password || "");
      if (!ACCESS_PASSWORD) {
        return json(res, 200, { ok: true, authRequired: false });
      }
      if (password !== ACCESS_PASSWORD) {
        return json(res, 401, { error: "Wrong password." });
      }
      return json(res, 200, { ok: true, token: ACCESS_PASSWORD });
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      if (!requireAuth(req, res)) return;
      return json(res, 200, { jobs: listJobs().slice(0, 20) });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      if (!requireAuth(req, res)) return;
      const id = url.pathname.split("/")[3];
      const job = loadJob(id);
      if (!job) return json(res, 404, { error: "Job not found" });
      return json(res, 200, { job });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/leads/")) {
      if (!requireAuth(req, res)) return;
      const id = url.pathname.split("/")[3];
      const leadsPath = join(JOBS, id, "no-website-leads.csv");
      const badSitesPath = join(JOBS, id, "bad-website-leads.csv");
      const job = loadJob(id);
      if (!job) return json(res, 404, { error: "Job not found" });
      return json(res, 200, {
        jobId: id,
        leads: csvToObjects(leadsPath),
        badSites: csvToObjects(badSitesPath),
        summary: job.summary ?? null,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/download/")) {
      if (!requireAuth(req, res)) return;
      const id = url.pathname.split("/")[3];
      const wantBad = url.searchParams.get("file") === "bad";
      const fileName = wantBad ? "bad-website-leads.csv" : "no-website-leads.csv";
      const leadsPath = join(JOBS, id, fileName);
      if (!existsSync(leadsPath)) return json(res, 404, { error: "No leads file" });
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${wantBad ? "bad-website" : "no-website"}-leads-${id}.csv"`,
      });
      res.end(readFileSync(leadsPath));
      return;
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
      const depth = Number(body.depth || 1);
      const concurrency = Number(body.concurrency || 4);

      const job = {
        id: randomUUID().slice(0, 8),
        location,
        categories,
        queries: buildQueries(location, categories),
        depth,
        concurrency,
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
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log(`  ${SITE_NAME}`);
  console.log("  ---------------------");
  console.log(`  Port: ${PORT}`);
  if (PUBLIC_URL) console.log(`  URL:  ${PUBLIC_URL}`);
  if (ACCESS_PASSWORD) console.log("  Auth: password protected");
  console.log("");
});
