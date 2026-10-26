import { page } from "./layout.js";

/** /admin/taxonomy: the supplied vocabulary's state and corpus-mcp's overlay of research terms. */
export const TAXONOMY_HTML = page({
  title: "Taxonomy",
  nav: "taxonomy",
  css: `
.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.tabs button[aria-pressed="true"] { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.term { margin-bottom: 12px; }
.term h3 { font-size: 1rem; margin: 0; text-transform: none; letter-spacing: 0; color: var(--text); }
.meta { color: var(--muted); font-size: 0.86rem; margin: 2px 0 8px; }
.meta code, .path { font-size: 0.82rem; background: var(--code); border-radius: 4px; padding: 0 4px; }
.scope { font-size: 0.92rem; margin: 8px 0; padding-left: 10px; border-left: 3px solid var(--border); }
.act { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.form { display: grid; gap: 8px; margin-top: 10px; }
.form label { display: grid; gap: 2px; font-size: 0.82rem; color: var(--muted); }
.form textarea { min-height: 60px; }
.status { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }`,
  body: `
<h1>Taxonomy</h1>
<p class="sub">The supplied vocabulary, and corpus-mcp's own terms merged over it: coined during research, usable for tagging at once. When the supplied vocabulary gains a term at the same path, it takes over and books keep the tag.</p>
<section class="grid" id="summary"></section>
<h2>Add a term</h2>
<form class="card form" id="add">
  <label>Parent (id or title path)<input type="text" name="parent" list="vocab" required placeholder="social-sciences.psychology"></label>
  <label>Label<input type="text" name="label" required placeholder="Moral Injury"></label>
  <label>Scope note: what belongs here, and what doesn't<textarea name="scope_note" required></textarea></label>
  <label>Slug (optional; made from the label)<input type="text" name="slug" placeholder="moral-injury"></label>
  <label>Other names (optional, comma-separated)<input type="text" name="alt_labels"></label>
  <div class="act"><button type="submit" class="primary" id="add-button">Add provisional term</button></div>
</form>
<datalist id="vocab"></datalist>
<h2>Overlay terms</h2>
<div class="tabs" id="tabs"></div>
<section id="list" aria-live="polite"></section>
<section id="orphans"></section>
<h2>History</h2>
<div class="scroll"><table><thead><tr><th>When</th><th>Change</th><th>Term</th><th>Detail</th><th>By</th></tr></thead><tbody id="events"></tbody></table></div>`,
  script: `
const STATUSES = ["provisional", "confirmed", "superseded", "retired"];
let status = new URLSearchParams(location.search).get("status") || "provisional", data = null, canWrite = false;
const list = document.getElementById("list");
const card = (title, big, rows) => '<div class="card"><h3>' + esc(title) + '</h3><div class="big">' + big + '</div><div class="rows">' + rows.map(([k, v]) => "<div><span>" + esc(k) + "</span><span>" + v + "</span></div>").join("") + "</div></div>";
const short = (v) => (v ? '<code title="' + esc(v) + '">' + esc(String(v).slice(0, 26)) + (String(v).length > 26 ? "…" : "") + "</code>" : "–");
function summary() {
  const b = data.base, m = data.merged;
  document.getElementById("summary").innerHTML =
    card("Supplied vocabulary", num(b.assignable), [["Terms", num(b.terms)], ["Version", short(b.version)], ["Pushed", b.installed ? esc(ago(b.installed.at)) : "not through the intake"], ["Problem", b.error ? esc(b.error) : "none"]]) +
    card("Merged", num(m.assignable), [["Terms", num(m.terms)], ["Version", short(m.version)], ["Problem", m.error ? esc(m.error) : "none"]]) +
    card("Overlay", num(data.counts.provisional + data.counts.confirmed), [["Provisional", num(data.counts.provisional)], ["Confirmed", num(data.counts.confirmed)], ["Superseded", num(data.counts.superseded)], ["Left out", num(data.orphans.length)]]);
}
function tabs() {
  document.getElementById("tabs").innerHTML = STATUSES.map((s) => '<button type="button" data-status="' + s + '" aria-pressed="' + (s === status) + '">' +
    s[0].toUpperCase() + s.slice(1) + " (" + num(data.counts[s] || 0) + ")</button>").join("");
}
function termCard(t) {
  const active = t.status === "provisional" || t.status === "confirmed";
  const off = canWrite ? "" : " disabled";
  return '<article class="card term" data-id="' + esc(t.id) + '"><h3>' + esc(t.title_path || t.label) + "</h3>" +
    '<div class="meta"><span class="path">' + esc(t.path) + "</span> · " + '<span class="status">' + esc(t.status) + "</span> · " +
    '<a href="/admin/books?tag=' + encodeURIComponent(t.path) + '">' + num(t.books) + " book" + (t.books === 1 ? "" : "s") + "</a>" +
    " · added by " + esc(t.created_by || "unknown") + " · " + esc(ago(t.created_at)) + "</div>" +
    (t.scope_note ? '<p class="scope">' + esc(t.scope_note) + "</p>" : '<p class="note">No scope note.</p>') +
    (t.alt_labels.length ? '<div class="note">Also: ' + esc(t.alt_labels.join(", ")) + "</div>" : "") +
    (t.former_paths.length ? '<div class="note">Formerly ' + esc(t.former_paths.join(", ")) + "</div>" : "") +
    (t.replaced_by ? '<div class="note">Replaced by ' + esc(t.replaced_by) + "</div>" : "") +
    (active ? '<div class="act">' + (t.status === "provisional" ? '<button type="button" class="primary" data-act="confirm"' + off + ">Confirm</button>" : "") +
      '<button type="button" data-act="edit"' + off + '>Edit</button><button type="button" data-act="move"' + off + '>Move</button><button type="button" class="danger" data-act="retire"' + off + ">Retire</button></div>" : "") +
    '<div class="slot"></div></article>';
}
function forms(t, act) {
  if (act === "edit") return '<form class="form" data-act="edit"><label>Label<input type="text" name="label" value="' + esc(t.label) + '"></label>' +
    '<label>Scope note<textarea name="scope_note">' + esc(t.scope_note || "") + "</textarea></label>" +
    '<label>Other names (comma-separated)<input type="text" name="alt_labels" value="' + esc(t.alt_labels.join(", ")) + '"></label><div class="act"><button class="primary">Save</button></div></form>';
  if (act === "move") return '<form class="form" data-act="move"><label>New parent (id or title path)<input type="text" name="parent" list="vocab" value="' + esc(t.path.split(".").slice(0, -1).join(".")) + '"></label>' +
    '<label>Slug<input type="text" name="slug" value="' + esc(t.path.split(".").at(-1)) + '"></label><p class="note">Books tagged with the old path are re-tagged by the tags job.</p><div class="act"><button class="primary">Move</button></div></form>';
  return '<form class="form" data-act="retire"><label>Replaced by (optional; id or title path)<input type="text" name="replaced_by" list="vocab"></label>' +
    '<p class="note">With a replacement, the tags job re-tags books; without one, they wait for a person.</p><div class="act"><button class="danger">Retire</button></div></form>';
}
function render() {
  summary(); tabs();
  const terms = data.terms.filter((t) => t.status === status);
  list.innerHTML = terms.length ? terms.map(termCard).join("") : '<p class="empty">No ' + status + " terms.</p>";
  document.getElementById("orphans").innerHTML = data.orphans.length ? '<h2>Left out of the merge</h2><div class="card">' +
    data.orphans.map((o) => '<div><span class="path">' + esc(o.path) + "</span> " + esc(o.reason) + "</div>").join("") + "</div>" : "";
  const label = (e) => { const t = data.terms.find((x) => x.id === e.term_id); return t ? esc(t.title_path || t.path) : esc(e.path || ""); };
  const detail = (d) => (d ? esc(Object.entries(d).map(([k, v]) => k + ": " + (Array.isArray(v) ? v.join(", ") : v ?? "–")).join("; ")) : "");
  document.getElementById("events").innerHTML = data.events.map((e) => "<tr><td>" + esc(when(e.at)) + "</td><td>" + esc(e.kind.replace("_", " ")) + "</td><td>" + label(e) +
    "</td><td>" + detail(e.detail) + "</td><td>" + esc(e.actor || "") + "</td></tr>").join("") || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>';
}
async function load() {
  try { data = await api("/api/taxonomy"); } catch (e) { toast(e.message); return; }
  render();
}
const values = (form) => Object.fromEntries(new FormData(form));
const names = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
document.getElementById("tabs").addEventListener("click", (e) => {
  const s = e.target.closest("button")?.dataset.status;
  if (s && s !== status) { status = s; history.replaceState(null, "", location.pathname + (s === "provisional" ? "" : "?status=" + s)); render(); }
});
document.getElementById("add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = values(e.target);
  try {
    const out = await post("/api/taxonomy/terms", { parent: v.parent, label: v.label, scope_note: v.scope_note, slug: v.slug || undefined, alt_labels: names(v.alt_labels) });
    e.target.reset(); toast("Added " + out.term.path + "."); status = "provisional"; load();
  } catch (err) { toast(err.message); }
});
list.addEventListener("click", async (e) => {
  const article = e.target.closest("article"), act = e.target.dataset?.act;
  if (!article || !act || e.target.tagName !== "BUTTON" || e.target.closest("form")) return;
  const t = data.terms.find((x) => x.id === article.dataset.id);
  if (act === "confirm") {
    try { await post("/api/taxonomy/terms/" + encodeURIComponent(t.id), { action: "confirm" }); toast("Confirmed."); load(); } catch (err) { toast(err.message); }
    return;
  }
  const slot = article.querySelector(".slot");
  slot.innerHTML = slot.dataset.open === act ? "" : forms(t, act);
  slot.dataset.open = slot.innerHTML ? act : "";
});
list.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target, id = form.closest("article").dataset.id, v = values(form), act = form.dataset.act;
  const body = act === "edit" ? { action: "edit", label: v.label, scope_note: v.scope_note || null, alt_labels: names(v.alt_labels) }
    : act === "move" ? { action: "move", parent: v.parent || null, slug: v.slug || undefined }
    : { action: "retire", replaced_by: v.replaced_by || null };
  try { await post("/api/taxonomy/terms/" + encodeURIComponent(id), body); toast(act === "edit" ? "Saved." : act === "move" ? "Moved." : "Retired."); load(); } catch (err) { toast(err.message); }
});
Promise.all([ME, VOCAB]).then(([me, labels]) => {
  canWrite = me.can_write;
  document.getElementById("add-button").disabled = !canWrite;
  document.getElementById("vocab").innerHTML = [...labels].map(([tag, label]) => '<option value="' + esc(tag) + '">' + esc(label) + "</option>").join("");
  load();
});`,
});
