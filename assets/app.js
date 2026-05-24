/* ──────────────────────────────────────────────
   watchtower — frontend logic
   ────────────────────────────────────────────── */

const STORAGE_KEY = "watchtower:v1";
const KEY_LLM = "watchtower:llm_key";

const State = {
  jobs: [],
  resume: null,
  config: null,
  meta: { last_updated_ist: null },
  statusMap: {},      // job_id -> { status, appliedAt, notes, resumeVersion }
  trashedIds: new Set(),
  currentTab: "new",
  search: "",
  sortBy: "alignment-desc",
  sourceFilter: "",
};

// ──────────────────────────────────────────────
// PERSISTENCE
// ──────────────────────────────────────────────
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      State.statusMap = data.statusMap || {};
      State.trashedIds = new Set(data.trashedIds || []);
    }
  } catch (e) { console.warn("localStorage load failed", e); }
}

function saveLocal() {
  const data = {
    statusMap: State.statusMap,
    trashedIds: Array.from(State.trashedIds),
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ──────────────────────────────────────────────
// DATA LOAD
// ──────────────────────────────────────────────
async function loadData() {
  try {
    const [jobsRes, resumeRes, configRes, trashRes] = await Promise.all([
      fetch("data/jobs.json?cb=" + Date.now()),
      fetch("data/resume.json?cb=" + Date.now()),
      fetch("data/config.json?cb=" + Date.now()),
      fetch("data/trash.json?cb=" + Date.now()),
    ]);
    const jobsData = await jobsRes.json();
    State.jobs = jobsData.jobs || [];
    State.meta.last_updated_ist = jobsData.last_updated_ist;
    State.resume = await resumeRes.json();
    State.config = await configRes.json();
    const trash = await trashRes.json();
    // Merge repo-trash + local-trash
    (trash.trashed_ids || []).forEach(id => State.trashedIds.add(id));
  } catch (e) {
    console.error("load error", e);
    toast("could not load data — is jobs.json present?");
  }
}

// ──────────────────────────────────────────────
// RESUME SCORING (LOCAL — no LLM needed)
// ──────────────────────────────────────────────
function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9 +#&./-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1);
}

const STOP = new Set(["the","a","an","and","or","but","in","on","at","to","for","of","with","by","from","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","can","this","that","these","those","you","your","we","our","they","their","i","my","it","its","as","if","then","than","so","up","down","out","over","about","into","through","such","also","very","more","most","other","some","any","all","each","both","there","here","when","where","what","which","who","whom"]);

function computeAlignment(job, resume) {
  const jdText = (job.title + " " + (job.description || "")).toLowerCase();
  const jdTokens = tokenize(jdText).filter(w => !STOP.has(w));
  const jdTokenSet = new Set(jdTokens);

  // Build resume keyword set from structured fields + flat list + full text
  const resumeBag = [];
  resumeBag.push(...(resume.keywords_flat || []));
  if (resume.skills) {
    Object.values(resume.skills).flat().forEach(s => resumeBag.push(s));
  }
  resumeBag.push(...tokenize(resume.resume_full_text || ""));
  const resumeTokens = resumeBag.map(s => s.toString().toLowerCase());
  const resumeTokenSet = new Set();
  resumeTokens.forEach(s => tokenize(s).filter(w => !STOP.has(w)).forEach(t => resumeTokenSet.add(t)));

  // Keyword hits
  const matched = [];
  const matchedScored = new Map();  // token -> hit count in JD
  for (const t of resumeTokenSet) {
    let count = 0;
    // count occurrences in JD text
    const re = new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
    const matches = jdText.match(re);
    if (matches) count = matches.length;
    if (count > 0) {
      matched.push(t);
      matchedScored.set(t, count);
    }
  }

  // What the JD asks for that the resume doesn't have (top missing terms)
  const jdFreq = {};
  jdTokens.forEach(t => { jdFreq[t] = (jdFreq[t] || 0) + 1; });
  const missing = Object.entries(jdFreq)
    .filter(([t, c]) => c >= 2 && !resumeTokenSet.has(t) && t.length > 2)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 15);

  // Score: weighted by JD-frequency of matched terms / total weighted JD terms
  let matchedWeight = 0;
  for (const [t, c] of matchedScored) matchedWeight += c;
  let totalWeight = 0;
  Object.values(jdFreq).forEach(c => totalWeight += c);

  // Base coverage = how much of JD is covered by resume terms
  const baseCoverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;

  // Bonus for matching high-signal tech terms
  const highSignalTerms = ["sentinel","defender","mde","kql","mitre","att&ck","soc","siem","xdr","edr","entra","azure ad","incident response","threat intel","malware","ghidra","stix","taxii","phishing","cdsa","zscaler","iam","detection engineering"];
  let highSignalHits = 0;
  highSignalTerms.forEach(term => {
    if (jdText.includes(term) && (resume.resume_full_text || "").toLowerCase().includes(term)) {
      highSignalHits++;
    }
  });
  const highSignalBonus = Math.min(0.25, highSignalHits * 0.025);

  // JD experience requirement detection (very rough)
  let expPenalty = 0;
  const expMatch = jdText.match(/(\d+)\+?\s*(?:years?|yrs?)/);
  if (expMatch) {
    const required = parseInt(expMatch[1], 10);
    const have = resume.experience_years || 0;
    if (required > have) {
      expPenalty = Math.min(0.25, (required - have) * 0.05);
    }
  }

  // Senior/lead/manager penalty for junior profile
  let levelPenalty = 0;
  const seniorPattern = /\b(senior|sr\.?|lead|principal|staff|director|head of|manager)\b/i;
  if (seniorPattern.test(job.title) && (resume.experience_years || 0) < 4) {
    levelPenalty = 0.15;
  }

  // Final scores
  let alignment = Math.round((baseCoverage * 100 + highSignalBonus * 100));
  alignment = Math.max(0, Math.min(99, alignment));

  let competitiveness = Math.round(alignment - (expPenalty * 100) - (levelPenalty * 100));
  competitiveness = Math.max(0, Math.min(99, competitiveness));

  return {
    alignment,
    competitiveness,
    matched: matched.sort(),
    missing,
    notes: {
      experienceGap: expMatch ? { required: parseInt(expMatch[1], 10), have: resume.experience_years } : null,
      seniorTitle: seniorPattern.test(job.title),
      highSignalHits,
    },
  };
}

function scoreAllJobs() {
  if (!State.resume) return;
  for (const job of State.jobs) {
    if (!job._score) job._score = computeAlignment(job, State.resume);
  }
}

// ──────────────────────────────────────────────
// STATUS HELPERS
// ──────────────────────────────────────────────
function getStatus(jobId) {
  return State.statusMap[jobId]?.status || "new";
}

function setStatus(jobId, status, extra = {}) {
  if (status === "trash") {
    State.trashedIds.add(jobId);
    delete State.statusMap[jobId];
  } else {
    State.statusMap[jobId] = {
      ...State.statusMap[jobId],
      status,
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    if (status === "applied" && !State.statusMap[jobId].appliedAt) {
      State.statusMap[jobId].appliedAt = new Date().toISOString();
    }
  }
  saveLocal();
  render();
}

function visibleJobs() {
  // Drop trashed
  let list = State.jobs.filter(j => !State.trashedIds.has(j.id));

  // Tab filter
  list = list.filter(j => {
    const s = getStatus(j.id);
    if (State.currentTab === "new") return s === "new";
    if (State.currentTab === "saved") return s === "saved";
    if (State.currentTab === "applied") return s === "applied";
    if (State.currentTab === "interview") return s === "interview";
    if (State.currentTab === "closed") return s === "rejected" || s === "offer" || s === "ghosted";
    return true;
  });

  // Search
  if (State.search) {
    const q = State.search.toLowerCase();
    list = list.filter(j =>
      (j.title || "").toLowerCase().includes(q) ||
      (j.company || "").toLowerCase().includes(q) ||
      (j.description || "").toLowerCase().includes(q) ||
      (j.location || "").toLowerCase().includes(q)
    );
  }

  // Source filter
  if (State.sourceFilter) {
    list = list.filter(j => (j.source || "").startsWith(State.sourceFilter));
  }

  // Sort
  if (State.sortBy === "alignment-desc") {
    list.sort((a, b) => (b._score?.alignment || 0) - (a._score?.alignment || 0));
  } else if (State.sortBy === "date-desc") {
    list.sort((a, b) => (b.fetched_at || "").localeCompare(a.fetched_at || ""));
  } else if (State.sortBy === "company-asc") {
    list.sort((a, b) => (a.company || "").localeCompare(b.company || ""));
  }

  return list;
}

// ──────────────────────────────────────────────
// RENDER
// ──────────────────────────────────────────────
function escapeHtml(s) {
  return (s || "").toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scoreClass(n) {
  if (n >= 75) return "high";
  if (n >= 50) return "mid";
  return "low";
}

function shortSource(s) {
  return (s || "").split(":")[0];
}

function renderJobCard(job) {
  const s = job._score || { alignment: 0, competitiveness: 0 };
  const status = getStatus(job.id);
  const snippet = (job.description || "").substring(0, 220).replace(/\s+/g, " ");
  const isNew = status === "new";

  return `
    <article class="job-card ${isNew ? 'new' : ''}" data-id="${job.id}">
      <div class="jc-head">
        <div class="jc-title-block">
          <div class="jc-title">${escapeHtml(job.title)}</div>
          <div class="jc-company">${escapeHtml(job.company)}</div>
        </div>
        <div class="jc-score">
          <div class="jc-score-num ${scoreClass(s.alignment)}">${s.alignment}</div>
          <div class="jc-score-label">fit</div>
        </div>
      </div>
      <div class="jc-meta">
        <span>📍 ${escapeHtml(job.location || "—")}</span>
        <span class="dot"></span>
        <span>${escapeHtml(shortSource(job.source))}</span>
        ${job.fetched_at ? `<span class="dot"></span><span>${escapeHtml((job.fetched_at || "").substring(0, 10))}</span>` : ""}
      </div>
      <div class="jc-snippet">${escapeHtml(snippet)}…</div>
      <div class="jc-actions">
        <button class="jc-btn primary" data-action="open" data-id="${job.id}">view</button>
        ${status === "new" ? `
          <button class="jc-btn" data-action="save" data-id="${job.id}">save</button>
          <button class="jc-btn" data-action="apply" data-id="${job.id}">applied</button>
          <button class="jc-btn danger" data-action="trash" data-id="${job.id}">trash</button>
        ` : ""}
        ${status === "saved" ? `
          <button class="jc-btn" data-action="apply" data-id="${job.id}">applied</button>
          <button class="jc-btn" data-action="new" data-id="${job.id}">move back</button>
          <button class="jc-btn danger" data-action="trash" data-id="${job.id}">trash</button>
        ` : ""}
        ${status === "applied" ? `
          <button class="jc-btn" data-action="interview" data-id="${job.id}">got interview</button>
          <button class="jc-btn" data-action="rejected" data-id="${job.id}">rejected</button>
          <button class="jc-btn" data-action="ghosted" data-id="${job.id}">ghosted</button>
        ` : ""}
        ${status === "interview" ? `
          <button class="jc-btn" data-action="offer" data-id="${job.id}">offer</button>
          <button class="jc-btn" data-action="rejected" data-id="${job.id}">rejected</button>
        ` : ""}
      </div>
    </article>
  `;
}

function updateCounts() {
  const counts = { new: 0, saved: 0, applied: 0, interview: 0, closed: 0 };
  for (const j of State.jobs) {
    if (State.trashedIds.has(j.id)) continue;
    const s = getStatus(j.id);
    if (s === "new") counts.new++;
    else if (s === "saved") counts.saved++;
    else if (s === "applied") counts.applied++;
    else if (s === "interview") counts.interview++;
    else if (["rejected","offer","ghosted"].includes(s)) counts.closed++;
  }
  for (const tab of Object.keys(counts)) {
    const el = document.getElementById("count-" + tab);
    if (el) el.textContent = counts[tab];
  }
}

function render() {
  const list = visibleJobs();
  const main = document.getElementById("job-list");
  const empty = document.getElementById("empty-state");

  if (list.length === 0) {
    main.innerHTML = "";
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
    main.innerHTML = list.map(renderJobCard).join("");
  }

  updateCounts();
  document.getElementById("last-updated").textContent =
    State.meta.last_updated_ist ? "updated " + State.meta.last_updated_ist : "not yet fetched";
}

// ──────────────────────────────────────────────
// SOURCE FILTER POPULATION
// ──────────────────────────────────────────────
function populateSourceFilter() {
  const sources = new Set();
  State.jobs.forEach(j => {
    if (j.source) sources.add(j.source.split(":")[0]);
  });
  const sel = document.getElementById("filter-source");
  Array.from(sources).sort().forEach(s => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

// ──────────────────────────────────────────────
// MODAL — JOB DETAIL
// ──────────────────────────────────────────────
function openJobModal(jobId) {
  const job = State.jobs.find(j => j.id === jobId);
  if (!job) return;
  const s = job._score;
  const content = document.getElementById("modal-content");

  const expNote = s.notes.experienceGap
    ? `<li>JD asks for <strong>${s.notes.experienceGap.required}+ years</strong>; resume shows ~${s.notes.experienceGap.have}. Either skip, or lead with the strongest projects/cert work you have.</li>`
    : "";
  const seniorNote = s.notes.seniorTitle
    ? `<li>Title contains senior/lead/principal — usually means 4+ years. Apply if you have a stretch story, otherwise prioritise IC-level postings.</li>`
    : "";

  content.innerHTML = `
    <h2>${escapeHtml(job.title)}</h2>
    <div class="modal-detail-meta">
      <span>${escapeHtml(job.company)}</span>
      <span>📍 ${escapeHtml(job.location || "—")}</span>
      <span>via ${escapeHtml(shortSource(job.source))}</span>
    </div>

    <div class="modal-score-block">
      <div class="modal-score-row">
        <div class="modal-score-big ${scoreClass(s.alignment)}">${s.alignment}</div>
        <div class="modal-score-meta">
          <div class="label">JD alignment</div>
          <div class="desc">how much of what this JD asks for your resume documents</div>
        </div>
      </div>
      <div class="modal-score-row">
        <div class="modal-score-big ${scoreClass(s.competitiveness)}">${s.competitiveness}</div>
        <div class="modal-score-meta">
          <div class="label">competitiveness</div>
          <div class="desc">alignment minus experience/level gaps. not a selection probability.</div>
        </div>
      </div>
      ${s.alignment < 80 ? `
        <div class="gap-list">
          <strong>top gaps the JD repeats but your resume doesn't</strong>
          <ul>${s.missing.slice(0, 8).map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
          ${(expNote || seniorNote) ? `<strong>flags</strong><ul>${expNote}${seniorNote}</ul>` : ""}
          <strong>matched signals</strong>
          <ul>${s.matched.filter(m => m.length > 3).slice(0, 12).map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
        </div>
      ` : `
        <div class="gap-list">
          <strong>strong match — apply</strong>
          <ul>${s.matched.filter(m => m.length > 3).slice(0, 10).map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
        </div>
      `}
    </div>

    <div class="modal-jd">${escapeHtml(job.description || "(no description)")}</div>

    <div class="modal-actions">
      <a class="btn primary" href="${escapeHtml(job.url)}" target="_blank" rel="noopener">open application →</a>
      <button class="btn" data-action="tailor" data-id="${job.id}">tailor resume (LLM)</button>
      ${getStatus(jobId) !== "applied" ? `<button class="btn" data-action="apply" data-id="${job.id}">mark applied</button>` : ""}
      ${getStatus(jobId) !== "trash" ? `<button class="btn btn-danger" data-action="trash" data-id="${job.id}">trash</button>` : ""}
    </div>
    <div id="tailor-output" style="margin-top: 16px;"></div>
  `;

  document.getElementById("modal").classList.remove("hidden");
}

function closeJobModal() {
  document.getElementById("modal").classList.add("hidden");
}

// ──────────────────────────────────────────────
// LLM TAILORING
// ──────────────────────────────────────────────
async function tailorResume(jobId) {
  const key = localStorage.getItem(KEY_LLM);
  const out = document.getElementById("tailor-output");
  if (!key) {
    out.innerHTML = `<p class="hint">add an Anthropic API key in settings to enable resume tailoring.</p>`;
    return;
  }
  const job = State.jobs.find(j => j.id === jobId);
  if (!job) return;
  out.innerHTML = `<p class="hint">tailoring… this takes ~10-15 seconds</p>`;

  const prompt = `You are helping tailor a resume for a specific job. The candidate is Bonu Swetha Devi Sai Priya, a cybersecurity analyst.

CRITICAL RULES:
- Never invent experience, skills, tools, or projects she doesn't have
- Only re-order, re-emphasize, or rephrase what is already true in her existing resume
- If a JD asks for something she genuinely lacks, do NOT add it — note it as a gap instead
- Output a complete, ready-to-paste tailored resume

HER CURRENT RESUME (truth source — do not deviate):
${JSON.stringify(State.resume, null, 2)}

JOB SHE'S TARGETING:
Title: ${job.title}
Company: ${job.company}
JD:
${job.description}

Produce:
1. A tailored resume in plain text (clean, ATS-friendly format), with the bullets and skills section re-weighted toward this JD
2. A short "honest gap analysis" section at the end listing what the JD asks for that she genuinely doesn't have (so she knows what to address in cover letter or skip)
3. Keep it to one page worth of content`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    if (data.error) {
      out.innerHTML = `<p class="hint" style="color: var(--rust)">error: ${escapeHtml(data.error.message || JSON.stringify(data.error))}</p>`;
      return;
    }
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    out.innerHTML = `
      <div class="modal-score-block">
        <strong style="font-family: var(--font-mono); color: var(--amber); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;">tailored resume</strong>
        <pre style="white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; margin-top: 10px; color: var(--ink);">${escapeHtml(text)}</pre>
        <button class="btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent); this.textContent='copied'">copy to clipboard</button>
        <button class="btn" onclick="downloadText('tailored-resume-${escapeHtml(job.company)}.txt', this.previousElementSibling.previousElementSibling.textContent)">download .txt</button>
      </div>
    `;
  } catch (e) {
    out.innerHTML = `<p class="hint" style="color: var(--rust)">request failed: ${escapeHtml(e.message)}</p>`;
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
window.downloadText = downloadText;

// ──────────────────────────────────────────────
// MANUAL ADD (also receives bookmarklet pushes via URL params)
// ──────────────────────────────────────────────
function addManualJob({ title, company, location, url, description }) {
  if (!url || (!title && !description)) {
    toast("need at least URL + (title or description)");
    return;
  }
  const id = simpleHash((company || "manual") + "|" + (title || "") + "|" + url);
  if (State.jobs.find(j => j.id === id)) {
    toast("already in board");
    return;
  }
  const job = {
    id,
    title: title || "Untitled role",
    company: company || "Unknown",
    location: location || "—",
    description: description || "",
    url,
    source: "manual",
    posted_at: "",
    fetched_at: new Date().toISOString(),
  };
  job._score = computeAlignment(job, State.resume);
  State.jobs.unshift(job);
  saveLocal();
  // Save to localStorage as a separate "manual" pool that survives jobs.json refreshes
  const manual = JSON.parse(localStorage.getItem("watchtower:manual_jobs") || "[]");
  manual.unshift(job);
  localStorage.setItem("watchtower:manual_jobs", JSON.stringify(manual.slice(0, 200)));
  toast("added");
  render();
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return "m" + Math.abs(h).toString(16);
}

function loadManualJobs() {
  try {
    const manual = JSON.parse(localStorage.getItem("watchtower:manual_jobs") || "[]");
    // Merge with State.jobs (manual ones take precedence)
    const existingIds = new Set(State.jobs.map(j => j.id));
    for (const m of manual) {
      if (!existingIds.has(m.id) && !State.trashedIds.has(m.id)) {
        State.jobs.unshift(m);
      }
    }
  } catch (e) {}
}

function handleBookmarkletPayload() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("add") === "1") {
    addManualJob({
      title: params.get("title") || "",
      company: params.get("company") || "",
      location: params.get("location") || "",
      url: params.get("url") || "",
      description: params.get("desc") || "",
    });
    // Clean URL
    window.history.replaceState({}, "", window.location.pathname);
  }
}

// ──────────────────────────────────────────────
// SETTINGS / BACKUP
// ──────────────────────────────────────────────
function exportBackup() {
  const data = {
    statusMap: State.statusMap,
    trashedIds: Array.from(State.trashedIds),
    manualJobs: JSON.parse(localStorage.getItem("watchtower:manual_jobs") || "[]"),
    exportedAt: new Date().toISOString(),
  };
  downloadText(`watchtower-backup-${new Date().toISOString().substring(0,10)}.json`, JSON.stringify(data, null, 2));
  toast("backup downloaded");
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.statusMap) State.statusMap = data.statusMap;
      if (data.trashedIds) State.trashedIds = new Set(data.trashedIds);
      if (data.manualJobs) localStorage.setItem("watchtower:manual_jobs", JSON.stringify(data.manualJobs));
      saveLocal();
      loadManualJobs();
      render();
      toast("backup restored");
    } catch (err) {
      toast("invalid backup file");
    }
  };
  reader.readAsText(file);
}

function buildBookmarklet() {
  const targetOrigin = window.location.origin + window.location.pathname;
  // The bookmarklet code, minified.
  const code = `javascript:(function(){var t=document.title,u=location.href,h=document.body.innerText.substring(0,3000),c=document.querySelector('[class*="company"], [data-company], meta[property="og:site_name"]'),cn=c?(c.content||c.textContent||"").substring(0,60).trim():"",tt=prompt("title?",t.substring(0,80))||t,cm=prompt("company?",cn)||cn,d=prompt("paste JD (or leave to use page text)",h)||h;window.open("${targetOrigin}?add=1&url="+encodeURIComponent(u)+"&title="+encodeURIComponent(tt)+"&company="+encodeURIComponent(cm)+"&desc="+encodeURIComponent(d.substring(0,4000)),"_blank")})();`;
  document.getElementById("bookmarklet-link").href = code;
  document.getElementById("bookmarklet-code").value = code;
}

function renderStats() {
  const total = State.jobs.length;
  const applied = Object.values(State.statusMap).filter(s => s.status === "applied").length;
  const interview = Object.values(State.statusMap).filter(s => s.status === "interview").length;
  const offer = Object.values(State.statusMap).filter(s => s.status === "offer").length;
  const rejected = Object.values(State.statusMap).filter(s => s.status === "rejected").length;
  const ghosted = Object.values(State.statusMap).filter(s => s.status === "ghosted").length;
  const trashed = State.trashedIds.size;

  document.getElementById("stats-display").innerHTML = `
    <div class="stat-tile"><span class="stat-num">${total}</span><span class="stat-lbl">total in board</span></div>
    <div class="stat-tile"><span class="stat-num">${applied}</span><span class="stat-lbl">applied</span></div>
    <div class="stat-tile"><span class="stat-num">${interview}</span><span class="stat-lbl">interview</span></div>
    <div class="stat-tile"><span class="stat-num">${offer}</span><span class="stat-lbl">offers</span></div>
    <div class="stat-tile"><span class="stat-num">${rejected}</span><span class="stat-lbl">rejected</span></div>
    <div class="stat-tile"><span class="stat-num">${ghosted}</span><span class="stat-lbl">ghosted</span></div>
    <div class="stat-tile"><span class="stat-num">${trashed}</span><span class="stat-lbl">trashed</span></div>
    <div class="stat-tile"><span class="stat-num">${applied > 0 ? Math.round((interview + offer) / applied * 100) : 0}%</span><span class="stat-lbl">response rate</span></div>
  `;
}

// ──────────────────────────────────────────────
// TOAST
// ──────────────────────────────────────────────
function toast(msg) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ──────────────────────────────────────────────
// EVENT WIRING
// ──────────────────────────────────────────────
function wireUp() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    State.currentTab = btn.dataset.tab;
    render();
  });

  document.getElementById("search").addEventListener("input", (e) => {
    State.search = e.target.value;
    render();
  });

  document.getElementById("filter-source").addEventListener("change", (e) => {
    State.sourceFilter = e.target.value;
    render();
  });

  document.getElementById("sort").addEventListener("change", (e) => {
    State.sortBy = e.target.value;
    render();
  });

  document.getElementById("refresh-btn").addEventListener("click", async () => {
    const btn = document.getElementById("refresh-btn");
    btn.classList.add("spinning");
    await loadData();
    loadManualJobs();
    scoreAllJobs();
    render();
    setTimeout(() => btn.classList.remove("spinning"), 400);
    toast("reloaded");
  });

  // Job card actions
  document.getElementById("job-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "open") openJobModal(id);
    else if (action === "save") setStatus(id, "saved");
    else if (action === "apply") setStatus(id, "applied");
    else if (action === "trash") setStatus(id, "trash");
    else if (action === "new") setStatus(id, "new");
    else if (action === "interview") setStatus(id, "interview");
    else if (action === "rejected") setStatus(id, "rejected");
    else if (action === "offer") setStatus(id, "offer");
    else if (action === "ghosted") setStatus(id, "ghosted");
  });

  // Modal actions
  document.getElementById("modal-content").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "apply") { setStatus(id, "applied"); closeJobModal(); }
    else if (action === "trash") { setStatus(id, "trash"); closeJobModal(); }
    else if (action === "tailor") tailorResume(id);
  });

  document.getElementById("modal-close").addEventListener("click", closeJobModal);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeJobModal();
  });

  // Settings
  const settingsModal = document.getElementById("settings-modal");
  document.getElementById("settings-fab").addEventListener("click", () => {
    settingsModal.classList.remove("hidden");
    buildBookmarklet();
    renderStats();
    const savedKey = localStorage.getItem(KEY_LLM);
    if (savedKey) document.getElementById("llm-key").value = savedKey;
  });
  document.getElementById("settings-close").addEventListener("click", () => settingsModal.classList.add("hidden"));
  settingsModal.addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") settingsModal.classList.add("hidden");
  });

  document.getElementById("export-btn").addEventListener("click", exportBackup);
  document.getElementById("import-input").addEventListener("change", (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
  });

  document.getElementById("save-key-btn").addEventListener("click", () => {
    const k = document.getElementById("llm-key").value.trim();
    if (k) {
      localStorage.setItem(KEY_LLM, k);
      toast("key saved (local only)");
    }
  });
  document.getElementById("clear-key-btn").addEventListener("click", () => {
    localStorage.removeItem(KEY_LLM);
    document.getElementById("llm-key").value = "";
    toast("key cleared");
  });

  // Add job modal
  const addModal = document.getElementById("add-modal");
  document.getElementById("add-fab").addEventListener("click", () => addModal.classList.remove("hidden"));
  document.getElementById("add-close").addEventListener("click", () => addModal.classList.add("hidden"));
  addModal.addEventListener("click", (e) => {
    if (e.target.id === "add-modal") addModal.classList.add("hidden");
  });
  document.getElementById("add-submit").addEventListener("click", () => {
    addManualJob({
      title: document.getElementById("add-title").value.trim(),
      company: document.getElementById("add-company").value.trim(),
      location: document.getElementById("add-location").value.trim(),
      url: document.getElementById("add-url").value.trim(),
      description: document.getElementById("add-description").value.trim(),
    });
    ["add-title","add-company","add-location","add-url","add-description"].forEach(id => document.getElementById(id).value = "");
    addModal.classList.add("hidden");
  });
}

// ──────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────
async function init() {
  loadLocal();
  await loadData();
  loadManualJobs();
  scoreAllJobs();
  populateSourceFilter();
  wireUp();
  handleBookmarkletPayload();
  render();
}

init();
