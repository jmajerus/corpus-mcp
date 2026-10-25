import { page } from "./layout.js";

/** /admin/books/<id>: one book's current state, with editors for its categories and citekey. */
export const BOOK_HTML = page({
  title: "Book",
  nav: "books",
  css: `
.head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; align-items: flex-start; }
.head .links { font-size: 0.9rem; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; margin-top: 14px; }
.card h2 { margin: 0 0 8px; font-size: 1rem; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; font-size: 0.88rem; }
.kv dt { color: var(--muted); } .kv dd { margin: 0; overflow-wrap: anywhere; }
.editor { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); }
.editor .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; align-items: center; }
.editor input { flex: 1; min-width: 180px; }
.diff .add { background: var(--ok-bg); } .diff .del { background: var(--danger-bg); text-decoration: line-through; }
.outline { max-height: 360px; overflow: auto; font-size: 0.86rem; margin: 0; padding-left: 0; list-style: none; }
.outline li { padding: 1px 0; } .outline .pg { color: var(--muted); font-variant-numeric: tabular-nums; margin-left: 6px; }
.desc { font-size: 0.9rem; margin: 8px 0 0; }`,
  body: `
<p><a href="/admin/books">← Books</a></p>
<div id="book"><p class="note">Loading…</p></div>`,
  script: `
const id = decodeURIComponent(location.pathname.split("/").pop());
let book, canWrite = false, desired = [];

function kv(pairs) { return '<dl class="kv">' + pairs.filter((p) => p[1] !== null && p[1] !== undefined && p[1] !== "").map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + v + "</dd>").join("") + "</dl>"; }

function categoriesCard() {
  const c = book.categories;
  const calibre = c.calibre.length ? c.calibre.map((t) => tagChip(t.tag)).join("") : '<span class="note">None</span>';
  const pending = c.pending_in_calibre && (c.pending_in_calibre.add.length || c.pending_in_calibre.remove.length)
    ? '<p class="note">Approved but not yet in Calibre:</p><div class="diff">' + c.pending_in_calibre.add.map((t) => '<span class="chip add" title="' + esc(t) + '">+ ' + esc(LABELS.get(t) || t) + "</span>").join("") +
      c.pending_in_calibre.remove.map((t) => '<span class="chip del" title="' + esc(t) + '">− ' + esc(LABELS.get(t) || t) + "</span>").join("") +
      '</div><div class="row"><button type="button" class="primary" id="applybook"' + (canWrite ? "" : " disabled") + ">Preview and apply this book</button></div>"
    : "";
  const p = c.proposal;
  const proposal = p ? '<p class="note">' + (p.status === "pending" ? 'Proposal pending review (<a href="/admin/proposals">review it</a>)' : "Proposal " + esc(p.status)) +
    (p.proposed_by ? " · by " + esc(p.proposed_by) : "") + " · " + esc(ago(p.proposed_at)) + "<br>" + esc(p.rationale) + "</p>" : "";
  const editor = '<div class="editor"><strong>Set categories</strong><div class="note">The book’s complete set. Saving records it as approved; apply it to Calibre with a preview.</div>' +
    '<div id="desired" style="margin-top:6px"></div><div class="row"><input type="text" id="addcat" list="vocab" placeholder="Add a category (title or slug)" aria-label="Add a category"' + (canWrite ? "" : " disabled") + ">" +
    '<button type="button" id="addbtn"' + (canWrite ? "" : " disabled") + '>Add</button><button type="button" class="primary" id="savecats"' + (canWrite ? "" : " disabled") + ">Save</button></div>" +
    (canWrite ? "" : '<p class="note">Sign in through Cloudflare Access to edit.</p>') + "</div>";
  return '<div class="card"><h2>Categories ' + badge("category", c.state) + "</h2><div>In Calibre: " + calibre + "</div>" + pending + proposal + editor + "</div>";
}

// Where the book is in the Zotero mirror; title-only candidates get confirm and reject buttons.
function zoteroRow() {
  const z = book.zotero;
  if (!z) return '<span class="note">not synced</span>';
  const how = { calibre_uuid: "by its Calibre UUID", isbn: "by ISBN", confirmed: "confirmed by a person" };
  if (z.match) return '<a href="' + esc(z.link) + '">' + esc(z.match.key) + "</a>" + (z.match.citekey ? " · " + esc(z.match.citekey) : ' · <span class="note">no citekey</span>') +
    ' <span class="note">' + esc(how[z.match.matched_by] || z.match.matched_by) + "</span>";
  if (!z.candidates.length) return '<span class="note">not found</span>';
  const dis = canWrite ? "" : " disabled";
  return z.candidates.map((x) => '<div>Maybe <a href="' + esc(x.link) + '">' + esc(x.key) + "</a> " + esc(x.title || "") + (x.year ? " (" + x.year + ")" : "") + (x.citekey ? " · " + esc(x.citekey) : "") +
    ' <button type="button" data-zkey="' + esc(x.key) + '" data-zaction="confirm"' + dis + ">This book</button>" +
    ' <button type="button" data-zkey="' + esc(x.key) + '" data-zaction="reject"' + dis + ">Not this book</button></div>").join("");
}

function citekeyCard() {
  const k = book.citekey;
  const blockers = { unknown_author: "Calibre has no author", merged_authors: "an author record names several people", no_year: "Calibre has no year", malformed: "the proposed key is malformed" };
  const rows = [["State", badge("citekey", k.state)], ["Calibre identifier", k.calibre_identifier ? esc(k.calibre_identifier) : null],
    ["Pinned", k.pinned ? esc(k.pinned.citekey) + ' <span class="note">' + (k.pinned.pinned_by ? "by " + esc(k.pinned.pinned_by) + " · " : "") + esc(ago(k.pinned.pinned_at)) + "</span>" : null],
    ["Proposed", k.proposed ? esc(k.proposed) : null], ["Blocked by", k.blockers.length ? k.blockers.map((b) => esc(blockers[b] || b)).join("; ") : null],
    ["Zotero", zoteroRow()]];
  const editor = '<div class="editor"><strong>Pin a citekey</strong><div class="note">The key the book was given when it was filed in a reference manager.</div><div class="row">' +
    '<input type="text" id="citekey" value="' + esc(k.pinned ? k.pinned.citekey : k.proposed || "") + '" aria-label="Citekey"' + (canWrite ? "" : " disabled") + ">" +
    '<button type="button" class="primary" id="pin"' + (canWrite ? "" : " disabled") + ">" + (k.pinned ? "Replace" : "Pin") + "</button>" +
    (k.pinned ? '<button type="button" class="danger" id="unpin"' + (canWrite ? "" : " disabled") + ">Unpin</button>" : "") + "</div></div>";
  return '<div class="card"><h2>Citekey</h2>' + kv(rows) + editor + "</div>";
}

function render() {
  const b = book, f = b.file;
  const badges = [badge("category", b.categories.state), badge("citekey", b.citekey.state), badge("isbn", b.isbn.state)].concat(b.problems.map((p) => badge("problem", p)));
  document.title = b.title + " · Corpus Admin";
  const printed = b.isbn.printed.length ? '<table style="margin-top:8px"><thead><tr><th>Printed ISBN</th><th>Binding</th><th>Where</th></tr></thead><tbody>' +
    b.isbn.printed.map((p) => "<tr><td>" + esc(p.isbn) + "</td><td>" + esc(p.format || "–") + "</td><td>" + (p.position === "back" ? "back page " : "page ") + p.page + "</td></tr>").join("") + "</tbody></table>" : "";
  const changes = b.changes.length ? '<div class="scroll"><table><thead><tr><th>When</th><th>Change</th><th>Detail</th><th>Source</th><th>By</th></tr></thead><tbody>' +
    b.changes.map((ch) => "<tr><td>" + esc(when(ch.at)) + "</td><td>" + esc(String(ch.kind).replace("_", " ")) + "</td><td>" +
      (["tag_added", "tag_removed", "tag_proposed", "proposal_approved"].includes(ch.kind) ? tagChip(ch.detail) : esc(ch.detail || "")) + "</td><td>" +
      (ch.job_id ? '<a href="/admin/jobs/' + ch.job_id + '">' + esc(ch.source) + " #" + ch.job_id + "</a>" : esc(ch.source)) + "</td><td>" + esc(ch.actor || "") + "</td></tr>").join("") +
    '</tbody></table></div><p class="note"><a href="/admin/changes?q=' + encodeURIComponent(b.book_id) + '&range=all">All changes to this book</a></p>' : '<p class="note">No recorded changes.</p>';
  document.getElementById("book").innerHTML =
    '<div class="head"><div><h1>' + esc(b.title) + '</h1><p class="sub">' + esc(b.authors.join(", ")) + (b.year ? " · " + b.year : "") + (b.publisher ? " · " + esc(b.publisher) : "") + " · " + esc(b.book_id) + "</p>" + badges.join("") + "</div>" +
    '<div class="links">' + (b.status === "indexed" ? '<a href="/admin/books/' + encodeURIComponent(b.book_id) + '/read">Read</a>' : "") +
      (b.calibre_web_url ? ' · <a href="' + esc(b.calibre_web_url) + '" target="_blank" rel="noopener">Open in Calibre-Web</a>' : "") + "</div></div>" +
    (b.description ? '<p class="desc">' + esc(String(b.description).replace(/<[^>]+>/g, " ").slice(0, 600)) + "</p>" : "") +
    '<div class="cols">' + categoriesCard() + citekeyCard() +
    '<div class="card"><h2>Shelves and other tags</h2>' + kv([["Shelves", b.shelves.length ? b.shelves.map((s) => '<a class="chip muted" href="/admin/books?shelf=' + encodeURIComponent(s) + '">' + esc(s) + "</a>").join("") : '<span class="note">None</span>'],
      ["Other tags", b.other_tags.length ? b.other_tags.map((t) => '<span class="chip muted" title="' + esc(t.suspect || "") + '">' + esc(t.tag) + (t.suspect ? " ⚠" : "") + "</span>").join("") : '<span class="note">None</span>']]) + "</div>" +
    '<div class="card"><h2>ISBN</h2>' + kv([["State", badge("isbn", b.isbn.state)], ["In Calibre", b.isbn.calibre ? esc(b.isbn.calibre) + (b.isbn.valid ? "" : ' <span class="note">(fails its check digit)</span>') : null]]) + printed + "</div>" +
    '<div class="card"><h2>File</h2>' + kv([["Status", esc(b.status) + (b.error ? ' <span class="note">' + esc(b.error) + "</span>" : "")], ["Format", esc((f.format || "–").toUpperCase())],
      ["Length", f.pages ? num(f.pages) + (f.page_kind === "location" ? " locations" : " pages") : null], ["Text", f.text_chars !== null ? num(f.text_chars) + " characters" : null],
      ["Size", f.size ? bytes(f.size) : null], ["Path", f.path ? esc(f.path) : null], ["Same file as", b.same_file_as.length ? b.same_file_as.map((x) => bookLink(x)).join(", ") : null],
      ["Calibre", "id " + b.calibre_id + ' · <span class="note">' + esc(b.uuid || "") + "</span>"]]) + "</div>" +
    '<div class="card"><h2>Outline</h2>' + (b.outline.length ? '<ul class="outline">' + b.outline.map((o) => '<li style="padding-left:' + o.level * 14 + 'px">' + esc(o.title) +
      '<span class="pg">' + (o.page_label ? "p. " + esc(o.page_label) : o.page ? (f.page_kind === "location" ? "loc. " : "p. ") + o.page : "") + "</span></li>").join("") + "</ul>" : '<p class="note">No outline.</p>') + "</div>" +
    "</div><h2>Quotes</h2>" + quotesSection() + "<h2>Recent changes</h2>" + changes;
  renderDesired();
}

function quotesSection() {
  const read = book.status === "indexed" ? '<a href="/admin/books/' + encodeURIComponent(book.book_id) + '/read">Open the reader</a> and select a passage to save a quote.' : "";
  if (!book.quotes.length) return '<p class="note">No quotes from this book. ' + read + "</p>";
  return '<div class="scroll"><table><thead><tr><th>Quote</th><th>Where</th><th>Tags</th></tr></thead><tbody>' +
    book.quotes.map((q) => '<tr><td><a href="/admin/quotes/' + q.id + '">#' + q.id + "</a> " + esc(q.text.length > 220 ? q.text.slice(0, 220) + "…" : q.text) + "</td><td>" + esc(q.locator) +
      (q.status === "orphaned" ? " " + '<span class="badge bad"><span class="sign">!</span>Orphaned</span>' : "") + "</td><td>" +
      q.labels.map((l) => '<span class="chip muted">' + esc(l) + "</span>").join("") + "</td></tr>").join("") + '</tbody></table></div><p class="note">' + read + "</p>";
}

function renderDesired() {
  const el = document.getElementById("desired");
  el.innerHTML = desired.length ? desired.map((t) => tagChip(t, canWrite ? '<button type="button" data-remove="' + esc(t) + '" aria-label="Remove ' + esc(LABELS.get(t) || t) + '">×</button>' : "")).join("")
    : '<span class="note">No categories.</span>';
}

async function load() {
  try { book = await api("/api/books/" + encodeURIComponent(id)); } catch (e) { document.getElementById("book").innerHTML = '<p class="empty">' + esc(e.message) + "</p>"; return; }
  desired = (book.categories.approved || book.categories.calibre).map((t) => t.tag);
  render();
}

document.getElementById("book").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.remove) { desired = desired.filter((x) => x !== t.dataset.remove); renderDesired(); return; }
  try {
    if (t.dataset.zkey) {
      const out = await post("/api/zotero/link", { book_id: id, key: t.dataset.zkey, action: t.dataset.zaction });
      toast(t.dataset.zaction === "confirm" ? "Linked" + (out.pinned.length ? " and pinned " + out.pinned.join(", ") : "") + "." : "Marked as not this book."); await load();
    } else if (t.id === "addbtn") {
      const value = document.getElementById("addcat").value.trim().toLowerCase();
      const match = [...LABELS].find(([tag, label]) => tag === value || label.toLowerCase() === value);
      if (!match) { toast("Not in the vocabulary."); return; }
      if (!desired.includes(match[0])) desired.push(match[0]);
      document.getElementById("addcat").value = ""; renderDesired();
    } else if (t.id === "savecats") {
      await post("/api/books/" + encodeURIComponent(id) + "/categories", { tags: desired });
      toast("Saved. Preview and apply to write it to Calibre."); await load();
    } else if (t.id === "applybook") {
      const job = await post("/api/admin/jobs", { kind: "tags", mode: "preview", books: [id] });
      location.href = "/admin/jobs/" + job.id;
    } else if (t.id === "pin") {
      const key = document.getElementById("citekey").value.trim();
      await post("/api/books/" + encodeURIComponent(id) + "/citekey", { citekey: key, replace: Boolean(book.citekey.pinned) });
      toast("Pinned " + key + "."); await load();
    } else if (t.id === "unpin") {
      if (!confirm("Unpin " + book.citekey.pinned.citekey + "?")) return;
      await post("/api/books/" + encodeURIComponent(id) + "/citekey", { citekey: null });
      toast("Unpinned."); await load();
    }
  } catch (err) { toast(err.message); }
});

Promise.all([ME, VOCAB]).then(([me, labels]) => {
  canWrite = me.can_write;
  const list = document.createElement("datalist"); list.id = "vocab";
  list.innerHTML = [...labels].map(([tag, label]) => '<option value="' + esc(label) + '">' + esc(tag) + "</option>").join("");
  document.body.appendChild(list);
  load();
});`,
});
