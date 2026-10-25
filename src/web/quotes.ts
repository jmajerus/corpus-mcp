import { page } from "./layout.js";

/**
 * A chip editor for a quote's free-form tags, shared by the quote page and the reader. Typing offers the tags
 * already in use (from /api/quotes), so one theme keeps one spelling; Enter, a comma, or Add adds a tag.
 */
const TAG_EDITOR = `
function tagEditor(root, initial, enabled) {
  let tags = initial.slice();
  root.innerHTML = '<span class="tagchips"></span><span class="tagadd"><input type="text" list="usedtags" placeholder="Add a tag: a theme, a form, cc:puzzle:…" aria-label="Add a tag"' + (enabled ? "" : " disabled") + '><button type="button"' + (enabled ? "" : " disabled") + ">Add</button></span>";
  const chips = root.querySelector(".tagchips"), input = root.querySelector("input");
  const draw = () => { chips.innerHTML = tags.map((t) => '<span class="chip muted">' + esc(t) + (enabled ? '<button type="button" data-untag="' + esc(t) + '" aria-label="Remove tag ' + esc(t) + '">×</button>' : "") + "</span>").join(""); };
  const add = () => {
    for (const raw of input.value.split(",")) {
      const t = raw.trim();
      if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    }
    input.value = ""; draw();
  };
  root.addEventListener("click", (e) => {
    if (e.target.dataset.untag) { tags = tags.filter((x) => x !== e.target.dataset.untag); draw(); }
    else if (e.target.closest(".tagadd button")) add();
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } });
  draw();
  return { get: () => { add(); return tags.slice(); }, set: (v) => { tags = v.slice(); draw(); } };
}
fetch("/api/quotes?limit=1").then((r) => r.json()).then((d) => {
  const list = document.createElement("datalist"); list.id = "usedtags";
  list.innerHTML = (d.tags || []).map((t) => '<option value="' + esc(t.tag) + '">' + esc(t.tag + " (" + t.n + ")") + "</option>").join("");
  document.body.appendChild(list);
}).catch(() => {});
`;

const QUOTE_CSS = `
.tagadd { display: inline-flex; gap: 6px; margin-left: 4px; } .tagadd input { width: 230px; }
.cloud { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 0; }
.cloud button { padding: 2px 9px; border-radius: 999px; font-size: 0.84rem; }
.cloud button[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.cloud .n { color: var(--muted); margin-left: 4px; }
.chip.inherited { background: var(--code); color: var(--muted); }
blockquote { margin: 0; padding: 4px 0 4px 14px; border-left: 3px solid var(--bar); font-size: 0.98rem; white-space: pre-wrap; }
.qmeta { font-size: 0.86rem; color: var(--muted); margin-top: 8px; }
.qcard { margin-bottom: 12px; }
.qcard a.open { float: right; font-size: 0.86rem; }`;

/** /admin/quotes: every saved quote, searchable and filterable. */
export const QUOTES_HTML = page({
  title: "Quotes",
  nav: "quotes",
  css: QUOTE_CSS + `.filters input[name=q] { width: 220px; }`,
  body: `
<h1>Quotes</h1>
<p class="sub" id="summary">Passages saved from the books, checked against the text. Save new ones from a book's reader view.</p>
<form class="filters" id="filters" role="search">
  <input type="search" name="q" placeholder="Words in the quote, note, or labels" aria-label="Search quotes">
  <input type="search" name="category" placeholder="Category" list="vocab" aria-label="Category">
  <input type="search" name="label" placeholder="Tag" list="usedtags" aria-label="Tag">
  <input type="search" name="author" placeholder="Author" aria-label="Author">
  <select name="category_mode" aria-label="Categorization"><option value="">Any categorization</option><option value="undecided">Undecided (to review)</option><option value="book">Book's categories</option><option value="own">Own categories</option><option value="tags_only">No category (tags only)</option></select>
  <select name="status" aria-label="Status"><option value="">Any status</option><option value="verified">Verified</option><option value="orphaned">Orphaned</option></select>
  <button type="button" id="clear">Clear</button>
</form>
<datalist id="vocab"></datalist><datalist id="usedtags"></datalist>
<div class="cloud" id="cloud" aria-label="Tags"></div>
<div id="list" style="margin-top:14px"></div>
<button type="button" class="more" id="more">Load more</button>`,
  script: `
const form = document.getElementById("filters");
const FIELDS = ["q", "category", "label", "author", "category_mode", "status"];
// A quote's categories: undecided (to review), its book's (followed live), or its own.
function categoriesHtml(q) {
  if (q.category_mode === "undecided") return '<span class="badge warn"><span class="sign" aria-hidden="true">?</span>Categories undecided</span>';
  if (q.category_mode === "tags_only") return '<span class="note">No category</span>';
  if (q.category_mode === "book") return q.categories.length ? q.categories.map((t) => '<span class="chip inherited" title="Book’s category: ' + esc(t.tag) + '">' + esc(t.label) + "</span>").join("") : '<span class="note">Book’s categories (none yet)</span>';
  return q.categories.map((t) => tagChip(t.tag)).join("");
}
let offset = 0;
function query() {
  const p = new URLSearchParams();
  for (const f of FIELDS) { const v = form.elements[f].value.trim(); if (v) p.set(f, v); }
  return p;
}
function card(q) {
  return '<article class="card qcard"><a class="open" href="/admin/quotes/' + q.id + '">#' + q.id + " →</a><blockquote>" + esc(q.text.length > 500 ? q.text.slice(0, 500) + "…" : q.text) + "</blockquote>" +
    '<div class="qmeta">' + bookLink(q.book_id, q.title) + " · " + esc(q.locator) + (q.status === "orphaned" ? ' · <span class="badge bad"><span class="sign">!</span>Orphaned</span>' : "") + "</div>" +
    (q.note ? '<p class="note">' + esc(q.note) + "</p>" : "") +
    "<div>" + categoriesHtml(q) + " " + q.labels.map((l) => '<span class="chip muted">' + esc(l) + "</span>").join("") + "</div>" +
    '<div class="qmeta">Saved ' + esc(ago(q.created_at)) + (q.created_by ? " by " + esc(q.created_by) : "") + " · " + esc(q.source) + "</div></article>";
}
async function load(reset) {
  if (reset) { offset = 0; document.getElementById("list").innerHTML = ""; history.replaceState(null, "", location.pathname + (query().toString() ? "?" + query() : "")); }
  const p = query(); p.set("offset", offset); p.set("limit", 50);
  let d;
  try { d = await api("/api/quotes?" + p); } catch (e) { toast(e.message); return; }
  // The tag cloud: every tag in use, most used first; click to filter by it.
  const picked = form.elements.label.value.trim().toLowerCase();
  document.getElementById("cloud").innerHTML = d.tags.map((t) => '<button type="button" data-tag="' + esc(t.tag) + '" aria-pressed="' + (t.tag.toLowerCase() === picked) + '">' + esc(t.tag) + '<span class="n">' + num(t.n) + "</span></button>").join("");
  document.getElementById("usedtags").innerHTML = d.tags.map((t) => '<option value="' + esc(t.tag) + '"></option>').join("");
  const list = document.getElementById("list");
  if (!d.quotes.length && !offset) list.innerHTML = '<p class="empty">No quotes' + (query().toString() ? " match these filters" : " yet. Open a book and choose Read to save one") + ".</p>";
  list.insertAdjacentHTML("beforeend", d.quotes.map(card).join(""));
  offset += d.quotes.length;
  document.getElementById("summary").innerHTML = esc(num(d.total) + " quote" + (d.total === 1 ? "" : "s")) +
    ((d.category_modes.undecided || 0) ? ' · <a href="/admin/quotes?category_mode=undecided">' + num(d.category_modes.undecided) + " with categories undecided</a>" : "") +
    ((d.counts.orphaned || 0) ? " · " + num(d.counts.orphaned) + " orphaned" : "") + (offset < d.total ? " · showing " + num(offset) : "");
  document.getElementById("more").style.display = offset < d.total ? "block" : "none";
}
let timer;
form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => load(true), 300); });
form.addEventListener("submit", (e) => { e.preventDefault(); load(true); });
document.getElementById("clear").addEventListener("click", () => { form.reset(); load(true); });
document.getElementById("more").addEventListener("click", () => load(false));
document.getElementById("cloud").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tag]"); if (!b) return;
  form.elements.label.value = b.getAttribute("aria-pressed") === "true" ? "" : b.dataset.tag;
  load(true);
});
const params = new URLSearchParams(location.search);
for (const f of FIELDS) if (params.has(f)) form.elements[f].value = params.get(f);
VOCAB.then((labels) => {
  document.getElementById("vocab").innerHTML = [...labels].map(([tag, label]) => '<option value="' + esc(label) + '">' + esc(tag) + "</option>").join("");
  load(true);
});`,
});

/** /admin/quotes/<id>: one quote in context, its citation, and editors for its note, categories, and tags. */
export const QUOTE_HTML = page({
  title: "Quote",
  nav: "quotes",
  css: QUOTE_CSS + `
.ctx { color: var(--muted); white-space: pre-wrap; font-size: 0.92rem; }
.quoted { background: var(--chip); color: var(--text); border-radius: 3px; padding: 1px 0; white-space: pre-wrap; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; margin-top: 14px; }
.card h2 { margin: 0 0 8px; font-size: 1rem; }
textarea { width: 100%; min-height: 90px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; align-items: center; }
.row input { flex: 1; min-width: 180px; }`,
  body: `
<p><a href="/admin/quotes">← Quotes</a></p>
<div id="quote"><p class="note">Loading…</p></div>`,
  script: TAG_EDITOR + `
const id = Number(location.pathname.split("/").pop());
let q, canWrite = false, cats = [], mode = "undecided", tagsEd;
function citationText(c) {
  if (!c) return "";
  return [c.author, c.title ? "<em>" + esc(c.title) + "</em>" : "", c.publisher, c.year, c.pages ? "pp. " + c.pages : ""].filter(Boolean).map((x, i) => (i === 1 ? x : esc(x))).join(", ") + ".";
}
function render() {
  document.title = "Quote #" + q.id + " · Corpus Admin";
  const dis = canWrite ? "" : " disabled";
  document.getElementById("quote").innerHTML = "<h1>Quote #" + q.id + "</h1>" +
    '<p class="sub">' + bookLink(q.current_book_id || q.book_id, q.title) + " · " + esc(q.locator) + " · " + (q.status === "orphaned" ? '<span class="badge bad"><span class="sign">!</span>Orphaned: not found in the current file</span>' : '<span class="badge good"><span class="sign">✓</span>Verified</span>') + "</p>" +
    '<div class="card"><span class="ctx">…' + esc(q.context.before) + '</span><span class="quoted">' + esc(q.text) + '</span><span class="ctx">' + esc(q.context.after) + "…</span>" +
    (q.current_book_id ? '<p class="note"><a href="/admin/books/' + encodeURIComponent(q.current_book_id) + "/read?page=" + q.page + "#quote-" + q.id + '">Open in the reader</a></p>' : "") + "</div>" +
    '<div class="cols"><div class="card"><h2>Citation</h2><p>' + citationText(q.citation) + "</p>" + (q.citekey ? '<p class="note">Citekey ' + esc(q.citekey) + "</p>" : "") +
    '<p class="note">Saved ' + esc(when(q.created_at)) + (q.created_by ? " by " + esc(q.created_by) : "") + " (" + esc(q.source) + ")" + (q.updated_at ? " · edited " + esc(ago(q.updated_at)) + (q.updated_by ? " by " + esc(q.updated_by) : "") : "") + "</p></div>" +
    '<div class="card"><h2>Note, categories, labels</h2><textarea id="note" aria-label="Note"' + dis + ">" + esc(q.note || "") + "</textarea>" +
    '<fieldset style="border:0;padding:0;margin:10px 0 0"><legend class="note">Categories</legend>' +
    '<label><input type="radio" name="catmode" value="undecided"' + (mode === "undecided" ? " checked" : "") + dis + "> Undecided — review later</label><br>" +
    '<label><input type="radio" name="catmode" value="book"' + (mode === "book" ? " checked" : "") + dis + "> The book’s categories</label> " +
      (q.book_categories.length ? q.book_categories.map((t) => '<span class="chip inherited" title="' + esc(t.tag) + '">' + esc(t.label) + "</span>").join("") : '<span class="note">(the book has none yet)</span>') + "<br>" +
    '<label><input type="radio" name="catmode" value="own"' + (mode === "own" ? " checked" : "") + dis + "> Categories for this passage</label><br>" +
    '<label><input type="radio" name="catmode" value="tags_only"' + (mode === "tags_only" ? " checked" : "") + dis + "> No category — the tags describe it</label></fieldset>" +
    '<div id="owncats"' + (mode === "own" ? "" : " hidden") + '><div id="cats" style="margin-top:6px"></div><div class="row"><input type="text" id="addcat" list="vocab" placeholder="Add a category" aria-label="Add a category"' + dis + '><button type="button" id="addbtn"' + dis + ">Add</button></div></div>" +
    '<div style="margin-top:10px"><span class="note">Tags</span><div id="tags"></div></div>' +
    '<div class="row"><button type="button" class="primary" id="save"' + dis + '>Save</button><button type="button" class="danger" id="delete"' + dis + ">Delete quote</button></div>" +
    (canWrite ? "" : '<p class="note">Sign in through Cloudflare Access to edit.</p>') + "</div></div>";
  renderCats();
  tagsEd = tagEditor(document.getElementById("tags"), q.labels, canWrite);
}
function renderCats() {
  document.getElementById("cats").innerHTML = cats.length ? cats.map((t) => tagChip(t, canWrite ? '<button type="button" data-remove="' + esc(t) + '" aria-label="Remove">×</button>' : "")).join("") : '<span class="note">No categories.</span>';
}
async function load() {
  try { q = await api("/api/quotes/" + id); } catch (e) { document.getElementById("quote").innerHTML = '<p class="empty">' + esc(e.message) + "</p>"; return; }
  mode = q.category_mode;
  cats = mode === "own" ? q.categories.map((t) => t.tag) : [];
  render();
}
document.getElementById("quote").addEventListener("change", (e) => {
  if (e.target.name !== "catmode") return;
  mode = e.target.value;
  document.getElementById("owncats").hidden = mode !== "own";
  renderCats();
});
document.getElementById("quote").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.remove) { cats = cats.filter((x) => x !== t.dataset.remove); renderCats(); return; }
  try {
    if (t.id === "addbtn") {
      const value = document.getElementById("addcat").value.trim().toLowerCase();
      const match = [...LABELS].find(([tag, label]) => tag === value || label.toLowerCase() === value);
      if (!match) { toast("Not in the vocabulary."); return; }
      if (!cats.includes(match[0])) cats.push(match[0]);
      document.getElementById("addcat").value = ""; renderCats();
    } else if (t.id === "save") {
      if (mode === "own" && !cats.length) { toast("Add a category, or choose another option."); return; }
      await post("/api/quotes/" + id, { note: document.getElementById("note").value,
        ...(mode === "book" ? { use_book_categories: true } : mode === "tags_only" ? { no_category: true } : { categories: mode === "own" ? cats : [] }),
        labels: tagsEd.get() });
      toast("Saved."); load();
    } else if (t.id === "delete") {
      if (!confirm("Delete quote #" + id + "?")) return;
      await post("/api/quotes/" + id + "/delete", {});
      location.href = "/admin/quotes";
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

/** /admin/books/<id>/read: a book's text page by page, with saved quotes highlighted and select-to-quote. */
export const READER_HTML = page({
  title: "Reader",
  nav: "books",
  css: QUOTE_CSS + `
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0 14px; }
.bar input { width: 80px; }
.bar select { max-width: 340px; }
.pg { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; margin-bottom: 12px; }
.pg h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 8px; font-weight: 600; }
.pg .text { white-space: pre-wrap; font-size: 1rem; line-height: 1.65; max-width: 72ch; }
mark { background: color-mix(in srgb, var(--bar) 22%, transparent); color: inherit; border-radius: 2px; cursor: pointer; }
.savebar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--surface); border-top: 1px solid var(--border); box-shadow: 0 -4px 16px rgba(0,0,0,0.12); padding: 12px 16px; display: none; z-index: 5; }
.savebar .inner { max-width: 1200px; margin: 0 auto; display: grid; gap: 8px; }
.savebar .sel { max-height: 90px; overflow: auto; font-size: 0.9rem; border-left: 3px solid var(--bar); padding-left: 10px; white-space: pre-wrap; }
.savebar .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.savebar .row input { flex: 1; min-width: 160px; }`,
  body: `
<p id="back"><a href="/admin/books">← Books</a></p>
<h1 id="title">Reader</h1>
<p class="sub" id="sub"></p>
<div class="bar">
  <button type="button" id="prev">← Previous</button>
  <label class="note">Page <input type="text" id="goto" inputmode="numeric" aria-label="Go to page"></label>
  <select id="chapter" aria-label="Go to chapter"><option value="">Chapters…</option></select>
  <button type="button" id="next">Next →</button>
  <span class="note" id="hint"></span>
</div>
<div id="pages"></div>
<div class="savebar" id="savebar" role="dialog" aria-label="Save quote"><div class="inner">
  <div class="sel" id="selected"></div>
  <div class="row"><input type="text" id="qnote" placeholder="Note (optional)" aria-label="Note">

    </div>
  <div class="row"><span class="note">Tags</span><div id="qtags"></div></div>
  <div class="row note" id="qcatline">Categories:
    <label><input type="radio" name="qmode" value="undecided" checked> Decide later</label>
    <label><input type="radio" name="qmode" value="book"> The book’s <span id="bookcats"></span></label>
    <label><input type="radio" name="qmode" value="own"> Choose</label>
    <label><input type="radio" name="qmode" value="tags_only"> None — tags are enough</label>
    <input type="text" id="qcats" list="vocab" placeholder="Categories for this passage, comma-separated" aria-label="Categories for this passage" hidden></div>
  <div class="row"><button type="button" class="primary" id="qsave">Save as quote</button><button type="button" id="qcancel">Cancel</button><span class="note" id="qmsg"></span></div>
</div></div>`,
  script: TAG_EDITOR + `
const id = decodeURIComponent(location.pathname.split("/").slice(-2)[0]);
const COUNT = 4;
let data, start = Number(new URLSearchParams(location.search).get("page")) || 1, canWrite = false, selection = null, qtags;

function highlighted(p) {
  // Saved quotes on this page, cut from the stored text by their offsets.
  const ranges = data.quotes.map((q) => ({ id: q.id, s: q.start_page === p.page ? q.start_offset : q.start_page < p.page ? 0 : null, e: q.end_page === p.page ? q.end_offset : q.end_page > p.page ? p.text.length : null }))
    .filter((r) => r.s !== null && r.e !== null && r.e > r.s).sort((a, b) => a.s - b.s);
  let out = "", at = 0;
  for (const r of ranges) {
    if (r.s < at) continue;
    out += esc(p.text.slice(at, r.s)) + '<mark id="quote-' + r.id + '" data-quote="' + r.id + '" title="Quote #' + r.id + '">' + esc(p.text.slice(r.s, r.e)) + "</mark>";
    at = r.e;
  }
  return out + esc(p.text.slice(at));
}
async function load() {
  try { data = await api("/api/books/" + encodeURIComponent(id) + "/pages?start=" + start + "&count=" + COUNT); } catch (e) { document.getElementById("pages").innerHTML = '<p class="empty">' + esc(e.message) + "</p>"; return; }
  start = data.start;
  history.replaceState(null, "", location.pathname + "?page=" + start + location.hash);
  const kind = data.page_kind === "location" ? "location" : "page";
  document.title = data.title + " · Reader";
  document.getElementById("back").innerHTML = '<a href="/admin/books/' + encodeURIComponent(data.book_id) + '">← ' + esc(data.title) + "</a>";
  document.getElementById("title").textContent = data.title;
  document.getElementById("sub").textContent = data.authors.join(", ") + " · " + kind + "s " + data.start + "–" + data.end + " of " + data.page_count +
    (data.page_kind === "location" ? " · locations are reading positions, not page numbers" : "");
  document.getElementById("goto").value = start;
  document.getElementById("prev").disabled = start <= 1;
  document.getElementById("next").disabled = data.end >= data.page_count;
  document.getElementById("bookcats").innerHTML = data.categories.length
    ? data.categories.map((t) => '<span class="chip inherited" title="' + esc(t) + '">' + esc(LABELS.get(t) || t) + "</span>").join("")
    : "(none yet)";
  const chapter = document.getElementById("chapter");
  if (chapter.options.length <= 1) chapter.insertAdjacentHTML("beforeend", data.outline.map((o) => '<option value="' + o.page + '">' + (o.level ? "  " : "") + esc(o.title) + "</option>").join(""));
  document.getElementById("pages").innerHTML = data.pages.map((p) => '<section class="pg" data-page="' + p.page + '"><h2>' + kind + " " + p.page + (p.label ? " · printed " + esc(p.label) : "") + (p.section ? " · " + esc(p.section) : "") +
    '</h2><div class="text">' + highlighted(p) + "</div></section>").join("");
  const target = location.hash && document.querySelector(location.hash);
  if (target) target.scrollIntoView({ block: "center" }); else window.scrollTo(0, 0);
}
function go(page) { start = Math.max(1, page); location.hash = ""; load(); }
document.getElementById("prev").addEventListener("click", () => go(start - COUNT));
document.getElementById("next").addEventListener("click", () => go(start + COUNT));
document.getElementById("goto").addEventListener("change", (e) => go(Number(e.target.value) || 1));
document.getElementById("chapter").addEventListener("change", (e) => { if (e.target.value) go(Number(e.target.value)); });
document.getElementById("pages").addEventListener("click", (e) => { const m = e.target.closest("mark[data-quote]"); if (m && !String(window.getSelection())) location.href = "/admin/quotes/" + m.dataset.quote; });

// Select text in the pages, then save it: the server checks it against the book, as it does for agents.
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  const text = String(sel || "").trim();
  const node = sel && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  const focus = sel && sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
  const a = node && node.closest(".pg"), b = focus && focus.closest(".pg");
  if (!text || !a || !b) return;
  selection = { text, page: Math.min(Number(a.dataset.page), Number(b.dataset.page)) };
  document.getElementById("selected").textContent = text.length > 600 ? text.slice(0, 600) + "…" : text;
  document.getElementById("qmsg").textContent = text.length > 2000 ? "Too long: quotes are limited to 2,000 characters." : "";
  document.getElementById("qsave").disabled = !canWrite || text.length > 2000;
  if (!canWrite) document.getElementById("qmsg").textContent = "Sign in through Cloudflare Access to save quotes.";
  document.getElementById("savebar").style.display = "block";
});
document.getElementById("qcatline").addEventListener("change", (e) => {
  if (e.target.name !== "qmode") return;
  const input = document.getElementById("qcats");
  input.hidden = e.target.value !== "own";
  if (!input.hidden) input.focus();
});
document.getElementById("qcancel").addEventListener("click", () => { document.getElementById("savebar").style.display = "none"; window.getSelection().removeAllRanges(); });
document.getElementById("qsave").addEventListener("click", async () => {
  if (!selection) return;
  const split = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const qmode = document.querySelector("input[name=qmode]:checked").value;
  const cats = (qmode === "own" ? split(document.getElementById("qcats").value) : []).map((v) => { const m = [...LABELS].find(([tag, label]) => tag === v.toLowerCase() || label.toLowerCase() === v.toLowerCase()); return m ? m[0] : v; });
  try {
    if (qmode === "own" && !cats.length) { document.getElementById("qmsg").textContent = "Name a category, or choose Decide later."; return; }
    const out = await post("/api/quotes", { book_id: data.book_id, text: selection.text, page: selection.page, note: document.getElementById("qnote").value,
      categories: cats, use_book_categories: qmode === "book", no_category: qmode === "tags_only", labels: qtags.get() });
    if (!out.saved) {
      document.getElementById("qmsg").textContent = out.reason + (out.closest && out.closest.length ? " Closest: page " + out.closest.map((c) => c.page).join(", ") + "." : "");
      return;
    }
    toast("Saved quote #" + out.quote.id + (out.exact ? "." : " (the book's exact wording was used)."));
    document.getElementById("savebar").style.display = "none";
    for (const f of ["qnote", "qcats"]) document.getElementById(f).value = "";
    qtags.set([]);
    document.querySelector("input[name=qmode][value=undecided]").checked = true; document.getElementById("qcats").hidden = true;
    window.getSelection().removeAllRanges();
    load();
  } catch (e) { document.getElementById("qmsg").textContent = e.message; }
});

Promise.all([ME, VOCAB]).then(([me, labels]) => {
  canWrite = me.can_write;
  document.getElementById("hint").textContent = canWrite ? "Select text to save it as a quote." : "Read-only: sign in through Cloudflare Access to save quotes.";
  qtags = tagEditor(document.getElementById("qtags"), [], canWrite);
  const list = document.createElement("datalist"); list.id = "vocab";
  list.innerHTML = [...labels].map(([tag, label]) => '<option value="' + esc(label) + '">' + esc(tag) + "</option>").join("");
  document.body.appendChild(list);
  load();
});`,
});
