import { page } from "./layout.js";

const JOB_CSS = `
.chg { display: inline-block; border-radius: 6px; padding: 1px 8px; margin: 1px 4px 1px 0; font-size: 0.82rem; overflow-wrap: anywhere; }
.chg.add { background: var(--ok-bg); } .chg.del { background: var(--danger-bg); text-decoration: line-through; }
.chg b { margin-right: 4px; }
.status-succeeded { color: var(--ok); } .status-running { color: var(--warn); } .status-failed, .status-interrupted { color: var(--danger); }`;

/** /admin/jobs: every admin job, newest first. */
export const JOBS_HTML = page({
  title: "Jobs",
  nav: "jobs",
  css: JOB_CSS,
  body: `
<h1>Jobs</h1>
<p class="sub">Run jobs from the <a href="/admin">dashboard</a>. Changes to Calibre are always a preview, then an apply of that preview.</p>
<div class="scroll"><table><thead><tr><th>#</th><th>Job</th><th>Mode</th><th>Status</th><th>By</th><th>Started</th><th>Finished</th></tr></thead><tbody id="rows"></tbody></table></div>`,
  script: `
api("/api/admin/jobs?limit=200").then((d) => {
  document.getElementById("rows").innerHTML = d.jobs.length ? d.jobs.map((j) => '<tr><td><a href="/admin/jobs/' + j.id + '">#' + j.id + "</a></td><td>" +
    '<a href="/admin/jobs/' + j.id + '">' + esc((d.kinds[j.kind] || {}).title || j.kind) + "</a></td><td>" + esc(j.mode) + '</td><td class="status-' + esc(j.status) + '">' + esc(j.status) +
    "</td><td>" + esc(j.requested_by || "") + "</td><td>" + esc(when(j.created_at)) + "</td><td>" + esc(when(j.finished_at)) + "</td></tr>").join("")
    : '<tr><td colspan="7" class="empty">No jobs yet.</td></tr>';
}).catch((e) => toast(e.message));`,
});

/** /admin/jobs/<id>: one job: what it changed (or would change), its live log, and for a preview, its apply. */
export const JOB_HTML = page({
  title: "Job",
  nav: "jobs",
  css: JOB_CSS,
  body: `
<p><a href="/admin/jobs">← Jobs</a></p>
<h1 id="title">Job</h1>
<p class="sub" id="meta"></p>
<p id="actions"></p>
<div id="items"></div>
<h2>Output</h2>
<pre id="log">Loading…</pre>`,
  script: `
const id = Number(location.pathname.split("/").pop());
let kinds = {}, canWrite = false;

async function load() {
  let j;
  try { j = await api("/api/admin/jobs/" + id); } catch (e) { document.getElementById("title").textContent = e.message; return; }
  const title = (kinds[j.kind] || {}).title || j.kind;
  document.title = "#" + j.id + " " + title + " · Corpus Admin";
  document.getElementById("title").textContent = "#" + j.id + " " + title + (j.mode === "preview" ? " — preview" : "");
  document.getElementById("meta").innerHTML = '<span class="status-' + esc(j.status) + '">' + esc(j.status) + "</span>" + (j.requested_by ? " · " + esc(j.requested_by) : "") +
    " · started " + esc(when(j.created_at)) + (j.finished_at ? " · finished " + esc(when(j.finished_at)) : "") +
    (j.preview_of ? ' · applies <a href="/admin/jobs/' + j.preview_of + '">preview #' + j.preview_of + "</a>" : "") +
    (j.params && j.params.books ? " · books " + j.params.books.map((b) => bookLink(b, b)).join(", ") : "");
  const items = j.items || [];
  const plan = j.params && j.params.plan;
  const nothing = j.status === "succeeded" && (plan ? plan.books.length === 0 : items.length === 0);
  const actions = [];
  if (j.mode === "preview" && j.status === "succeeded" && !nothing) actions.push('<button type="button" class="primary" id="apply"' + (canWrite ? "" : " disabled") + ">Apply this preview</button>");
  if (j.mode === "preview" && nothing) actions.push('<span class="note">Nothing to apply.</span>');
  if (j.mode === "apply" && items.length) actions.push('<a href="/admin/changes?job=' + j.id + '&range=all">These changes in the change log</a>');
  document.getElementById("actions").innerHTML = actions.join(" ");
  const library = (j.params && j.params.plan && j.params.plan.library) || "main";
  document.getElementById("items").innerHTML = items.length
    ? "<h2>" + num(items.length) + " book" + (items.length === 1 ? "" : "s") + (j.mode === "preview" ? " would change" : " changed") + '</h2><div class="scroll"><table><thead><tr><th>Book</th><th>Changes</th></tr></thead><tbody>' +
      items.map((it) => "<tr><td>" + bookLink(library + ":" + it.calibre_id, it.title) + '<br><span class="note">' + esc(library + ":" + it.calibre_id) + "</span></td><td>" +
        (it.added || []).map((t) => '<span class="chg add" title="' + esc(t) + '"><b>+</b>' + esc(LABELS.get(t) || t) + "</span>").join("") +
        (it.removed || []).map((t) => '<span class="chg del" title="' + esc(t) + '"><b>−</b>' + esc(LABELS.get(t) || t) + "</span>").join("") +
        (it.added_format ? '<span class="chg add"><b>+</b>' + esc(String(it.added_format).toUpperCase()) + " from " + esc(String(it.source_format).toUpperCase()) + "</span>" : "") +
        "</td></tr>").join("") + "</tbody></table></div>"
    : "";
  const log = document.getElementById("log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = j.log || (j.status === "running" ? "Waiting for output…" : "(no output)");
  if (atBottom) log.scrollTop = log.scrollHeight;
  if (j.status === "running") setTimeout(load, 1500);
}

document.getElementById("actions").addEventListener("click", async (e) => {
  if (e.target.id !== "apply") return;
  if (!confirm("Apply preview #" + id + " to Calibre? metadata.db is backed up first, and the index refreshes afterwards.")) return;
  const j = await api("/api/admin/jobs/" + id);
  try {
    const out = await post("/api/admin/jobs", { kind: j.kind, mode: "apply", preview_of: id });
    location.href = "/admin/jobs/" + out.id;
  } catch (err) { toast(err.message); }
});

Promise.all([ME, VOCAB, api("/api/admin/jobs?limit=1")]).then(([me, , list]) => { canWrite = me.can_write; kinds = list.kinds; load(); });`,
});
