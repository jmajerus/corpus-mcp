import { page } from "./layout.js";

/**
 * A chip editor for a new quote's free-form tags, in the reader. Typing offers the tags on the book's quotes
 * (suggestTags), so one theme keeps one spelling; Enter, a comma, or Add adds a tag.
 */
const TAG_EDITOR = `
function tagEditor(root, initial, enabled) {
  let tags = initial.slice();
  root.innerHTML = '<span class="tagchips"></span><span class="tagadd"><input type="text" list="usedtags" placeholder="Add a tag: a theme, a form, a link" aria-label="Add a tag"' + (enabled ? "" : " disabled") + '><button type="button"' + (enabled ? "" : " disabled") + ">Add</button></span>";
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
function suggestTags(tags) {
  let list = document.getElementById("usedtags");
  if (!list) { list = document.createElement("datalist"); list.id = "usedtags"; document.body.appendChild(list); }
  const known = new Set(Array.from(list.options, (o) => o.value));
  for (const t of tags) if (!known.has(t)) { known.add(t); list.insertAdjacentHTML("beforeend", '<option value="' + esc(t) + '">'); }
}
`;

const QUOTE_CSS = `
.tagadd { display: inline-flex; gap: 6px; margin-left: 4px; } .tagadd input { width: 230px; }`;

/**
 * /admin/books/<id>/read: a book's text page by page, with its quotes from quote-mcp highlighted, and
 * select-to-quote, saved to quote-mcp. A highlight opens the quote in quote-mcp's admin, to edit or delete.
 */
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
  <div class="row"><input type="text" id="qnote" placeholder="Note (optional)" aria-label="Note"></div>
  <div class="row"><span class="note">Tags</span><div id="qtags"></div></div>
  <div class="row"><button type="button" class="primary" id="qsave">Save as quote</button><button type="button" id="qcancel">Cancel</button><span class="note" id="qmsg"></span></div>
</div></div>`,
  script: TAG_EDITOR + `
const id = decodeURIComponent(location.pathname.split("/").slice(-2)[0]);
const COUNT = 4;
let data, start = Number(new URLSearchParams(location.search).get("page")) || 1, canWrite = false, selection = null, qtags;
const hint = () => (canWrite ? "Select text to save it as a quote." : "Read-only: sign in through Cloudflare Access to save quotes.");

function highlighted(p) {
  // Saved quotes on this page, cut from the stored text by their offsets.
  const ranges = data.quotes.map((q) => ({ id: q.id, title: ["Quote #" + q.id, q.comment, q.tags.join(", ")].filter(Boolean).join(" · "), s: q.start_page === p.page ? q.start_offset : q.start_page < p.page ? 0 : null, e: q.end_page === p.page ? q.end_offset : q.end_page > p.page ? p.text.length : null }))
    .filter((r) => r.s !== null && r.e !== null && r.e > r.s).sort((a, b) => a.s - b.s);
  let out = "", at = 0;
  for (const r of ranges) {
    if (r.s < at) continue;
    out += esc(p.text.slice(at, r.s)) + '<mark id="quote-' + r.id + '" data-quote="' + r.id + '" title="' + esc(r.title) + '">' + esc(p.text.slice(r.s, r.e)) + "</mark>";
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
  const chapter = document.getElementById("chapter");
  if (chapter.options.length <= 1) chapter.insertAdjacentHTML("beforeend", data.outline.map((o) => '<option value="' + o.page + '">' + (o.level ? "  " : "") + esc(o.title) + "</option>").join(""));
  suggestTags(data.quote_tags);
  document.getElementById("hint").textContent = data.quotes_error ? "Quotes not shown: " + data.quotes_error : hint();
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
  // One request id per selection, so saving it twice (a retry, a double press) saves one quote; the same words
  // selected somewhere else, or again once the bar has closed, are a new selection with a new id.
  const page = Math.min(Number(a.dataset.page), Number(b.dataset.page));
  const where = page + ":" + Math.min(sel.anchorOffset, sel.focusOffset) + ":" + text;
  if (!selection || selection.where !== where) selection = { text, page, where, request_id: "reader-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) };
  document.getElementById("selected").textContent = text.length > 600 ? text.slice(0, 600) + "…" : text;
  document.getElementById("qmsg").textContent = text.length > 2000 ? "Too long: quotes are limited to 2,000 characters." : "";
  document.getElementById("qsave").disabled = !canWrite || text.length > 2000;
  if (!canWrite) document.getElementById("qmsg").textContent = "Sign in through Cloudflare Access to save quotes.";
  document.getElementById("savebar").style.display = "block";
});
document.getElementById("qcancel").addEventListener("click", () => { document.getElementById("savebar").style.display = "none"; selection = null; window.getSelection().removeAllRanges(); });
document.getElementById("qsave").addEventListener("click", async () => {
  if (!selection) return;
  try {
    const out = await post("/api/books/" + encodeURIComponent(data.book_id) + "/quotes", { text: selection.text, page: selection.page, comment: document.getElementById("qnote").value, tags: qtags.get(), request_id: selection.request_id });
    if (!out.saved && !out.already) {
      document.getElementById("qmsg").textContent = out.reason + (out.closest && out.closest.length ? " Closest: page " + out.closest.map((c) => c.page).join(", ") + "." : "");
      return;
    }
    toast(out.already ? "Already saved, as quote #" + out.quote.id + "." : "Saved quote #" + out.quote.id + " in quote-mcp" + (out.warnings.length ? ": " + out.warnings.join(" ") : "."));
    document.getElementById("savebar").style.display = "none";
    document.getElementById("qnote").value = "";
    qtags.set([]);
    selection = null;
    window.getSelection().removeAllRanges();
    load();
  } catch (e) { document.getElementById("qmsg").textContent = e.message; }
});

ME.then((me) => {
  canWrite = me.can_write;
  document.getElementById("hint").textContent = hint();
  qtags = tagEditor(document.getElementById("qtags"), [], canWrite);
  load();
});`,
});
