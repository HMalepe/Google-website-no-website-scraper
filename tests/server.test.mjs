// Integration tests: the real server, with a stand-in docker CLI (tests/fixtures/bin).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
let graph;
const GRAPH_PORT = PORT + 1;

// Fake Meta Graph API: "<id>_salon" handles are business accounts, "private_*" can't be found.
function startFakeGraph() {
  graph = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const fields = url.searchParams.get("fields") || "";
    const send = (body) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.searchParams.get("access_token") === "EAAG-bad-token-000000000") {
      return send({ error: { code: 190, message: "Invalid OAuth access token" } });
    }
    if (fields === "username") return send({ id: "17841400000000001", username: "selantra_test" });
    const handle = (fields.match(/business_discovery\.username\(([^)]+)\)/) || [])[1] || "";
    if (handle.startsWith("private_")) return send({ error: { code: 110, message: "Invalid user id" } });
    send({
      business_discovery: {
        followers_count: 12000,
        media_count: 340,
        media: { data: [{ like_count: 300, comments_count: 30 }, { like_count: 210, comments_count: 20 }] },
      },
    });
  });
  return new Promise((r) => graph.listen(GRAPH_PORT, "127.0.0.1", r));
}

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

  await startFakeGraph();
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: DATA,
      ACCESS_PASSWORD: PASSWORD,
      TRENDS_PYTHON: "python-that-does-not-exist",
      IG_GRAPH_BASE: `http://127.0.0.1:${GRAPH_PORT}`,
      IG_DELAY_MS: "0",
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

after(() => {
  server?.kill();
  graph?.close();
});

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

test("PDF report downloads for a finished scan", async () => {
  const { data } = await api("/api/jobs");
  const done = data.jobs.find((j) => j.status === "completed");
  assert.ok(done, "needs the scan from the previous test");
  const res = await fetch(`${BASE}/api/report/${done.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition"), /leads-johannesburg-.*\.pdf/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.equal((await fetch(`${BASE}/api/report/${done.id}/pdf`)).status, 401, "needs login");
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

test("instagram: connect, find handles, rank audiences, never leak the token", async () => {
  const bad = await api("/api/instagram/settings", {
    method: "POST",
    body: { userId: "17841400000000001", token: "EAAG-bad-token-000000000" },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Meta said/);

  const goodToken = "EAAG-good-token-1234567890";
  const saved = await api("/api/instagram/settings", { method: "POST", body: { userId: "17841400000000001", token: goodToken } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.username, "selantra_test");
  assert.ok(!JSON.stringify(saved.data).includes(goodToken), "token must never be sent back");
  assert.ok(!JSON.stringify((await api("/api/instagram/settings")).data).includes(goodToken));

  const { data: jobs } = await api("/api/jobs");
  const scan = jobs.jobs.find((j) => j.status === "completed");
  const { data: found } = await api(`/api/instagram/handles/${scan.id}`);
  const handles = found.handles.map((h) => h.handle);
  assert.ok(handles.some((h) => h.endsWith("_salon")), "instagram.com/<handle> website found");
  assert.ok(handles.some((h) => h.startsWith("private_")), "bare instagram.com/<handle> found");

  const start = await api("/api/instagram", { method: "POST", body: { scanId: scan.id, minFollowers: 3000 } });
  assert.equal(start.status, 202);
  let check;
  for (let i = 0; i < 50; i++) {
    check = (await api(`/api/instagram/${start.data.check.id}`)).data.check;
    if (check.status !== "queued" && check.status !== "running") break;
    await sleep(100);
  }
  assert.equal(check.status, "completed", check.error);
  const hit = check.results.find((r) => r.handle.endsWith("_salon"));
  assert.equal(hit.followers, 12000);
  assert.equal(hit.engagement, 2.33); // (330 + 230) / 2 posts / 12000 followers
  assert.equal(hit.passes, true);
  assert.ok(check.unresolved.some((u) => u.handle.startsWith("private_")));

  const csv = await fetch(`${BASE}/api/instagram/${check.id}/csv`, { headers: { Authorization: `Bearer ${token}` } });
  assert.match(await csv.text(), /^passes,followers,engagement/);

  assert.equal((await api("/api/instagram/settings", { method: "DELETE" })).data.configured, false);
  const noCreds = await api("/api/instagram", { method: "POST", body: { scanId: scan.id } });
  assert.equal(noCreds.status, 400);
});
