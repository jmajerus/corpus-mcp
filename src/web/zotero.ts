import { page } from "./layout.js";

/** /admin/zotero: the read-only Zotero mirror, and how Calibre's books stand against it. */
export const ZOTERO_HTML = page({
  title: "Zotero",
  nav: "zotero",
  css: `
.status-ok { color: var(--ok); } .status-bad { color: var(--danger); }
td .cand { margin: 2px 0; }`,
  body: `
<h1>Zotero</h1>
<p class="sub" id="summary">Loading…</p>
<div class="grid" id="cards"></div>
<h2>Possible matches</h2>
<p class="note">Same title, first author, and year, but nothing ties them together. Confirming one pins its citekey.</p>
<div class="scroll"><table><thead><tr><th>Book</th><th>Zotero item</th></tr></thead><tbody id="candidates"></tbody></table></div>
<h2>Citekey mismatches</h2>
<p class="note">The book's pinned or Calibre key differs from the key Zotero holds. Fix whichever is wrong; corpus-mcp never changes a pin on its own.</p>
<div class="scroll"><table><thead><tr><th>Book</th><th>Here</th><th>In Zotero</th><th>Item</th></tr></thead><tbody id="mismatches"></tbody></table></div>
<h2>Possible duplicates in Zotero</h2>
<p class="note">A matched book whose title (without a subtitle) and first author also belong to other items: perhaps a second copy filed by mistake. Merge them in Zotero, keeping the item with the key you cite; "Not a duplicate" hides an item (another edition, say) for this book.</p>
<div class="scroll"><table><thead><tr><th>Book</th><th>Matched item</th><th>Also in Zotero</th></tr></thead><tbody id="duplicates"></tbody></table></div>
<h2>Matched, without a citekey</h2>
<div class="scroll"><table><thead><tr><th>Book</th><th>Item</th><th>Matched</th></tr></thead><tbody id="nokey"></tbody></table></div>`,
  script: `
let canWrite = false;
const how = { calibre_uuid: "Calibre UUID", isbn: "ISBN", confirmed: "confirmed" };
const empty = (cols, text) => '<tr><td colspan="' + cols + '" class="empty">' + esc(text) + "</td></tr>";
async function load() {
  let r;
  try { r = await api("/api/zotero"); } catch (e) { toast(e.message); return; }
  const s = r.sync;
  if (!r.configured) {
    document.getElementById("summary").innerHTML = "Zotero is not configured. Set CORPUS_ZOTERO_LIBRARY (users/&lt;id&gt;) and a read-only CORPUS_ZOTERO_API_KEY in /etc/corpus-mcp/env, then restart corpus-mcp.";
  } else {
    document.getElementById("summary").innerHTML = "Library " + esc(r.library) + " · synced " + esc(ago(s.synced_at)) + (s.every_minutes ? " · every " + num(s.every_minutes) + " min" : "") +
      (s.error ? ' · <span class="status-bad">last error: ' + esc(s.error) + "</span>" : "") +
      ' · <button type="button" id="sync"' + (canWrite ? "" : " disabled") + ">Sync now</button>";
  }
  const b = r.books;
  const card = (title, big, rows) => '<div class="card"><h3>' + esc(title) + '</h3><div class="big">' + big + '</div><div class="rows">' + rows.map(([k, v]) => "<div><span>" + k + "</span><span>" + v + "</span></div>").join("") + "</div></div>";
  document.getElementById("cards").innerHTML =
    card("In Zotero", num(b.calibre_uuid + b.isbn + b.confirmed) + " of " + num(b.total), [["By Calibre UUID", num(b.calibre_uuid)], ["By ISBN", num(b.isbn)], ["Confirmed", num(b.confirmed)]]) +
    card("To check", num(b.candidates + r.mismatches.length + r.duplicates.length), [["Possible matches", num(b.candidates)], ["Mismatched keys", num(r.mismatches.length)],
      ["Possible duplicates", num(r.duplicates.length)], ["Not found", num(b.not_found)]]) +
    card("Mirror", num(s.items) + " items", [["Library version", s.version ? num(s.version) : "—"], ["In the trash", num(s.trashed)]]);
  const dis = canWrite ? "" : " disabled";
  document.getElementById("candidates").innerHTML = r.candidates.length ? r.candidates.map((c) => "<tr><td>" + bookLink(c.book_id, c.title) + (c.year ? " (" + c.year + ")" : "") + "</td><td>" +
    c.candidates.map((x) => '<div class="cand">' + esc(x.key) + " " + esc(x.title || "") + (x.year ? " (" + x.year + ")" : "") + (x.citekey ? " · " + esc(x.citekey) : "") +
      ' <button type="button" data-book="' + esc(c.book_id) + '" data-zkey="' + esc(x.key) + '" data-zaction="confirm"' + dis + ">This book</button>" +
      ' <button type="button" data-book="' + esc(c.book_id) + '" data-zkey="' + esc(x.key) + '" data-zaction="reject"' + dis + ">Not this book</button></div>").join("") + "</td></tr>").join("")
    : empty(2, "None.");
  document.getElementById("mismatches").innerHTML = r.mismatches.length ? r.mismatches.map((m) => "<tr><td>" + bookLink(m.book_id, m.title) + "</td><td>" + esc(m.pinned || m.calibre) +
    ' <span class="note">' + (m.pinned ? "pinned" : "Calibre") + "</span></td><td>" + esc(m.zotero_citekey) + "</td><td>" + esc(m.zotero_key) + "</td></tr>").join("") : empty(4, "None.");
  document.getElementById("duplicates").innerHTML = r.duplicates.length ? r.duplicates.map((d) => "<tr><td>" + bookLink(d.book_id, d.title) + "</td><td>" + esc(d.zotero_key) +
    (d.citekey ? " · " + esc(d.citekey) : "") + ' <span class="note">' + esc(how[d.matched_by] || d.matched_by) + "</span></td><td>" +
    d.duplicates.map((x) => '<div class="cand">' + esc(x.key) + " " + esc(x.title || "") + (x.year ? " (" + x.year + ")" : "") + (x.citekey ? " · " + esc(x.citekey) : "") +
      ' <button type="button" data-book="' + esc(d.book_id) + '" data-zkey="' + esc(x.key) + '" data-zaction="reject"' + dis + ">Not a duplicate</button></div>").join("") + "</td></tr>").join("")
    : empty(3, "None.");
  document.getElementById("nokey").innerHTML = r.no_citekey.length ? r.no_citekey.map((m) => "<tr><td>" + bookLink(m.book_id, m.title) + "</td><td>" + esc(m.zotero_key) + "</td><td>" + esc(how[m.matched_by] || m.matched_by) + "</td></tr>").join("") : empty(3, "None.");
}
document.addEventListener("click", async (e) => {
  const t = e.target;
  try {
    if (t.id === "sync") {
      const job = await post("/api/admin/jobs", { kind: "zotero", mode: "apply" });
      location.href = "/admin/jobs/" + job.id;
    } else if (t.dataset.zkey) {
      const out = await post("/api/zotero/link", { book_id: t.dataset.book, key: t.dataset.zkey, action: t.dataset.zaction });
      toast(t.dataset.zaction === "confirm" ? "Linked" + (out.pinned.length ? " and pinned " + out.pinned.join(", ") : "") + "." : "Hidden for this book."); load();
    }
  } catch (err) { toast(err.message); }
});
ME.then((me) => { canWrite = me.can_write; load(); });`,
});
