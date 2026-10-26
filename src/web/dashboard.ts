import { page } from "./layout.js";

/** /admin: metrics and health at a glance, linking into the object pages, plus the admin jobs. */
export const DASHBOARD_HTML = page({
  title: "Corpus Admin",
  nav: "dashboard",
  css: `
.strip { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.pill { border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 4px 12px; font-size: 0.86rem; }
.pill .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--danger); }
.pill.up .dot { background: var(--ok); }
.warn { color: var(--warn); } .bad { color: var(--danger); } .good { color: var(--ok); }
.big a { color: inherit; text-decoration: none; } .big a:hover { text-decoration: underline; }
.actions { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.action p { margin: 0 0 10px; font-size: 0.9rem; }
.action .buttons { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.action input { width: 100%; margin-bottom: 8px; }
.status-succeeded { color: var(--ok); } .status-running { color: var(--warn); } .status-failed, .status-interrupted { color: var(--danger); }`,
  body: `
<div class="strip" id="neighbors" aria-label="Services"></div>
<h2>Corpus</h2>
<div id="cards" class="grid"></div>
<h2>Actions</h2>
<p id="readonly" class="note" hidden></p>
<div id="actions" class="actions"></div>
<h2>Recent jobs <a class="note" href="/admin/jobs">all jobs</a></h2>
<div class="scroll"><table><thead><tr><th>#</th><th>Job</th><th>Mode</th><th>Status</th><th>By</th><th>Started</th></tr></thead><tbody id="jobs"></tbody></table></div>
<h2>Refresh history</h2>
<div class="scroll"><table><thead><tr><th>Finished</th><th class="num">Seconds</th><th class="num">Extracted</th><th class="num">Unchanged</th><th class="num">Failed</th><th class="num">Removed</th><th>Shelves</th></tr></thead><tbody id="runs"></tbody></table></div>`,
  script: `
let canWrite = false, kinds = {};
const card = (title, big, rows, cls) => '<div class="card"><h3>' + esc(title) + '</h3><div class="big ' + (cls || "") + '">' + big + '</div><div class="rows">' +
  rows.map(([k, v, c]) => "<div><span>" + k + '</span><span class="' + (c || "") + '">' + v + "</span></div>").join("") + "</div></div>";
const go = (href, text) => '<a href="' + href + '">' + text + "</a>";

async function loadMetrics() {
  let m;
  try { m = await api("/api/admin/metrics"); } catch (e) { toast(e.message); return; }
  document.getElementById("neighbors").innerHTML = m.neighbors.map((n) =>
    '<span class="pill ' + (n.up ? "up" : "") + '" title="' + esc(n.url + (n.error ? " — " + n.error : "")) + '"><span class="dot"></span>' + esc(n.name) + (n.up ? " · " + n.ms + " ms" : " · down") + "</span>").join("") +
    '<span class="pill up"><span class="dot"></span>corpus-mcp ' + esc(m.service.version) + "</span>";
  const indexed = m.index.counts.filter((r) => r.status === "indexed");
  const total = indexed.reduce((n, r) => n + r.books, 0);
  const run = m.index.runs[0];
  const staleScan = !m.index.last_scan || Date.now() - Date.parse(m.index.last_scan) > 30 * 60 * 1000;
  const sync = m.sync, syncOk = sync && Object.values(sync.libraries || {}).every((v) => v === "ok") && sync.shelves === "ok";
  const backupAge = m.data.backups.newest_at ? Date.now() - Date.parse(m.data.backups.newest_at) : Infinity;
  const p = m.data.proposals;
  document.getElementById("cards").innerHTML = [
    card("Books indexed", go("/admin/books?status=indexed", num(total)), indexed.map((r) => [go("/admin/books?format=" + r.format, esc(String(r.format).toUpperCase())), num(r.books)])
      .concat([[go("/admin/books?problem=failed", "Failed"), num(m.index.failed.length), m.index.failed.length ? "bad" : ""], [go("/admin/books?problem=no_text", "No text layer"), num(m.index.little_or_no_text)],
        [go("/admin/books?problem=no_outline", "No outline"), num(m.index.no_outline)]])),
    card("Categories", go("/admin/categories", num(m.tags.tagged_books) + " tagged"), [[go("/admin/books?category=uncategorized", "Uncategorized"), "→"],
      [go("/admin/proposals", "Proposals pending"), num(p.pending), p.pending ? "warn" : ""],
      [go("/admin/books?category=not_applied", "Approved, not in Calibre"), num(p.approved_not_in_calibre), p.approved_not_in_calibre ? "warn" : ""],
      [go("/admin/categories", "Suspect tags"), num(m.tags.suspect), m.tags.suspect ? "warn" : ""]]),
    card("Citekeys", go("/admin/citekeys", num(m.citekeys.pinned) + " pinned"), [[go("/admin/books?citekey=ready", "Ready to file"), num(m.citekeys.ready_to_file)],
      [go("/admin/books?citekey=blocked", "Blocked"), num(Object.values(m.citekeys.blocked).reduce((a, b) => a + b, 0)), "warn"], ["Proposed collisions", num(m.citekeys.proposed_collisions)]]),
    card("Quotes", go("/admin/quotes", num(m.quotes.total)), [[go("/admin/quotes?status=orphaned", "Orphaned"), num(m.quotes.orphaned), m.quotes.orphaned ? "bad" : ""]]),
    ...(m.zotero ? [card("Zotero", go("/admin/zotero", num(m.zotero.in_zotero) + " in Zotero"), [["Synced", ago(m.zotero.synced_at), m.zotero.error ? "bad" : ""],
      [go("/admin/zotero", "Possible matches"), num(m.zotero.candidates), m.zotero.candidates ? "warn" : ""], [go("/admin/zotero", "Citekey mismatches"), num(m.zotero.mismatches), m.zotero.mismatches ? "warn" : ""],
      [go("/admin/zotero", "Possible duplicates in Zotero"), num(m.zotero.duplicates), m.zotero.duplicates ? "warn" : ""]],
      m.zotero.error ? "warn" : "")] : []),
    card("ISBNs", go("/admin/books?isbn=printed", num(m.printed_isbns.books_printing_isbn)) + ' <span class="note">printed only</span>', [[go("/admin/books?isbn=none", "No ISBN"), "→"], [go("/admin/books?isbn=valid", "Valid in Calibre"), "→"]]),
    card("Last refresh", ago(m.index.last_scan), run ? [["Took", run.seconds.toFixed(1) + " s"], ["Extracted", num(run.extracted)], ["Failed", num(run.failed), run.failed ? "warn" : ""],
      ["Unreadable libraries", num((run.unreadable_libraries || []).length), (run.unreadable_libraries || []).length ? "bad" : ""]] : [], staleScan ? "warn" : ""),
    card("Last pull", sync ? ago(sync.finished_at) : "no status", sync ? Object.entries(sync.libraries || {}).map(([k, v]) => ["Library " + esc(k), esc(v), v === "ok" ? "good" : "bad"])
      .concat([[go("/admin/shelves", "Shelves"), esc(sync.shelves), sync.shelves === "ok" ? "good" : "bad"]]) : [], syncOk ? "" : "warn"),
    card("Data", bytes(m.data.data_db_bytes), [["Index (corpus.db)", bytes(m.index.corpus_db_bytes)], ["Backups", num(m.data.backups.count)],
      ["Newest backup", ago(m.data.backups.newest_at), backupAge > 36 * 3600 * 1000 ? "warn" : ""]]),
    card("Disk free", m.disk.map((d) => bytes(d.free_bytes)).join(" / "), m.disk.map((d) => [esc(d.path), bytes(d.free_bytes) + " of " + bytes(d.total_bytes),
      d.total_bytes && d.free_bytes / d.total_bytes < 0.1 ? "bad" : ""])),
  ].join("");
  document.getElementById("runs").innerHTML = m.index.runs.map((r) => "<tr><td>" + esc(when(r.finished_at)) + '</td><td class="num">' + r.seconds.toFixed(1) + '</td><td class="num">' + num(r.extracted) +
    '</td><td class="num">' + num(r.unchanged) + '</td><td class="num">' + num(r.failed) + '</td><td class="num">' + num(r.removed) + "</td><td>" + esc(r.shelves) + "</td></tr>").join("");
}

function renderActions() {
  const help = {
    refresh: "Pull from Calibre-Web and update the index now, instead of waiting for the 10-minute timer.",
    backup: "Copy data.db (pinned citekeys, proposals, jobs, change log) to the backup directory.",
    tags: "Make Calibre match every approved category set: adds and removes vocabulary tags. Preview lists each book; apply runs that list.",
    cleanup: "Remove non-subject tags (BISAC codes, publisher names, statuses, pasted descriptions) from Calibre.",
    convert: "Add an EPUB to every MOBI/AZW3/KFX-only book so it gets chapter citations.",
    zotero: "Fetch what changed in the Zotero library since the last sync (it also runs on its own timer), and pin the citekeys of matched books.",
  };
  document.getElementById("actions").innerHTML = Object.entries(kinds).map(([kind, spec]) =>
    '<div class="card action"><h3>' + esc(spec.title) + "</h3><p>" + esc(help[kind] || "") + "</p>" +
    (kind === "cleanup" ? '<input type="text" id="also" placeholder="Also remove these tags (comma-separated)" aria-label="Also remove these tags">' : "") +
    '<div class="buttons"><button type="button" class="primary" data-kind="' + kind + '" data-mode="' + (spec.previewable ? "preview" : "apply") + '"' + (canWrite ? "" : " disabled") + ">" +
    (spec.previewable ? "Preview" : "Run") + "</button></div></div>").join("");
}

async function loadJobs() {
  const d = await api("/api/admin/jobs?limit=8");
  kinds = d.kinds;
  document.getElementById("jobs").innerHTML = d.jobs.length ? d.jobs.map((j) => '<tr><td><a href="/admin/jobs/' + j.id + '">#' + j.id + '</a></td><td><a href="/admin/jobs/' + j.id + '">' + esc((kinds[j.kind] || {}).title || j.kind) +
    "</a></td><td>" + esc(j.mode) + '</td><td class="status-' + esc(j.status) + '">' + esc(j.status) + "</td><td>" + esc(j.requested_by || "") + "</td><td>" + esc(when(j.created_at)) + "</td></tr>").join("")
    : '<tr><td colspan="6" class="empty">No jobs yet.</td></tr>';
}

document.getElementById("actions").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-kind]"); if (!b) return;
  const body = { kind: b.dataset.kind, mode: b.dataset.mode };
  if (body.kind === "cleanup") body.also = (document.getElementById("also").value || "").split(",").map((t) => t.trim()).filter(Boolean);
  try { const out = await post("/api/admin/jobs", body); location.href = "/admin/jobs/" + out.id; } catch (err) { toast(err.message); }
});

Promise.all([ME, loadJobs()]).then(([me]) => {
  canWrite = me.can_write;
  if (!canWrite) { const r = document.getElementById("readonly"); r.hidden = false; r.textContent = me.reason; }
  renderActions();
}).catch((e) => toast(e.message));
loadMetrics();
setInterval(loadMetrics, 30000);`,
});
