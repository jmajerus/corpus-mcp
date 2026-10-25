/** The /admin dashboard: corpus metrics, neighbouring services, refresh history, and admin jobs. Served by serveHttp. */
export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corpus Admin</title>
<style>
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --border: #dedcd6;
  --accent: #2f5d8a; --accent-text: #ffffff; --ok: #2e7d4f; --warn: #a15c07; --danger: #b3261e; --code: #f0efeb;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935;
    --accent: #7fb0e0; --accent-text: #0f1a24; --ok: #6cc290; --warn: #e0a85a; --danger: #f08a82; --code: #262624;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935;
  --accent: #7fb0e0; --accent-text: #0f1a24; --ok: #6cc290; --warn: #e0a85a; --danger: #f08a82; --code: #262624;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
h1 { font-size: 1.4rem; margin: 0; }
h2 { font-size: 1rem; margin: 28px 0 10px; }
.who { font-size: 0.88rem; color: var(--muted); }
.who.ok { color: var(--ok); }
.strip { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 4px 12px; font-size: 0.86rem; }
.pill .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--danger); }
.pill.up .dot { background: var(--ok); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.card h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 6px; font-weight: 600; }
.big { font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.rows { font-size: 0.88rem; margin-top: 6px; }
.rows div { display: flex; justify-content: space-between; gap: 8px; }
.rows span:last-child { font-variant-numeric: tabular-nums; }
.warn { color: var(--warn); } .bad { color: var(--danger); } .good { color: var(--ok); }
table { width: 100%; border-collapse: collapse; font-size: 0.86rem; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; }
.scroll { overflow-x: auto; }
.actions { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.action p { margin: 0 0 10px; font-size: 0.9rem; }
.action .buttons { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
button { border: 1px solid var(--border); border-radius: 6px; padding: 7px 14px; cursor: pointer; font: inherit; background: var(--surface); color: var(--text); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
input[type=text] { width: 100%; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 0.88rem; }
pre { background: var(--code); border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-size: 0.8rem; line-height: 1.4; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.jobhead { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 8px; font-size: 0.9rem; }
.history button { padding: 2px 8px; font-size: 0.82rem; }
dialog { width: min(920px, 94vw); max-height: 88vh; border: 1px solid var(--border); border-radius: 12px; padding: 0; background: var(--surface); color: var(--text); }
dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
.dialog-body { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; max-height: 88vh; }
.dialog-body h3 { margin: 0; font-size: 1.05rem; }
.dialog-body pre { flex: 1; min-height: 120px; max-height: 60vh; }
.dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }
.note { font-size: 0.85rem; color: var(--muted); }
</style>
</head>
<body>
<main>
  <header><h1>Corpus Admin</h1><span id="who" class="who">Checking sign-in…</span></header>
  <div id="neighbors" class="strip" aria-label="Neighbouring services"></div>

  <h2>Corpus</h2>
  <div id="cards" class="grid"></div>

  <h2>Actions</h2>
  <p id="readonly" class="note" hidden></p>
  <div id="actions" class="actions"></div>

  <h2>Recent jobs</h2>
  <div class="scroll"><table class="history"><thead><tr><th>#</th><th>Job</th><th>Mode</th><th>Status</th><th>By</th><th>Started</th><th></th></tr></thead><tbody id="jobs"></tbody></table></div>

  <h2>Refresh history</h2>
  <div class="scroll"><table><thead><tr><th>Finished</th><th>Seconds</th><th>Extracted</th><th>Unchanged</th><th>Failed</th><th>Removed</th><th>Shelves</th></tr></thead><tbody id="runs"></tbody></table></div>
</main>
<dialog id="jobdialog" aria-labelledby="jobtitle">
  <div class="dialog-body">
    <h3 id="jobtitle">Job</h3>
    <div id="jobhead" class="jobhead note"></div>
    <pre id="joblog"></pre>
    <div class="dialog-actions">
      <span id="jobnote" class="note"></span>
      <button type="button" id="jobapply" class="primary" hidden>Apply this preview</button>
      <button type="button" id="jobclose">Close</button>
    </div>
  </div>
</dialog>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString());
const bytes = (n) => { if (n === null || n === undefined) return "–"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + " " + u[i]; };
function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return s + " s ago"; if (s < 5400) return Math.round(s / 60) + " min ago"; if (s < 129600) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " days ago";
}
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "–");
const card = (title, big, rows, cls) => '<div class="card"><h3>' + esc(title) + '</h3><div class="big ' + (cls || "") + '">' + big + '</div><div class="rows">' +
  rows.map(([k, v, c]) => "<div><span>" + esc(k) + '</span><span class="' + (c || "") + '">' + v + "</span></div>").join("") + "</div></div>";

let canWrite = false, kinds = {}, current = null, lastPreview = {};

async function loadMetrics() {
  const m = await (await fetch("api/admin/metrics")).json();
  document.getElementById("neighbors").innerHTML = m.neighbors.map((n) =>
    '<span class="pill ' + (n.up ? "up" : "") + '" title="' + esc(n.url + (n.error ? " — " + n.error : "")) + '"><span class="dot"></span>' + esc(n.name) +
    (n.up ? " · " + n.ms + " ms" : " · down") + "</span>").join("") +
    '<span class="pill up" title="this server"><span class="dot"></span>corpus-mcp ' + esc(m.service.version) + "</span>";
  const indexed = m.index.counts.filter((r) => r.status === "indexed");
  const total = indexed.reduce((n, r) => n + r.books, 0);
  const run = m.index.runs[0];
  const staleScan = !m.index.last_scan || Date.now() - Date.parse(m.index.last_scan) > 30 * 60 * 1000;
  const sync = m.sync, syncOk = sync && Object.values(sync.libraries || {}).every((v) => v === "ok") && sync.shelves === "ok";
  const backupAge = m.data.backups.newest_at ? Date.now() - Date.parse(m.data.backups.newest_at) : Infinity;
  document.getElementById("cards").innerHTML = [
    card("Books indexed", num(total), indexed.map((r) => [String(r.format).toUpperCase(), num(r.books)])
      .concat([["Failed", num(m.index.failed.length), m.index.failed.length ? "bad" : ""], ["No text layer", num(m.index.little_or_no_text)], ["No outline", num(m.index.no_outline)]])),
    card("Last refresh", ago(m.index.last_scan), run ? [["Took", run.seconds.toFixed(1) + " s"], ["Extracted", num(run.extracted)], ["Failed", num(run.failed), run.failed ? "warn" : ""],
      ["Unreadable libraries", num((run.unreadable_libraries || []).length), (run.unreadable_libraries || []).length ? "bad" : ""]] : [], staleScan ? "warn" : ""),
    card("Last pull", sync ? ago(sync.finished_at) : "no status", sync ? Object.entries(sync.libraries || {}).map(([k, v]) => ["Library " + k, esc(v), v === "ok" ? "good" : "bad"])
      .concat([["Shelves", esc(sync.shelves), sync.shelves === "ok" ? "good" : "bad"]]) : [], syncOk ? "" : "warn"),
    card("Tag proposals", num(m.data.proposals.pending) + " pending", [["Approved", num(m.data.proposals.approved)],
      ["Approved, not yet in Calibre", num(m.data.proposals.approved_not_in_calibre), m.data.proposals.approved_not_in_calibre ? "warn" : ""], ["Rejected", num(m.data.proposals.rejected)]]),
    card("Tags", num(m.tags.tagged_books) + " books", [["Distinct tags", num(m.tags.distinct)], ["Used once", num(m.tags.used_once)], ["Suspect", num(m.tags.suspect), m.tags.suspect ? "warn" : ""]]),
    card("Citekeys", num(m.citekeys.pinned) + " pinned", [["Ready to file", num(m.citekeys.ready_to_file)], ["Unknown author", num(m.citekeys.blocked.unknown_author)],
      ["No year", num(m.citekeys.blocked.no_year)], ["Merged authors", num(m.citekeys.blocked.merged_authors)], ["Proposed collisions", num(m.citekeys.proposed_collisions)]]),
    card("Printed ISBNs", num(m.printed_isbns.books_printing_isbn), [["Books without a Calibre ISBN", num(m.printed_isbns.books_without_isbn)]]),
    card("Data", bytes(m.data.data_db_bytes), [["Index (corpus.db)", bytes(m.index.corpus_db_bytes)], ["Backups", num(m.data.backups.count)],
      ["Newest backup", ago(m.data.backups.newest_at), backupAge > 36 * 3600 * 1000 ? "warn" : ""]]),
    card("Disk free", m.disk.map((d) => bytes(d.free_bytes)).join(" / "), m.disk.map((d) => [d.path, bytes(d.free_bytes) + " of " + bytes(d.total_bytes),
      d.total_bytes && d.free_bytes / d.total_bytes < 0.1 ? "bad" : ""])),
    card("Shelves", num(m.shelves.length), m.shelves.map((s) => [s.name, num(s.indexed_books)])),
  ].join("");
  document.getElementById("runs").innerHTML = m.index.runs.map((r) => "<tr><td>" + esc(when(r.finished_at)) + "</td><td>" + r.seconds.toFixed(1) + "</td><td>" + num(r.extracted) +
    "</td><td>" + num(r.unchanged) + "</td><td>" + num(r.failed) + "</td><td>" + num(r.removed) + "</td><td>" + esc(r.shelves) + "</td></tr>").join("");
}

function renderActions() {
  const extra = { cleanup: '<input type="text" id="also" placeholder="Also remove these tags (comma-separated)" aria-label="Also remove these tags">' };
  const help = {
    refresh: "Pull from Calibre-Web and update the index now, instead of waiting for the 10-minute timer.",
    backup: "Copy data.db (pinned citekeys, tag proposals, jobs) to the backup directory.",
    tags: "Write approved tag proposals into Calibre. Preview lists every change; apply runs that exact list, backs up metadata.db, then refreshes.",
    cleanup: "Remove non-subject tags (BISAC codes, publisher names, statuses, pasted descriptions) from Calibre. Preview first.",
    convert: "Add an EPUB to every MOBI/AZW3-only book so it gets chapter citations. Preview lists the books.",
  };
  document.getElementById("actions").innerHTML = Object.entries(kinds).map(([kind, spec]) => {
    const preview = lastPreview[kind];
    const buttons = spec.previewable
      ? '<button type="button" data-kind="' + kind + '" data-mode="preview">Preview</button>' +
        '<button type="button" class="primary" data-kind="' + kind + '" data-mode="apply"' + (preview ? ' data-preview="' + preview + '"' : " disabled") + ">" +
        (preview ? "Apply preview #" + preview : "Apply (preview first)") + "</button>"
      : '<button type="button" class="primary" data-kind="' + kind + '" data-mode="apply">Run</button>';
    return '<div class="card action"><h3>' + esc(spec.title) + "</h3><p>" + esc(help[kind] || "") + "</p>" + (extra[kind] || "") + '<div class="buttons">' + buttons + "</div></div>";
  }).join("");
  document.querySelectorAll("#actions button").forEach((b) => { if (!canWrite) b.disabled = true; });
}

async function loadJobs() {
  const data = await (await fetch("api/admin/jobs")).json();
  kinds = data.kinds;
  document.getElementById("jobs").innerHTML = data.jobs.map((j) => "<tr><td>" + j.id + "</td><td>" + esc(kinds[j.kind]?.title || j.kind) + "</td><td>" + esc(j.mode) +
    '</td><td class="' + (j.status === "succeeded" ? "good" : j.status === "running" ? "warn" : "bad") + '">' + esc(j.status) + "</td><td>" + esc(j.requested_by || "") +
    "</td><td>" + esc(when(j.created_at)) + '</td><td><button type="button" data-job="' + j.id + '">Log</button></td></tr>').join("");
  return data;
}

// A job opens in a dialog with its live log; a preview offers its apply there.
const dialog = document.getElementById("jobdialog");
async function showJob(id) {
  current = id;
  const j = await (await fetch("api/admin/jobs/" + id)).json();
  if (!dialog.open) dialog.showModal();
  if (location.hash !== "#job-" + id) history.replaceState(null, "", "#job-" + id);
  document.getElementById("jobtitle").textContent = "#" + j.id + " " + (kinds[j.kind]?.title || j.kind) + (j.mode === "preview" ? " — preview" : "");
  document.getElementById("jobhead").innerHTML = '<span class="' + (j.status === "succeeded" ? "good" : j.status === "running" ? "warn" : "bad") + '">' + esc(j.status) + "</span>" +
    (j.requested_by ? " · " + esc(j.requested_by) : "") + " · started " + esc(when(j.created_at)) + (j.finished_at ? " · finished " + esc(when(j.finished_at)) : "") +
    (j.preview_of ? " · applies preview #" + j.preview_of : "");
  const log = document.getElementById("joblog");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = j.log || (j.status === "running" ? "Waiting for output…" : "(no output)");
  if (atBottom) log.scrollTop = log.scrollHeight;
  // A preview can be applied when it succeeded and, for tag jobs, its plan changes something.
  const plan = j.params && j.params.plan;
  const nothing = plan && Array.isArray(plan.books) && plan.books.length === 0;
  const apply = document.getElementById("jobapply");
  const note = document.getElementById("jobnote");
  apply.hidden = !(j.mode === "preview" && j.status === "succeeded" && !nothing && canWrite);
  apply.dataset.kind = j.kind; apply.dataset.preview = j.id;
  note.textContent = j.mode === "preview" && j.status === "succeeded" && nothing ? "Nothing to apply." : j.status === "running" ? "Running…" : "";
  if (j.mode === "preview" && j.status === "succeeded" && !nothing && lastPreview[j.kind] !== j.id) { lastPreview[j.kind] = j.id; renderActions(); }
  if (j.status === "running") setTimeout(() => current === id && dialog.open && showJob(id), 1500);
  else { loadJobs(); loadMetrics(); }
}
document.getElementById("jobclose").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { current = null; history.replaceState(null, "", location.pathname); });
document.getElementById("jobapply").addEventListener("click", (e) => startJob(e.target.dataset.kind, "apply", Number(e.target.dataset.preview)));

async function startJob(kind, mode, previewOf) {
  const body = { kind, mode };
  if (previewOf) body.preview_of = previewOf;
  if (kind === "cleanup" && mode === "preview") body.also = (document.getElementById("also").value || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (mode === "apply" && previewOf && !confirm("Apply preview #" + previewOf + " to Calibre? metadata.db is backed up first, and the index refreshes afterwards.")) return;
  const res = await fetch("api/admin/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { alert(out.error || "Failed."); return; }
  if (mode === "apply") { delete lastPreview[kind]; renderActions(); }
  await loadJobs(); showJob(out.id);
}

document.getElementById("actions").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]"); if (!b) return;
  startJob(b.dataset.kind, b.dataset.mode, b.dataset.preview ? Number(b.dataset.preview) : undefined);
});
document.getElementById("jobs").addEventListener("click", (e) => { const b = e.target.closest("button[data-job]"); if (b) showJob(Number(b.dataset.job)); });

(async () => {
  const who = await (await fetch("api/whoami")).json();
  canWrite = who.can_write;
  const el = document.getElementById("who");
  el.textContent = canWrite ? "Signed in as " + (who.identity.email || who.identity.subject) : "Read-only";
  el.className = "who" + (canWrite ? " ok" : "");
  if (!canWrite) { const r = document.getElementById("readonly"); r.hidden = false; r.textContent = who.reason; }
  const jobs = await loadJobs();
  renderActions();
  loadMetrics();
  setInterval(loadMetrics, 30000);
  const linked = location.hash.match(/^#job-([0-9]+)$/);
  if (linked) showJob(Number(linked[1]));
  else if (jobs.running) showJob(jobs.running);
})();
</script>
</body>
</html>
`;
