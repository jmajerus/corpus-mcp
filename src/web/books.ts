import { page } from "./layout.js";

/** /admin/books: every book, filterable by metadata and by derived state. */
export const BOOKS_HTML = page({
  title: "Books",
  nav: "books",
  css: `
.title small { display: block; color: var(--muted); }
td.state { min-width: 170px; }
.filters input[name=q] { width: 220px; } .filters input[name=tag] { width: 160px; }`,
  body: `
<h1>Books</h1>
<p class="sub" id="summary">Loading…</p>
<form class="filters" id="filters" role="search">
  <input type="search" name="q" placeholder="Title, author, id, ISBN, or citekey" aria-label="Search">
  <select name="library" aria-label="Library"><option value="">Any library</option></select>
  <select name="shelf" aria-label="Shelf"><option value="">Any shelf</option></select>
  <input type="search" name="tag" placeholder="Category or tag" aria-label="Category or tag" list="vocab">
  <select name="sort" aria-label="Sort"><option value="title">Title</option><option value="year">Newest first</option><option value="id">Calibre id</option></select>
  <button type="button" id="clear">Clear</button>
</form>
<datalist id="vocab"></datalist>
<div class="facets" id="facets"></div>
<div class="scroll"><table><thead><tr><th>Book</th><th class="num">Year</th><th>Format</th><th>Shelves</th><th>Categories</th><th>State</th></tr></thead><tbody id="rows"></tbody></table></div>
<button type="button" class="more" id="more">Load more</button>`,
  script: `
const form = document.getElementById("filters");
const FACETS = [["category", "Categories"], ["citekey", "Citekey"], ["isbn", "ISBN"], ["year", "Year"], ["author", "Author"], ["problem", "Problems"], ["format", "Format"], ["status", "Status"]];
const TEXT = ["q", "library", "shelf", "tag", "sort"];
let picked = {}, offset = 0;

function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const name of TEXT) if (p.has(name)) form.elements[name].value = p.get(name);
  picked = {};
  for (const [key] of FACETS) if (p.get(key)) picked[key] = p.get(key);
}
function query(extra) {
  const p = new URLSearchParams();
  for (const name of TEXT) { const v = form.elements[name].value.trim(); if (v && !(name === "sort" && v === "title")) p.set(name, v); }
  for (const [k, v] of Object.entries(picked)) p.set(k, v);
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p;
}
function facetLabel(group, key) {
  if (STATES[group] && STATES[group][key]) return STATES[group][key][0];
  return key === "none" ? "None" : String(key).replace("_", " ");
}
function row(b) {
  const states = [badge("category", b.category_state), badge("citekey", b.citekey_state), badge("isbn", b.isbn_state), badge("year", b.year_state), badge("author", b.author_state)].concat(b.problems.map((p) => badge("problem", p)));
  return "<tr><td class=" + '"title"' + ">" + bookLink(b.book_id, b.title) + "<small>" + esc(b.authors.join(", ")) + " · " + esc(b.book_id) + (b.citekey ? " · " + esc(b.citekey) : "") + "</small></td>" +
    '<td class="num">' + esc(b.year ?? "") + "</td><td>" + esc((b.format || "–").toUpperCase()) + (b.pages ? '<br><span class="note">' + num(b.pages) + "</span>" : "") + "</td>" +
    "<td>" + b.shelves.map((s) => '<span class="chip muted">' + esc(s) + "</span>").join("") + "</td>" +
    "<td>" + b.categories.map((c) => tagChip(c.tag)).join("") + (b.other_tags ? '<span class="note">+' + b.other_tags + " other</span>" : "") + "</td>" +
    '<td class="state">' + states.join("") + "</td></tr>";
}
async function load(reset) {
  if (reset) { offset = 0; document.getElementById("rows").innerHTML = ""; history.replaceState(null, "", location.pathname + (query().toString() ? "?" + query() : "")); }
  let data;
  try { data = await api("/api/books?" + query({ offset, limit: 100 })); } catch (e) { toast(e.message); return; }
  if (reset) {
    document.getElementById("facets").innerHTML = FACETS.map(([key, title]) => {
      const counts = data.facets[key] || {};
      const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      if (picked[key] && !keys.includes(picked[key])) keys.push(picked[key]);
      return '<div class="facet"><span>' + esc(title) + "</span>" + keys.map((k) => '<button type="button" data-facet="' + key + '" data-value="' + esc(k) + '" aria-pressed="' + (picked[key] === k) + '">' +
        esc(facetLabel(key, k)) + '<span class="n">' + num(counts[k] || 0) + "</span></button>").join("") + "</div>";
    }).join("");
    const lib = form.elements.library, current = lib.value;
    lib.innerHTML = '<option value="">Any library</option>' + data.libraries.map((l) => '<option value="' + esc(l) + '">' + esc(l) + "</option>").join("");
    lib.value = current;
  }
  const rows = document.getElementById("rows");
  if (!data.rows.length && !offset) rows.innerHTML = '<tr><td colspan="6" class="empty">No books match these filters.</td></tr>';
  rows.insertAdjacentHTML("beforeend", data.rows.map(row).join(""));
  offset += data.rows.length;
  document.getElementById("summary").textContent = num(data.total) + " book" + (data.total === 1 ? "" : "s") + (offset < data.total ? " · showing " + num(offset) : "");
  document.getElementById("more").style.display = offset < data.total ? "block" : "none";
}
let timer;
form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => load(true), 300); });
form.addEventListener("submit", (e) => { e.preventDefault(); load(true); });
document.getElementById("clear").addEventListener("click", () => { form.reset(); picked = {}; load(true); });
document.getElementById("facets").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-facet]"); if (!b) return;
  if (picked[b.dataset.facet] === b.dataset.value) delete picked[b.dataset.facet]; else picked[b.dataset.facet] = b.dataset.value;
  load(true);
});
document.getElementById("more").addEventListener("click", () => load(false));
readUrl();
Promise.all([VOCAB, api("/api/shelves").catch(() => ({ shelves: [] }))]).then(([labels, shelves]) => {
  document.getElementById("vocab").innerHTML = [...labels].map(([tag, label]) => '<option value="' + esc(tag) + '">' + esc(label) + "</option>").join("");
  const shelf = form.elements.shelf, current = new URLSearchParams(location.search).get("shelf") || "";
  shelf.innerHTML = '<option value="">Any shelf</option>' + shelves.shelves.map((s) => '<option value="' + esc(s.name) + '">' + esc(s.name) + "</option>").join("");
  shelf.value = current;
  load(true);
});`,
});
