import { page } from "./layout.js";

const JOB_CSS = `
.chg { display: inline-block; border-radius: 6px; padding: 1px 8px; margin: 1px 4px 1px 0; font-size: 0.82rem; overflow-wrap: anywhere; }
.chg.add { background: var(--ok-bg); } .chg.del { background: var(--danger-bg); text-decoration: line-through; }
.chg b { margin-right: 4px; }
.warning { color: var(--warn); }
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
  const nothing = j.status === "succeeded" && (plan?.books ? plan.books.length === 0 : items.every(it => it.convert_skipped));
  const actions = [];
  const reviews = items.filter(it => it.duplicate_review), clean = reviews.filter(it => !it.duplicate_review.blockers.length);
  const applicable = reviews.length ? clean.length > 0 : !nothing;
  if (j.mode === "preview" && j.status === "succeeded" && applicable) actions.push('<button type="button" class="primary" id="apply"' + (canWrite ? "" : " disabled") + ">" + (reviews.length > 1 ? "Apply " + num(clean.length) + " of " + num(reviews.length) + " groups" : "Apply this preview") + "</button>" + (reviews.length && clean.length < reviews.length ? ' <span class="note">Groups with blockers are skipped.</span>' : ""));
  if (j.mode === "preview" && j.status === "succeeded" && reviews.length && !clean.length) actions.push('<span class="note">Every group has blockers; resolve them and preview again.</span>');
  if (j.mode === "preview" && nothing) actions.push('<span class="note">Nothing to apply.</span>');
  if (j.mode === "apply" && items.length) actions.push('<a href="/admin/changes?job=' + j.id + '&range=all">These changes in the change log</a>');
  document.getElementById("actions").innerHTML = actions.join(" ");
  const calibreLink = (bookId,label) => j.calibre_web_url ? '<a href="'+esc((j.calibre_web_url.endsWith('/') ? j.calibre_web_url.slice(0,-1) : j.calibre_web_url)+'/book/'+bookId)+'" target="_blank" rel="noopener">'+esc(label)+'</a>' : '';
  const library = (j.params && j.params.plan && j.params.plan.library) || "main";
  document.getElementById("items").innerHTML = items.length
    ? "<h2>" + num(items.length) + " book" + (items.length === 1 ? "" : "s") + (j.mode === "preview" ? " would change" : " changed") + '</h2><div class="scroll"><table><thead><tr><th>Book</th><th>Changes</th></tr></thead><tbody>' +
      items.map((it) => "<tr><td>" + bookLink(library + ":" + it.calibre_id, it.title) + '<br><span class="note">' + esc(library + ":" + it.calibre_id) + "</span></td><td>" +
        (it.added || []).map((t) => '<span class="chg add" title="' + esc(t) + '"><b>+</b>' + esc(LABELS.get(t) || t) + "</span>").join("") +
        (it.removed || []).map((t) => '<span class="chg del" title="' + esc(t) + '"><b>−</b>' + esc(LABELS.get(t) || t) + "</span>").join("") +
        (it.duplicate_review ? duplicateReview(it.duplicate_review, library, calibreLink) : '') +
        (it.duplicate_skipped ? '<p class="status-failed">Skipped without changes: ' + esc(it.duplicate_skipped.message) + '</p>' : '') +
        (it.duplicate_partial ? '<p class="status-failed">' + esc(it.duplicate_partial.message) + ' Backup: ' + esc(it.duplicate_partial.backup) + '</p>' : '') +
        (it.duplicate_resolved ? '<p>Duplicate ' + esc(it.duplicate_resolved.removed_id) + ' moved to Calibre’s trash' + ((it.duplicate_resolved.shelves || []).length ? '; shelves ' + esc(it.duplicate_resolved.shelves.map(s => s.shelf + ' ' + (s.action === 'moved' ? 'moved to the keeper' : 'already had the keeper')).join(', ')) : '') + '. Backup: ' + esc(it.duplicate_resolved.backup) + '</p>' : '') +
        (it.metadata ? '<div>' + (it.metadata.partial ? '<strong>Partially applied</strong><br>' : '') + '<span class="chg del">' + esc(it.metadata.before.title) + ' · ' + esc(it.metadata.before.authors.join("; ")) + " · " + esc(it.metadata.before.year ?? "year unknown") + '</span><br><span class="chg add">' + esc(it.metadata.after.title) + ' · ' + esc(it.metadata.after.authors.join("; ")) + " · " + esc(it.metadata.after.year ?? "year unknown") + '</span></div>' : "") +
        (it.convert_skipped ? '<span class="status-failed">Not converted: ' + esc(it.convert_skipped === "encrypted" ? "DRM-encrypted; download it again and add it through DeDRM" : it.convert_skipped === "unrecognized" ? "unrecognized file" : it.convert_skipped) + (it.source_format ? " (" + esc(String(it.source_format).toUpperCase()) + ")" : "") + "</span>" : "") +
        (it.added_format ? '<span class="chg add"><b>+</b>' + esc(String(it.added_format).toUpperCase()) + " from " + esc(String(it.source_format).toUpperCase()) + "</span>" : "") +
        "</td></tr>").join("") + "</tbody></table></div>"
    : "";
  const log = document.getElementById("log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = j.log || (j.status === "running" ? "Waiting for output…" : "(no output)");
  if (atBottom) log.scrollTop = log.scrollHeight;
  if (j.status === "running") setTimeout(load, 1500);
}

function duplicateReview(r, library, calibreLink) {
  // Reviews saved before batch resolution hold one remove object and plain format names.
  const removes = [].concat(r.plan.remove).map(x => x.id), members = [r.keep, ...[].concat(r.remove || [])].filter(Boolean);
  const fmt = list => (list || []).map(c => typeof c === 'string' ? c : c.format + ' from ' + c.from).join(', ') || 'none';
  return '<div><strong>Keep ' + esc(library + ':' + r.plan.keep.id) + '; trash ' + esc(removes.map(id => library + ':' + id).join(', ')) + '</strong><p>' + calibreLink(r.plan.keep.id, 'Open keeper in Calibre-Web') + removes.map(id => ' · ' + calibreLink(id, 'Open ' + id + ' in Calibre-Web')).join('') + '</p>' +
    (r.keep ? '<p>Copy unique formats: ' + esc(fmt(r.copy_formats)) + '. Keep keeper’s conflicting formats: ' + esc(fmt(r.conflicting_formats)) + '.</p><p>Unique tags and missing descriptive metadata are preserved. Every record and its files are backed up before the duplicates enter Calibre’s trash.</p>' +
      ((r.shelves || []).length ? '<p>Calibre-Web shelves: ' + esc(r.shelves.map(s => s.shelf + (s.action === 'move' ? ' moves from ' + s.duplicate + ' to the keeper' : ' already has the keeper; ' + s.duplicate + '’s link is removed')).join('; ')) + '. Calibre-Web’s app.db is backed up first.</p>' : '') : '') +
    (r.size_warnings || []).map(w => '<p class="warning">' + esc(w) + '</p>').join('') +
    r.blockers.map(b => '<p class="status-failed">' + esc(b) + '</p>').join('') +
    (members.length > 1 ? '<details><summary>Compare source metadata and formats</summary><div class="scroll"><table><thead><tr><th>Field</th>' + members.map((m, i) => '<th>' + (i ? 'Duplicate ' : 'Keeper ') + esc(m.id) + '</th>').join('') + '</tr></thead><tbody>' + ['title','authors','pubdate','publisher','comments','series','languages','rating','tags','identifiers'].map(k => '<tr><th>' + esc(k) + '</th>' + members.map(m => '<td>' + esc(JSON.stringify(m.values[k] ?? '')) + '</td>').join('') + '</tr>').join('') + '<tr><th>formats</th>' + members.map(m => '<td>' + esc(Object.keys(m.formats).join(', ')) + '</td>').join('') + '</tr></tbody></table></div><p>The keeper’s populated fields take precedence. Missing descriptive fields and identifiers are copied from the first duplicate that has them.</p></details>' : '') + '</div>';
}

document.getElementById("actions").addEventListener("click", async (e) => {
  if (e.target.id !== "apply") return;
  const j = await api("/api/admin/jobs/" + id);
  if (!confirm(j.kind === "duplicates" ? "Merge the reviewed groups without blockers and move their duplicates to Calibre’s trash? metadata.db and every record’s files are backed up first." : "Apply preview #" + id + " to Calibre? metadata.db is backed up first, and the index refreshes afterwards.")) return;
  try {
    const out = await post("/api/admin/jobs", { kind: j.kind, mode: "apply", preview_of: id });
    location.href = "/admin/jobs/" + out.id;
  } catch (err) { toast(err.message); }
});

Promise.all([ME, VOCAB, api("/api/admin/jobs?limit=1")]).then(([me, , list]) => { canWrite = me.can_write; kinds = list.kinds; load(); });`,
});
