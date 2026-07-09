const DEFAULT_CATEGORIES = [
  "plumbers",
  "electricians",
  "hair salons",
  "restaurants",
  "dentists",
  "accountants",
  "gyms",
  "auto repair",
];

const RANDBURG_PACK = [
  "plumbers",
  "electricians",
  "hair salons",
  "restaurants",
  "beauty salons",
  "mechanics",
];

const $ = (id) => document.getElementById(id);
const selected = new Set(["plumbers", "electricians", "hair salons"]);

let currentJobId = null;
let pollTimer = null;

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

async function checkHealth() {
  const pill = $("dockerStatus");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.docker) {
      pill.textContent = "Docker ready";
      pill.className = "status-pill ok";
      $("startBtn").disabled = false;
    } else {
      pill.textContent = "Docker not running — open Docker Desktop";
      pill.className = "status-pill bad";
      $("startBtn").disabled = true;
    }
    if (data.activeJob) {
      currentJobId = data.activeJob;
      startPolling();
    }
  } catch {
    pill.textContent = "Dashboard offline";
    pill.className = "status-pill bad";
    $("startBtn").disabled = true;
  }
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
    .replaceAll(">", "&gt;");
}

async function startScrape() {
  const location = $("location").value.trim() || "Randburg";
  const categories = getAllCategories();

  $("startBtn").disabled = true;
  $("progressPanel").hidden = false;
  $("resultsPanel").hidden = true;
  $("stats").hidden = true;
  setJobStatus("starting");
  $("log").innerHTML = "";

  const res = await fetch("/api/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location, categories }),
  });

  const data = await res.json();
  if (!res.ok) {
    setJobStatus("failed");
    renderLog([{ line: data.error || "Could not start scrape." }]);
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

  const res = await fetch(`/api/jobs/${currentJobId}`);
  const data = await res.json();
  const job = data.job;

  $("progressPanel").hidden = false;
  setJobStatus(job.status);
  renderLog(job.log || []);

  if (job.status === "completed") {
    clearInterval(pollTimer);
    $("startBtn").disabled = false;
    await loadLeads(currentJobId);
  }

  if (job.status === "failed") {
    clearInterval(pollTimer);
    $("startBtn").disabled = false;
  }
}

async function loadLeads(jobId) {
  const res = await fetch(`/api/leads/${jobId}`);
  const data = await res.json();
  const leads = data.leads || [];
  const summary = data.summary;

  $("resultsPanel").hidden = false;
  $("stats").hidden = false;

  $("statLeads").textContent = summary?.noWebsiteWithContact ?? leads.length;
  $("statPhone").textContent = summary?.contactBreakdown?.phone ?? countField(leads, "phone");
  $("statEmail").textContent = summary?.contactBreakdown?.email ?? countField(leads, "email");
  $("statWhatsapp").textContent =
    summary?.contactBreakdown?.whatsapp ?? countField(leads, "whatsapp");

  const body = $("leadsBody");
  if (leads.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No leads with contact info found for this run.</td></tr>`;
    return;
  }

  body.innerHTML = leads
    .map(
      (lead) => `
      <tr>
        <td><strong>${escapeHtml(lead.business_name || "—")}</strong></td>
        <td>${escapeHtml(lead.location || lead.address || "—")}</td>
        <td>${escapeHtml(lead.phone || "—")}</td>
        <td>${escapeHtml(lead.email || "—")}</td>
        <td>${
          lead.whatsapp
            ? `<a href="${escapeHtml(lead.whatsapp)}" target="_blank" rel="noopener">Open</a>`
            : "—"
        }</td>
        <td>${escapeHtml(lead.category || "—")}</td>
      </tr>`
    )
    .join("");

  $("downloadBtn").onclick = () => {
    window.location.href = `/api/download/${jobId}`;
  };
}

function countField(leads, field) {
  return leads.filter((lead) => String(lead[field] || "").trim()).length;
}

function quickRandburg() {
  $("location").value = "Randburg";
  selected.clear();
  for (const cat of RANDBURG_PACK) selected.add(cat);
  renderChips();
}

renderChips();
$("startBtn").addEventListener("click", startScrape);
$("randburgBtn").addEventListener("click", quickRandburg);
checkHealth();
setInterval(checkHealth, 15000);
