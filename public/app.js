const DEFAULT_CATEGORIES = [
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

const LEAD_LABELS = {
  NO_WEBSITE: "No website",
  SOCIAL_ONLY: "Social only",
  FREE_SUBDOMAIN: "Free subdomain",
  OUTDATED_SITE: "Weak website",
};

const $ = (id) => document.getElementById(id);
const selected = new Set();

let currentJobId = null;
let pollTimer = null;
let polling = false;
let leadsShownFor = null;

// Login survives the phone killing/reloading the tab. Storage can throw
// (private mode, blocked site data), so every access is guarded.
const TOKEN_KEY = "webscrape_token";
function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}
function writeToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage unavailable: stay logged in for this page only */
  }
}
let authToken = readToken();

function authHeaders() {
  if (!authToken) return { "Content-Type": "application/json" };
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };
}

/** Never throws: a network failure comes back as { offline: true }. */
async function api(path, options = {}) {
  try {
    const res = await fetch(path, {
      ...options,
      cache: "no-store",
      headers: { ...authHeaders(), ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    setOffline(false);
    return { res, data, offline: false };
  } catch {
    setOffline(true);
    return { res: { ok: false, status: 0 }, data: {}, offline: true };
  }
}

let reconnectTimer = null;

function setOffline(offline) {
  $("connBanner").hidden = !offline;
  if (offline && !reconnectTimer) {
    // Probe every 3s while offline; any successful request clears the banner.
    reconnectTimer = setInterval(catchUp, 3000);
  } else if (!offline && reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

function showLogin() {
  $("loginScreen").hidden = false;
  $("app").hidden = true;
}

function showApp() {
  $("loginScreen").hidden = true;
  $("app").hidden = false;
}

function renderChips() {
  const wrap = $("categoryChips");
  wrap.innerHTML = "";

  for (const cat of DEFAULT_CATEGORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip${selected.has(cat) ? " active" : ""}`;
    btn.textContent = cat;
    btn.addEventListener("click", () => {
      if (selected.has(cat)) selected.delete(cat);
      else selected.add(cat);
      renderChips();
      updateQueryCount();
    });
    wrap.appendChild(btn);
  }
}

function getCustomCategories() {
  return $("customCategories")
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getAllCategories() {
  return [...selected, ...getCustomCategories()];
}

function getSuburbs() {
  return [
    ...new Set(
      $("suburbs")
        .value.split(/[,\r\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

function updateQueryCount() {
  const types = new Set(getAllCategories()).size || DEFAULT_CATEGORIES.length;
  const areas = getSuburbs().length || 1;
  const total = types * areas;
  let text = `${total} search${total === 1 ? "" : "es"} (${types} business types × ${areas} area${
    areas === 1 ? "" : "s"
  }).`;
  if (total > 400) text += " Too many — max is 400.";
  else if (total > 60) text += " Big sweep: this can take a while.";
  $("queryCount").textContent = text;
}

let initRetry = null;

async function init() {
  clearTimeout(initRetry);
  const { res, data, offline } = await api("/api/health");

  if (offline || res.status >= 500) {
    // Server unreachable or restarting (e.g. updating): keep retrying.
    setOffline(true);
    initRetry = setTimeout(init, 5000);
    return;
  }

  if (data.authRequired && !authToken) {
    showLogin();
    return;
  }

  const check = await api("/api/jobs");
  if (check.res.status === 401) {
    writeToken("");
    authToken = "";
    showLogin();
    return;
  }
  const jobs = check.data.jobs || [];

  showApp();
  updateEngineStatus(data);
  renderRecent(jobs);
  let view = "leadsView";
  try {
    view = localStorage.getItem("webscrape_view") || view;
  } catch {
    /* ignore */
  }
  if (view === "trendsView") showView(view);

  // Reopen the running scan, or the latest one, so a reload never loses results.
  const resumeId = data.activeJob || currentJobId || jobs[0]?.id;
  if (resumeId) openJob(resumeId);
}

function openJob(id) {
  currentJobId = id;
  leadsShownFor = null;
  $("resultsPanel").hidden = true;
  $("stats").hidden = true;
  $("marketPanel").hidden = true;
  startPolling();
}

function renderRecent(jobs) {
  const list = $("recentList");
  $("recentPanel").hidden = jobs.length === 0;
  list.innerHTML = jobs
    .slice(0, 10)
    .map((job) => {
      const when = job.createdAt ? new Date(job.createdAt).toLocaleString() : "";
      const areas = job.suburbs?.length ? ` · ${job.suburbs.length} suburbs` : "";
      const result =
        job.status === "completed" ? `${job.leadCount ?? 0} leads` : job.status || "";
      return `<li><button type="button" class="recent-item" data-job="${escapeHtml(job.id)}">
        <span><strong>${escapeHtml(job.location || "—")}</strong>${escapeHtml(areas)}</span>
        <span class="recent-meta">${escapeHtml(when)} · <span class="badge ${escapeHtml(
          job.status || ""
        )}">${escapeHtml(result)}</span></span>
      </button></li>`;
    })
    .join("");
}

async function refreshRecent() {
  const { res, data } = await api("/api/jobs");
  if (res.ok) renderRecent(data.jobs || []);
}

function updateEngineStatus(data) {
  const pill = $("engineStatus");
  if (data.docker) {
    pill.textContent = data.smallServer ? "Online · small server" : "Online";
    pill.title = data.smallServer
      ? `This server has ${data.memoryMb} MB RAM: scans run one browser at a time and stay shallow (slower, fewer results).`
      : "";
    pill.className = "status-pill ok";
    $("startBtn").disabled = false;
  } else {
    pill.textContent = "Engine offline";
    pill.className = "status-pill bad";
    $("startBtn").disabled = true;
  }
}

async function refreshHealth() {
  const { res, data } = await api("/api/health");
  if (res.ok && !$("app").hidden) updateEngineStatus(data);
}

/** Phones pause background tabs: catch up the moment the page is visible again. */
function catchUp() {
  if (document.visibilityState === "hidden") return;
  if ($("app").hidden && $("loginScreen").hidden) {
    init();
    return;
  }
  refreshHealth();
  if (currentJobId) pollJob();
  if (trendId && !$("trendsView").hidden) pollTrend();
}

function setJobStatus(status) {
  const badge = $("jobStatus");
  badge.textContent = status;
  badge.className = `badge ${status}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}h ${m}m` : `${m}:${s}`;
}

/** Scraping fills most of the bar; filtering / website checks the rest. */
function progressPercent(job, p) {
  const scrapeShare = job.auditSites ? 80 : 95;
  if (job.status === "completed") return 100;
  if (job.status === "filtering") {
    if (p.phase === "auditing" && p.auditTotal) {
      return scrapeShare + ((99 - scrapeShare) * p.auditDone) / p.auditTotal;
    }
    return scrapeShare + 1;
  }
  if (p.searchesTotal) return (scrapeShare * p.searchesDone) / p.searchesTotal;
  return 0;
}

function renderProgress(job) {
  const p = job.progress || {};
  const running = !["completed", "failed"].includes(job.status);
  $("scanVerb").textContent =
    job.status === "completed" ? "Scanned" : job.status === "failed" ? "Scan failed:" : "Scanning";

  const steps = [
    ["scraping", "Searching Google Maps"],
    ["filtering", "Filtering leads"],
  ];
  if (job.auditSites) steps.push(["auditing", "Checking websites"]);
  steps.push(["completed", "Done"]);

  const current =
    job.status === "completed"
      ? "completed"
      : job.status === "failed"
        ? p.phase || "scraping"
        : p.phase === "auditing"
          ? "auditing"
          : job.status;
  const currentIndex = steps.findIndex(([key]) => key === current);

  $("steps").innerHTML = steps
    .map(([key, label], i) => {
      let cls = "";
      if (job.status === "completed" || i < currentIndex) cls = "done";
      else if (i === currentIndex) cls = job.status === "failed" ? "failed" : "active";
      return `<li class="${cls}">${escapeHtml(label)}</li>`;
    })
    .join("");

  $("bar").className = `bar${running ? " running" : ""}${job.status === "failed" ? " failed" : ""}`;
  $("barFill").style.width = `${Math.min(100, progressPercent(job, p))}%`;

  const stats = [];
  if (p.searchesTotal) {
    stats.push(`Searches <strong>${p.searchesDone}/${p.searchesTotal}</strong>`);
  }
  if (p.businessesFound) stats.push(`<strong>${p.businessesFound}</strong> businesses found`);
  if (p.auditTotal) stats.push(`Websites checked <strong>${p.auditDone}/${p.auditTotal}</strong>`);

  const start = job.startedAt ? Date.parse(job.startedAt) : null;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  if (start) stats.push(`${running ? "Elapsed" : "Took"} <strong>${formatDuration(end - start)}</strong>`);

  if (job.status === "scraping" && start && p.searchesTotal) {
    if (p.searchesDone > 0 && p.searchesDone < p.searchesTotal) {
      const perSearch = (Date.now() - start) / p.searchesDone;
      const left = perSearch * (p.searchesTotal - p.searchesDone);
      stats.push(`≈ <strong>${Math.max(1, Math.round(left / 60000))} min</strong> left`);
    } else if (p.searchesDone >= p.searchesTotal) {
      stats.push("Finishing business details…");
    } else {
      stats.push("Opening Google Maps…");
    }
  }
  if (job.status === "completed") stats.push(`<strong>${job.leadCount ?? 0}</strong> leads`);
  if (job.status === "failed" && job.error) stats.push(escapeHtml(job.error));

  $("progressStats").innerHTML = stats.map((s) => `<span>${s}</span>`).join("");
}

function renderLog(lines) {
  const log = $("log");
  log.innerHTML = lines
    .slice(-80)
    .map((entry) => `<div class="log-line">${escapeHtml(entry.line)}</div>`)
    .join("");
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Only http(s) links from scraped data may become clickable. */
function safeUrl(value) {
  const url = String(value || "").trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(url)) return `https://${url}`;
  return "";
}

async function startScrape() {
  const location = $("city").value.trim();
  if (!location) {
    $("city").focus();
    return;
  }

  const categories = getAllCategories();

  $("startBtn").disabled = true;
  $("progressPanel").hidden = false;
  $("resultsPanel").hidden = true;
  $("stats").hidden = true;
  $("scanCity").textContent = location;
  setJobStatus("starting");
  renderProgress({ status: "queued", auditSites: $("auditSites").checked, progress: {} });
  $("log").innerHTML = "";

  const { res, data } = await api("/api/scrape", {
    method: "POST",
    body: JSON.stringify({
      location,
      categories,
      suburbs: getSuburbs(),
      depth: Number($("depth").value),
      auditSites: $("auditSites").checked,
    }),
  });

  if (!res.ok) {
    setJobStatus("failed");
    renderLog([{ line: data.error || "Could not start scan." }]);
    $("startBtn").disabled = false;
    return;
  }

  openJob(data.job.id);
  refreshRecent();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollJob, 2000);
  pollJob();
}

async function pollJob() {
  if (!currentJobId || polling) return;
  polling = true;
  try {
    await pollJobOnce();
  } finally {
    polling = false;
  }
}

async function pollJobOnce() {
  const jobId = currentJobId;
  const { res, data } = await api(`/api/jobs/${jobId}`);
  if (res.status === 401) {
    showLogin();
    return;
  }
  if (res.status === 404 && jobId === currentJobId) {
    // The scan no longer exists: stop polling instead of retrying forever.
    clearInterval(pollTimer);
    pollTimer = null;
    currentJobId = null;
    $("progressPanel").hidden = true;
    $("startBtn").disabled = false;
    return;
  }
  if (!res.ok || jobId !== currentJobId) return;

  const job = data.job;
  const running = !["completed", "failed"].includes(job.status);
  $("startBtn").disabled = running;
  $("stopBtn").hidden = job.status !== "scraping";
  $("stopBtn").disabled = Boolean(job.stopRequested);
  $("progressPanel").hidden = false;
  $("scanCity").textContent = job.location || "";
  setJobStatus(job.status);
  renderProgress(job);
  renderLog(job.log || []);

  if (!running) {
    clearInterval(pollTimer);
    pollTimer = null;
    refreshRecent();
  }
  if (job.status === "completed" && leadsShownFor !== jobId) {
    leadsShownFor = jobId;
    $("resultCity").textContent = job.location;
    await loadLeads(jobId);
    await loadMarket(jobId);
  }
}

async function loadLeads(jobId) {
  const { res, data } = await api(`/api/leads/${jobId}`);
  if (!res.ok) return;

  const leads = data.leads || [];
  const summary = data.summary;

  $("resultsPanel").hidden = false;
  $("stats").hidden = false;

  const statusOf = (lead) => lead.status || "NO_WEBSITE";
  const countStatus = (...statuses) =>
    leads.filter((lead) => statuses.includes(statusOf(lead))).length;

  $("statLeads").textContent = leads.length;
  $("statNoSite").textContent = countStatus("NO_WEBSITE", "SOCIAL_ONLY");
  $("statWeakSite").textContent = countStatus("FREE_SUBDOMAIN", "OUTDATED_SITE");
  $("statPhone").textContent = summary?.contactBreakdown?.phone ?? countField(leads, "phone");
  $("statEmail").textContent = summary?.contactBreakdown?.email ?? countField(leads, "email");

  const body = $("leadsBody");
  if (leads.length === 0) {
    body.innerHTML =
      '<tr><td colspan="7" class="empty">No leads with contact info found for this city.</td></tr>';
    return;
  }

  body.innerHTML = leads
    .map(
      (lead) => `
      <tr>
        <td data-label="Lead"><div>
          <span class="lead-badge ${escapeHtml(statusOf(lead).toLowerCase())}">${escapeHtml(
            LEAD_LABELS[statusOf(lead)] || statusOf(lead)
          )}${lead.score ? ` · ${escapeHtml(lead.score)}` : ""}</span>
          ${lead.reasons ? `<span class="lead-reasons">${escapeHtml(lead.reasons)}</span>` : ""}
        </div></td>
        <td data-label="Business"><div>${
          photoUrl(lead.thumbnail)
            ? `<img class="thumb" src="${escapeHtml(photoUrl(lead.thumbnail))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
            : ""
        }<strong>${
          safeUrl(lead.google_maps_link)
            ? `<a href="${escapeHtml(safeUrl(lead.google_maps_link))}" target="_blank" rel="noopener">${escapeHtml(
                lead.business_name || "—"
              )}</a>`
            : escapeHtml(lead.business_name || "—")
        }</strong>${
          safeUrl(lead.website)
            ? `<span class="lead-reasons"><a href="${escapeHtml(safeUrl(lead.website))}" target="_blank" rel="noopener">${escapeHtml(
                lead.website
              )}</a></span>`
            : ""
        }</div></td>
        <td data-label="Location"><div>${escapeHtml(lead.location || lead.address || "—")}</div></td>
        <td data-label="Phone"><div>${
          telLink(lead.phone)
            ? `<a href="${escapeHtml(telLink(lead.phone))}">${escapeHtml(lead.phone)}</a>`
            : escapeHtml(lead.phone || "—")
        }</div></td>
        <td data-label="Email"><div>${
          lead.email
            ? `<a href="mailto:${escapeHtml(lead.email.split(";")[0].trim())}">${escapeHtml(lead.email)}</a>`
            : "—"
        }</div></td>
        <td data-label="WhatsApp"><div>${
          safeUrl(lead.whatsapp)
            ? `<a href="${escapeHtml(safeUrl(lead.whatsapp))}" target="_blank" rel="noopener">WhatsApp</a>`
            : "—"
        }</div></td>
        <td data-label="Category"><div>${escapeHtml(lead.category || "—")}</div></td>
      </tr>`
    )
    .join("");

  const slug = String($("resultCity").textContent || "scan").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  $("downloadBtn").onclick = () => downloadFile(`/api/download/${jobId}`, `leads-${slug}.csv`);
  $("pdfBtn").onclick = async () => {
    const btn = $("pdfBtn");
    btn.disabled = true;
    btn.textContent = "Preparing PDF…";
    try {
      await downloadFile(`/api/report/${jobId}/pdf`, `leads-${slug}.pdf`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Download PDF";
    }
  };
}

// ---------------------------------------------------------------- Market gaps

function pctCell(value) {
  return value === null || value === undefined ? "—" : `${value}%`;
}

async function loadMarket(jobId) {
  const { res, data } = await api(`/api/market/${jobId}`);
  if (!res.ok || !data.categories?.length) {
    $("marketPanel").hidden = true;
    return;
  }
  $("marketPanel").hidden = false;
  $("marketBody").innerHTML = data.categories
    .map((cat) => {
      const rows = cat.areas
        .map(
          (a) => `<tr>
            <td data-label="Area"><div><strong>${escapeHtml(a.area)}</strong></div></td>
            <td data-label="Competitors"><div>${a.competitors} <span class="muted-inline">(${a.strong} strong)</span></div></td>
            <td data-label="Avg rating"><div>${a.avgRating ?? "—"}</div></td>
            <td data-label="Reviews"><div>${a.totalReviews}</div></td>
            <td data-label="No website"><div>${pctCell(a.pctNoWebsite)}</div></td>
            <td data-label="Open Sun"><div>${pctCell(a.pctOpenSunday)}</div></td>
            <td data-label="Open late"><div>${pctCell(a.pctOpenLate)}</div></td>
            <td data-label="Score"><div><strong>${a.opportunity}</strong></div></td>
            <td data-label="Angle"><div class="angle">${escapeHtml(a.angle)}</div></td>
          </tr>`
        )
        .join("");
      const complaints = cat.complaints?.themes?.length
        ? `<div class="complaints">
            <span class="muted-inline">Customers complain about (${cat.complaints.sample} low-star reviews):</span>
            ${cat.complaints.themes
              .map(
                (t) =>
                  `<span class="complaint" title="${escapeHtml(t.examples.join("  |  "))}">${escapeHtml(
                    t.theme
                  )} · ${t.share}%</span>`
              )
              .join("")}
          </div>`
        : "";
      return `<h3 class="sub-head">${escapeHtml(cat.category)}</h3>
        <div class="table-wrap"><table class="market-table">
          <thead><tr><th>Area</th><th>Competitors</th><th>Avg ★</th><th>Reviews</th><th>No website</th>
          <th>Open Sun</th><th>Open late</th><th>Score</th><th>Angle</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>${complaints}`;
    })
    .join("");
  $("marketDownloadBtn").onclick = () => downloadFile(`/api/market/${jobId}/csv`, `market-${jobId}.csv`);
}

async function downloadFile(url, filename) {
  try {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Download failed. Please try again.");
      return;
    }
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } catch {
    alert("Download failed: can't reach the server.");
  }
}

/** Business photo from Google's image CDN (the only source scraped data may load from). */
function photoUrl(value) {
  const url = safeUrl(value);
  try {
    return url && /(^|\.)(googleusercontent\.com|ggpht\.com)$/i.test(new URL(url).hostname) ? url : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- Trends

let trendId = null;
let trendTimer = null;

function showView(viewId) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === viewId);
  }
  $("leadsView").hidden = viewId !== "leadsView";
  $("trendsView").hidden = viewId !== "trendsView";
  try {
    localStorage.setItem("webscrape_view", viewId);
  } catch {
    /* ignore */
  }
  if (viewId === "trendsView") loadTrendsHome();
}

async function loadTrendsHome() {
  const { res, data } = await api("/api/trends");
  if (!res.ok) return;
  $("trendBtn").disabled = !data.available || Boolean(data.active);
  if (data.available === false) {
    $("trendStatus").textContent =
      "Trends isn't installed on this server yet. It installs automatically with the next update.";
  }
  renderTrendRecent(data.trends || []);
  const openId = data.active || trendId || data.trends?.[0]?.id;
  if (openId) openTrend(openId);
}

function renderTrendRecent(trends) {
  $("trendRecentPanel").hidden = trends.length === 0;
  $("trendRecentList").innerHTML = trends
    .map(
      (t) => `<li><button type="button" class="recent-item" data-trend="${escapeHtml(t.id)}">
        <span><strong>${escapeHtml(t.terms.slice(0, 4).join(", "))}${t.terms.length > 4 ? "…" : ""}</strong></span>
        <span class="recent-meta">${escapeHtml(new Date(t.createdAt).toLocaleString())} ·
          <span class="badge ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></span>
      </button></li>`
    )
    .join("");
}

function openTrend(id) {
  trendId = id;
  clearInterval(trendTimer);
  trendTimer = setInterval(pollTrend, 3000);
  pollTrend();
}

async function pollTrend() {
  if (!trendId) return;
  const { res, data } = await api(`/api/trends/${trendId}`);
  if (res.status === 404) {
    clearInterval(trendTimer);
    trendId = null;
    return;
  }
  if (!res.ok) return;
  const t = data.trend;
  const running = t.status === "queued" || t.status === "running";
  $("trendBtn").disabled = running;
  if (running) {
    const last = t.log?.[t.log.length - 1] || "Asking Google Trends…";
    $("trendStatus").textContent = `Working… ${last.replace(/^\[.\]\s*/, "")}`;
  } else if (t.status === "failed") {
    $("trendStatus").textContent = `Failed: ${t.error || "unknown error"}`;
  } else {
    $("trendStatus").textContent = "";
  }
  if (!running) {
    clearInterval(trendTimer);
    if (t.status === "completed") renderTrend(t);
  }
}

function sparkline(values) {
  if (!values?.length) return "";
  const w = 120;
  const h = 28;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${points.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
}

function renderTrend(t) {
  const r = t.result;
  if (!r?.summary?.length) return;
  $("trendResults").hidden = false;
  const period = { "today 3-m": "3 months", "today 12-m": "12 months", "today 5-y": "5 years" }[t.timeframe];
  $("trendMeta").textContent = `· South Africa · last ${period || t.timeframe}`;
  $("trendBody").innerHTML = r.summary
    .map((row) => {
      const dir = String(row.direction || "").toLowerCase();
      const regions = (r.topRegions?.[row.term] || []).map((x) => x.region).join(", ") || "—";
      const momentum = row.momentumPct === null ? "—" : `${row.momentumPct > 0 ? "+" : ""}${row.momentumPct}%`;
      return `<tr>
        <td data-label="Term"><div><strong>${escapeHtml(row.term)}</strong></div></td>
        <td data-label="Direction"><div><span class="trend-badge ${escapeHtml(dir)}">${escapeHtml(
          row.direction || "—"
        )}</span></div></td>
        <td data-label="Momentum"><div>${escapeHtml(momentum)}</div></td>
        <td data-label="Trend"><div class="spark-wrap ${escapeHtml(dir)}">${sparkline(r.series?.[row.term])}</div></td>
        <td data-label="Peak month"><div>${escapeHtml(row.peakMonth || "—")}</div></td>
        <td data-label="Low month"><div>${escapeHtml(row.lowMonth || "—")}</div></td>
        <td data-label="Top areas"><div>${escapeHtml(regions)}</div></td>
      </tr>`;
    })
    .join("");
  $("risingList").innerHTML = r.rising?.length
    ? r.rising
        .map(
          (x) =>
            `<li><strong>${escapeHtml(x.query)}</strong> <span class="muted-inline">(${escapeHtml(
              x.term
            )}, ${escapeHtml(String(x.growth))}${/^\d+$/.test(String(x.growth)) ? "%" : ""})</span></li>`
        )
        .join("")
    : '<li class="muted-inline">No breakout searches for these terms.</li>';
}

async function startTrend() {
  const terms = $("trendTerms").value;
  $("trendBtn").disabled = true;
  $("trendStatus").textContent = "Starting…";
  const { res, data } = await api("/api/trends", {
    method: "POST",
    body: JSON.stringify({
      terms,
      timeframe: $("trendTimeframe").value,
      resolution: $("trendResolution").value,
    }),
  });
  if (!res.ok) {
    $("trendStatus").textContent = data.error || "Could not start.";
    $("trendBtn").disabled = false;
    return;
  }
  $("trendResults").hidden = true;
  openTrend(data.trend.id);
  const list = await api("/api/trends");
  if (list.res.ok) renderTrendRecent(list.data.trends || []);
}

function telLink(phone) {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 9 ? `tel:${digits}` : "";
}

function countField(leads, field) {
  return leads.filter((lead) => String(lead[field] || "").trim()).length;
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("loginPassword").value;
  const { res, data } = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });

  if (!res.ok) {
    $("loginError").hidden = false;
    $("loginError").textContent = data.error || "Login failed.";
    return;
  }

  if (data.token) {
    authToken = data.token;
    writeToken(authToken);
  }

  $("loginError").hidden = true;
  await init();
});

$("city").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startScrape();
});

renderChips();
updateQueryCount();
$("customCategories").addEventListener("input", updateQueryCount);
$("suburbs").addEventListener("input", updateQueryCount);
$("startBtn").addEventListener("click", startScrape);
$("trendBtn").addEventListener("click", startTrend);
$("stopBtn").addEventListener("click", async () => {
  if (!currentJobId || !confirm("Stop this scan? Businesses found so far are kept.")) return;
  $("stopBtn").disabled = true;
  const { res, data } = await api(`/api/scrape/${currentJobId}/stop`, { method: "POST" });
  if (!res.ok) {
    alert(data.error || "Could not stop the scan.");
    $("stopBtn").disabled = false;
  }
  pollJob();
});
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => showView(tab.dataset.view));
}
$("trendRecentList").addEventListener("click", (e) => {
  const item = e.target.closest("[data-trend]");
  if (item) openTrend(item.dataset.trend);
});
$("recentList").addEventListener("click", (e) => {
  const item = e.target.closest("[data-job]");
  if (!item) return;
  openJob(item.dataset.job);
  $("progressPanel").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.addEventListener("visibilitychange", catchUp);
window.addEventListener("focus", catchUp);
window.addEventListener("online", catchUp);
window.addEventListener("pageshow", (e) => {
  if (e.persisted) catchUp();
});
init();
setInterval(refreshHealth, 15000);
