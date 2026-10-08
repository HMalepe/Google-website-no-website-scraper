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

  // Reopen the running scan, or the latest one, so a reload never loses results.
  const resumeId = data.activeJob || currentJobId || jobs[0]?.id;
  if (resumeId) openJob(resumeId);
}

function openJob(id) {
  currentJobId = id;
  leadsShownFor = null;
  $("resultsPanel").hidden = true;
  $("stats").hidden = true;
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
    pill.textContent = "Online";
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
  if (!res.ok || jobId !== currentJobId) return;

  const job = data.job;
  const running = !["completed", "failed"].includes(job.status);
  $("startBtn").disabled = running;
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
        <td data-label="Business"><div><strong>${
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

  $("downloadBtn").onclick = () => {
    const url = `/api/download/${jobId}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    if (authToken) {
      fetch(url, { headers: authHeaders() })
        .then((r) => r.blob())
        .then((blob) => {
          a.href = URL.createObjectURL(blob);
          a.click();
        });
    } else {
      a.click();
    }
  };
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
