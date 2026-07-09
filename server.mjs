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
  const loc = String(location || "Randburg").trim();
  const cats = (categories || [])
    .map((c) => String(c).trim())
    .filter(Boolean);

  if (cats.length === 0) {
    return [`local businesses in ${loc}`];
  }

  return cats.map((cat) => `${cat} in ${loc}`);
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

    const summaryPath = join(jobDir, "summary.json");
    job.summary = existsSync(summaryPath)
      ? JSON.parse(readFileSync(summaryPath, "utf8"))
      : null;
    job.leadCount = csvToObjects(leadsPath).length;
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    appendLog(job, `Done. ${job.leadCount} no-website leads with contact info.`);
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
      return json(res, 200, {
        ok: true,
        docker,
        port: PORT,
        activeJob: activeJob?.id ?? null,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      return json(res, 200, { jobs: listJobs().slice(0, 20) });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = url.pathname.split("/")[3];
      const job = loadJob(id);
      if (!job) return json(res, 404, { error: "Job not found" });
      return json(res, 200, { job });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/leads/")) {
      const id = url.pathname.split("/")[3];
      const leadsPath = join(JOBS, id, "no-website-leads.csv");
      const job = loadJob(id);
      if (!job) return json(res, 404, { error: "Job not found" });
      return json(res, 200, {
        jobId: id,
        leads: csvToObjects(leadsPath),
        summary: job.summary ?? null,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/download/")) {
      const id = url.pathname.split("/")[3];
      const leadsPath = join(JOBS, id, "no-website-leads.csv");
      if (!existsSync(leadsPath)) return json(res, 404, { error: "No leads file" });
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="no-website-leads-${id}.csv"`,
      });
      res.end(readFileSync(leadsPath));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scrape") {
      if (activeJob) {
        return json(res, 409, {
          error: "A scrape is already running. Wait for it to finish.",
          jobId: activeJob.id,
        });
      }

      const docker = await dockerAvailable();
      if (!docker) {
        return json(res, 503, {
          error: "Docker is not running. Open Docker Desktop and try again.",
        });
      }

      const body = await readBody(req);
      const location = String(body.location || "Randburg").trim();
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
  console.log("  Lead Finder Dashboard");
  console.log("  ---------------------");
  console.log(`  Open: http://localhost:${PORT}`);
  console.log("");
});
