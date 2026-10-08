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
let authToken = sessionStorage.getItem("webscrape_token") || "";

function authHeaders() {
  if (!authToken) return { "Content-Type": "application/json" };
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
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

async function init() {
  const { res, data } = await api("/api/health");

  if (!res.ok) {
    showLogin();
    return;
  }

  if (data.authRequired && !authToken) {
    showLogin();
    return;
  }

  if (data.authRequired && authToken) {
    const check = await api("/api/jobs");
    if (check.res.status === 401) {
      sessionStorage.removeItem("webscrape_token");
      authToken = "";
      showLogin();
      return;
    }
  }

  showApp();
  updateEngineStatus(data);
  if (data.activeJob) {
    currentJobId = data.activeJob;
    startPolling();
  }
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

function setJobStatus(status) {
  const badge = $("jobStatus");
  badge.textContent = status;
  badge.className = `badge ${status}`;
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

  currentJobId = data.job.id;
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollJob, 2000);
  pollJob();
}

async function pollJob() {
  if (!currentJobId) return;

  const { res, data } = await api(`/api/jobs/${currentJobId}`);
  if (!res.ok) return;

  const job = data.job;
  $("progressPanel").hidden = false;
  setJobStatus(job.status);
  renderLog(job.log || []);

  if (job.status === "completed") {
    clearInterval(pollTimer);
    $("startBtn").disabled = false;
    $("resultCity").textContent = job.location;
    await loadLeads(currentJobId);
  }

  if (job.status === "failed") {
    clearInterval(pollTimer);
    $("startBtn").disabled = false;
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
        <td>
          <span class="lead-badge ${escapeHtml(statusOf(lead).toLowerCase())}">${escapeHtml(
            LEAD_LABELS[statusOf(lead)] || statusOf(lead)
          )}${lead.score ? ` · ${escapeHtml(lead.score)}` : ""}</span>
          ${lead.reasons ? `<span class="lead-reasons">${escapeHtml(lead.reasons)}</span>` : ""}
        </td>
        <td><strong>${
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
        }</td>
        <td>${escapeHtml(lead.location || lead.address || "—")}</td>
        <td>${escapeHtml(lead.phone || "—")}</td>
        <td>${escapeHtml(lead.email || "—")}</td>
        <td>${
          safeUrl(lead.whatsapp)
            ? `<a href="${escapeHtml(safeUrl(lead.whatsapp))}" target="_blank" rel="noopener">Open</a>`
            : "—"
        }</td>
        <td>${escapeHtml(lead.category || "—")}</td>
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
    sessionStorage.setItem("webscrape_token", authToken);
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
init();
setInterval(refreshHealth, 15000);
