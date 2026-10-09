// Integration tests: the real server, with a stand-in docker CLI (tests/fixtures/bin).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "correct-horse-battery";
const DATA = mkdtempSync(join(tmpdir(), "webscrape-"));
let server;
let token;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body, auth = true, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  // A scan that was running when the "server crashed".
  mkdirSync(join(DATA, "jobs", "deadbeef"), { recursive: true });
  writeFileSync(
    join(DATA, "jobs", "deadbeef", "job.json"),
    JSON.stringify({ id: "deadbeef", status: "scraping", createdAt: "2026-01-01T00:00:00Z", log: [] })
  );

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: DATA,
      ACCESS_PASSWORD: PASSWORD,
      TRENDS_PYTHON: "python-that-does-not-exist",
      PATH: `${join(ROOT, "tests", "fixtures", "bin")}${delimiter}${process.env.PATH}`,
    },
    stdio: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("server did not start");
});

after(() => server?.kill());

test("login: wrong password rejected, token is not the password", async () => {
  assert.equal((await api("/api/jobs", { auth: false })).status, 401);
  const wrong = await api("/api/login", { method: "POST", body: { password: "nope" }, auth: false });
  assert.equal(wrong.status, 401);
  const ok = await api("/api/login", { method: "POST", body: { password: PASSWORD }, auth: false });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token && ok.data.token !== PASSWORD);
  token = ok.data.token;
  assert.equal((await api("/api/jobs")).status, 200);
});

test("login is rate limited per client", async () => {
  const headers = { "X-Forwarded-For": "203.0.113.9" };
  for (let i = 0; i < 10; i++) {
    const r = await api("/api/login", { method: "POST", body: { password: "x" }, auth: false, headers });
    assert.equal(r.status, 401);
  }
  const blocked = await api("/api/login", { method: "POST", body: { password: PASSWORD }, auth: false, headers });
  assert.equal(blocked.status, 429);
});

test("a scan interrupted by a restart is marked failed, not left running", async () => {
  const { data } = await api("/api/jobs/deadbeef");
  assert.equal(data.job.status, "failed");
  assert.match(data.job.error, /Interrupted/);
});

test("invalid ids are rejected", async () => {
  for (const path of ["/api/jobs/..%2F..%2Fetc", "/api/jobs/ZZZZZZZZ", "/api/leads/123", "/api/market/abc/csv"]) {
    assert.equal((await api(path)).status, 404, path);
  }
});

test("stop is refused when nothing is running", async () => {
  assert.equal((await api("/api/scrape/deadbeef/stop", { method: "POST" })).status, 409);
});

test("full scan: one at a time, leads, WhatsApp only for mobiles, market gaps", async () => {
  const body = { location: "Johannesburg", suburbs: ["Randburg", "Sandton"], categories: ["hair salons"], depth: 1 };
  const [first, second] = await Promise.all([
    api("/api/scrape", { method: "POST", body }),
    api("/api/scrape", { method: "POST", body }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [202, 409], "double start must not run two scans");
  const id = (first.status === 202 ? first : second).data.job.id;

  let job;
  for (let i = 0; i < 100; i++) {
    job = (await api(`/api/jobs/${id}`)).data.job;
    if (job.status === "completed" || job.status === "failed") break;
    await sleep(200);
  }
  assert.equal(job.status, "completed", job.error);
  assert.ok(job.log.length <= 80);
  assert.equal(job.progress.searchesDone, 2);

  const { data: leads } = await api(`/api/leads/${id}`);
  assert.ok(leads.leads.length > 0);
  for (const lead of leads.leads) {
    if (lead.phone.startsWith("011")) assert.equal(lead.whatsapp, "", "landline got a WhatsApp link");
  }

  const { data: market } = await api(`/api/market/${id}`);
  const [cat] = market.categories;
  assert.equal(cat.category, "hair salons");
  assert.equal(cat.areas[0].area, "Randburg", "poorly served area ranks first");
  assert.ok(cat.complaints.themes.some((t) => t.theme === "staff attitude"));
});

test("trends reports unavailable cleanly when Python isn't installed", async () => {
  const r = await api("/api/trends");
  assert.equal(r.status, 200);
  assert.equal(r.data.available, false);
  const start = await api("/api/trends", { method: "POST", body: { terms: "braids" } });
  assert.equal(start.status, 503);
});

test("static files revalidate (deploys show without a hard refresh)", async () => {
  const res = await fetch(`${BASE}/app.js`);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const etag = res.headers.get("etag");
  assert.ok(etag);
  const again = await fetch(`${BASE}/app.js`, { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
});
