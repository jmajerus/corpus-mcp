import { page } from "./layout.js";

/** /admin/categories: the vocabulary as a tree, with book counts, how Calibre's tags stand against it, and the other tags. */
export const CATEGORIES_HTML = page({
  title: "Categories",
  nav: "categories",
  css: `
.tree details { margin: 0; }
.tree summary, .tree .leaf { display: flex; justify-content: space-between; gap: 12px; padding: 5px 10px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
.tree summary { cursor: pointer; list-style: revert; }
.tree .count { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
.tree .count a { text-decoration: none; }
.tree .zero { color: var(--muted); }
.tree .bar { display: inline-block; height: 8px; border-radius: 0 4px 4px 0; background: var(--bar); margin-left: 8px; vertical-align: middle; }`,
  body: `
<h1>Categories</h1>
<p class="sub" id="summary">Loading…</p>
<div class="card tree" id="tree" style="padding:0"></div>
<h2>Against the vocabulary</h2>
<p class="note" id="vocab"></p>
<div id="report"></div>
<h2>Other tags</h2>
<p class="note">Tags outside the vocabulary. Edit them in Calibre-Web; the dashboard's cleanup job removes the ones flagged ⚠.</p>
<div class="scroll"><table><thead><tr><th>Tag</th><th class="num">Books</th><th>Flag</th></tr></thead><tbody id="free"></tbody></table></div>`,
  script: `
let max = 1;
function node(n, depth) {
  const count = (n.total ? '<a href="/admin/books?tag=' + encodeURIComponent(n.tag) + '">' + num(n.total) + " book" + (n.total === 1 ? "" : "s") + "</a>" : '<span class="zero">0</span>') +
    (n.children.length && n.books ? ' <span class="note">(' + num(n.books) + " directly)</span>" : "") +
    (n.total ? '<span class="bar" style="width:' + Math.max(2, Math.round(80 * n.total / max)) + 'px" aria-hidden="true"></span>' : "");
  const label = '<span style="padding-left:' + depth * 16 + 'px" title="' + esc(n.tag) + '">' + esc(n.name) + "</span>";
  if (!n.children.length) return '<div class="leaf">' + label + '<span class="count">' + count + "</span></div>";
  return "<details" + (depth === 0 && n.total ? " open" : "") + "><summary>" + label + '<span class="count">' + count + "</span></summary>" + n.children.map((c) => node(c, depth + 1)).join("") + "</details>";
}
api("/api/categories").then((d) => {
  max = Math.max(1, ...d.tree.map((n) => n.total));
  document.getElementById("summary").innerHTML = num(d.categorized) + " of " + num(d.books) + ' books have a category · <a href="/admin/books?category=uncategorized">' + num(d.uncategorized) + " uncategorized</a>";
  document.getElementById("tree").innerHTML = d.tree.map((n) => node(n, 0)).join("");
  document.getElementById("free").innerHTML = d.free.length ? d.free.map((t) => '<tr><td><a href="/admin/books?tag=' + encodeURIComponent(t.tag) + '">' + esc(t.tag) + '</a></td><td class="num">' + num(t.books) + "</td><td>" + (t.suspect ? "⚠ " + esc(t.suspect) : "") + "</td></tr>").join("")
    : '<tr><td colspan="3" class="empty">None.</td></tr>';
}).catch((e) => toast(e.message));
const bookList = (books) => books.slice(0, 12).map((b) => bookLink(b.book_id, b.title)).join(", ") + (books.length > 12 ? " and " + num(books.length - 12) + " more" : "");
api("/api/vocabulary/report").then((r) => {
  const v = r.vocabulary;
  document.getElementById("vocab").innerHTML = (v.error ? '<span class="badge bad"><span class="sign">!</span>' + esc(v.error) + "</span> " : "") +
    "Vocabulary " + esc(v.version || "(no version)") + (v.generated_at ? ", generated " + esc(when(v.generated_at)) : "") + ": " + num(v.assignable) + " assignable terms of " + num(v.terms) + ". corpus-mcp reads it and never edits it.";
  const table = (title, note, head, rows) => "<h3>" + esc(title) + '</h3><p class="note">' + esc(note) + '</p><div class="scroll"><table><thead><tr>' + head.map((h) => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" +
    (rows.length ? rows.join("") : '<tr><td colspan="' + head.length + '" class="empty">None.</td></tr>') + "</tbody></table></div>";
  document.getElementById("report").innerHTML =
    table("Retired terms still in Calibre", "Automatic: the tags job swaps in the replacement. Review: the term was split or dropped; choose on each book's page.", ["Tag", "Replaced by", "Action", "Books"],
      r.retired_in_use.map((t) => "<tr><td>" + esc(t.tag) + "</td><td>" + (t.replaced_by.map((x) => tagChip(x)).join("") || '<span class="note">nothing</span>') + "</td><td>" + esc(t.action) + "</td><td>" + bookList(t.books) + "</td></tr>")) +
    table("Unknown terms", "Calibre tags shaped like vocabulary ids that the vocabulary does not have.", ["Tag", "Why", "Books"],
      r.unknown_terms.map((t) => "<tr><td>" + esc(t.tag) + "</td><td>" + esc(t.reason) + "</td><td>" + bookList(t.books) + "</td></tr>")) +
    table("Tagged only broadly", "Books tagged at a term with narrower terms below it: candidates for a narrower tag, and, when many stop at one term, a hint that the taxonomy needs another.", ["Term", "Narrower terms", "Books"],
      r.tagged_only_broadly.map((t) => "<tr><td>" + tagChip(t.tag) + '</td><td class="num">' + num(t.narrower) + "</td><td>" + num(t.books.length) + ": " + bookList(t.books) + "</td></tr>"));
}).catch((e) => toast(e.message));`,
});

/** /admin/citekeys: pinned keys, and how many books are ready or blocked. */
export const CITEKEYS_HTML = page({
  title: "Citekeys",
  nav: "citekeys",
  body: `
<h1>Citekeys</h1>
<p class="sub">Keys Concept Clusters assigned when it filed a book in Zotero. Pin, replace, or unpin a key on the book's page.</p>
<div class="grid" id="cards"></div>
<h2>Pinned</h2>
<div class="scroll"><table><thead><tr><th>Citekey</th><th>Book</th><th>Pinned</th><th>By</th><th>Note</th></tr></thead><tbody id="pinned"></tbody></table></div>`,
  script: `
const link = (state, text) => '<a href="/admin/books?citekey=' + state + '">' + text + "</a>";
Promise.all([api("/api/citekeys"), api("/api/books?limit=1")]).then(([k, books]) => {
  const f = books.facets.citekey || {};
  document.getElementById("cards").innerHTML = [["pinned", "Pinned"], ["calibre", "Set in Calibre"], ["ready", "Ready to file"], ["blocked", "Blocked"]].map(([state, title]) =>
    '<div class="card"><h3>' + esc(title) + '</h3><div class="big">' + link(state, num(f[state] || 0)) + "</div></div>").join("");
  document.getElementById("pinned").innerHTML = k.pinned.length ? k.pinned.map((p) => "<tr><td><strong>" + esc(p.citekey) + "</strong></td><td>" +
    (p.current_book_id ? bookLink(p.current_book_id, p.current_title) : esc(p.title) + ' <span class="note">(no longer in the index)</span>') + "</td><td>" + esc(ago(p.pinned_at)) + "</td><td>" + esc(p.pinned_by || "") + "</td><td>" +
    (p.proposed && p.proposed !== p.citekey && !p.citekey.startsWith(p.proposed) ? '<span class="note">proposed ' + esc(p.proposed) + "</span>" : "") + "</td></tr>").join("")
    : '<tr><td colspan="5" class="empty">No pinned citekeys.</td></tr>';
}).catch((e) => toast(e.message));`,
});

/** /admin/shelves: Calibre-Web's public shelves. */
export const SHELVES_HTML = page({
  title: "Shelves",
  nav: "shelves",
  body: `
<h1>Shelves</h1>
<p class="sub" id="summary">Calibre-Web's public shelves, synced every refresh. Edit them in Calibre-Web.</p>
<div class="scroll"><table><thead><tr><th>Shelf</th><th class="num">Books</th><th class="num">Indexed</th></tr></thead><tbody id="rows"></tbody></table></div>`,
  script: `
api("/api/shelves").then((d) => {
  document.getElementById("summary").textContent = "Calibre-Web's public shelves, synced every refresh (last export " + ago(d.exported_at) + "). Edit them in Calibre-Web.";
  document.getElementById("rows").innerHTML = d.shelves.length ? d.shelves.map((s) => '<tr><td><a href="/admin/books?shelf=' + encodeURIComponent(s.name) + '">' + esc(s.name) + '</a></td><td class="num">' + num(s.books) + '</td><td class="num">' + num(s.indexed_books) + "</td></tr>").join("")
    : '<tr><td colspan="3" class="empty">No shelves synced.</td></tr>';
}).catch((e) => toast(e.message));`,
});
