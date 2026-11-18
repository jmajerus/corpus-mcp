import { page } from "./layout.js";

/** /admin/upload: stage ebook files, check for duplicates before they reach Calibre, and preview/apply additions. */
export const UPLOAD_HTML = page({
  title: "Upload",
  nav: "upload",
  css: `
.dropzone { border: 2px dashed var(--border); border-radius: 10px; background: var(--surface); padding: 20px; text-align: center; margin: 12px 0; transition: border-color 0.15s, background 0.15s; }
.dropzone.over { border-color: var(--accent); background: var(--chip); }
.dropzone p { margin: 6px 0; }
.item { margin: 16px 0; }
.item-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
.compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin: 12px 0; }
.cover { float: right; width: 70px; max-height: 110px; object-fit: contain; }
.found-cover { display: flex; gap: 12px; align-items: flex-start; margin: 10px 0; }
.found-cover img { width: 90px; max-height: 140px; object-fit: contain; border: 1px solid var(--border); }
.actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.warning { color: var(--warn); }
.member { border-left: 3px solid var(--border); padding-left: 10px; }
.member.target { border-left-color: var(--ok); }
.choice { display: flex; gap: 16px; flex-wrap: wrap; margin: 10px 0; }
.contents td, .contents th { text-align: right; }
.contents th:first-child { text-align: left; }
.contents td.short { color: var(--warn); font-weight: 600; }
.batch { position: sticky; top: 0; z-index: 2; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin: 12px 0; }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 10px 0; }
.fields label { display: flex; flex-direction: column; gap: 4px; font-size: 0.86rem; color: var(--muted); }
.fields input, .fields select { width: 100%; }
`,
  body: `
<h1>Upload books to Calibre</h1>
<p class="sub">Stage ebook files (.epub, .pdf, .mobi, .azw, .azw3, .prc, .kfx, .kfx-zip) to check them against the library by file hash, ISBN/ASIN, and title and authors before anything is added to Calibre, comparing EPUB/PDF contents when a candidate match is found. Exact duplicates are blocked; when a book is already in the library without the uploaded format, you can attach the new format to the existing record instead of creating a duplicate. MOBI, AZW, AZW3, PRC, KFX, and KFX-ZIP files are decrypted through DeDRM and converted to EPUB or PDF on apply. Files from the master directory are staged from <a href="/admin/intake">Intake</a>.</p>
<div class="actions">
  <button type="button" id="refresh-source" disabled>Refresh from Calibre</button>
  <span id="freshness" class="note"></span>
</div>
<p id="refresh-status" role="status" aria-live="polite"></p>
<div class="dropzone" id="dropzone">
  <input type="file" id="file-input" multiple accept=".epub,.pdf,.mobi,.azw,.azw3,.prc,.kfx,.kfx-zip" hidden>
  <p><button type="button" class="primary" id="choose-files" disabled>Choose ebook files…</button></p>
  <p class="note" id="drop-note">Or drop .epub, .pdf, .mobi, .azw, .azw3, .prc, .kfx, or .kfx-zip files here.</p>
</div>
<datalist id="vocab"></datalist>
<div class="batch actions">
  <button type="button" id="select-ready" disabled>Select all ready</button>
  <button type="button" id="select-none" disabled>Clear selection</button>
  <button type="button" id="clear-staged" class="danger" disabled>Remove all staged</button>
  <button type="button" id="preview-batch" class="primary" disabled>Preview selected</button>
  <span id="batch-size" class="note"></span>
  <span id="count" class="note"></span>
</div>
<div id="items">Loading…</div>`,
  script: `
let items = [], picked = {}, freshPick = {}, canWrite = false, calibreWebUrl = null, writableLibrary = null, refreshRunning = false, pendingTimer = null, batchLimit = 250 * 1024 * 1024;

const coverPending = (it) => (it.cover || {}).status === "pending";
const pending = (it) => (it.contents_pending || []).length > 0 || coverPending(it);
function schedulePoll() {
  clearTimeout(pendingTimer);
  if (items.some(pending)) pendingTimer = setTimeout(() => { if (!document.hidden) load(); }, 3000);
}

/** The cover a new book will get: one found for it (with a box to untick), or a note that it will be plain. */
function coverHtml(it, idx) {
  const c = it.cover || {};
  if (c.status === "found") {
    const from = c.source === "otl"
      ? 'from the Open Textbook Library' + (c.page_url ? ' (<a href="' + esc(c.page_url) + '" target="_blank" rel="noopener">' + esc(c.label || "book page") + "</a>)" : "")
      : "from <code>" + esc(c.label || "an image") + "</code> beside it in the intake folder";
    return '<div class="found-cover"><img src="' + esc(c.url) + '" alt="Cover found for ' + esc(it.draft.title) + '" loading="lazy">' +
      '<div><label><input type="checkbox" data-cover="' + idx + '"' + (c.use ? " checked" : "") + (canWrite ? "" : " disabled") + "> Use this cover</label>" +
      '<p class="note">Found ' + from + ". " + (c.source === "otl" ? "This file's own first page is a plain title page." : "") + "</p></div></div>";
  }
  if (c.status === "plain") {
    return '<p class="note">Calibre will make a plain white cover from this file’s title page' + (c.error ? " (the Open Textbook Library couldn’t be reached: " + esc(c.error) + ")" : "; the Open Textbook Library doesn’t list it") +
      ". To give it a cover, save an image whose name includes the title next to the file in the intake folder and stage it again.</p>";
  }
  return "";
}
const actionable = (it) => canWrite && !it.blockers.length && !pending(it) && (it.draft.action === "add_book" || it.draft.action === "add_format");

function initItem(it) {
  if (!actionable(it)) {
    picked[it.id] = false;
    return;
  }
  if (picked[it.id] === undefined || (picked[it.id] === false && (it.was_pending || it.became_ready))) {
    picked[it.id] = true;
    freshPick[it.id] = true;
  }
  it.was_pending = false;
  it.became_ready = false;
}

/** A new batch arrives already checked, up to the preview limit. Later files wait for the next preview. */
function keepSelectionWithinLimit() {
  let total = items.reduce((sum, it) => sum + (picked[it.id] && actionable(it) ? it.size : 0), 0);
  for (let i = items.length - 1; i >= 0 && total > batchLimit; i--) {
    const it = items[i];
    if (!freshPick[it.id] || !picked[it.id] || !actionable(it)) continue;
    picked[it.id] = false;
    total -= it.size;
  }
  freshPick = {};
}

function formatPlanBadge(it) {
  if (it.converts_to && it.converts_to !== it.format) {
    return '<span class="badge good"><span class="sign" aria-hidden="true">→</span>' + esc(it.format + " + " + it.converts_to) + "</span>";
  }
  return '<span class="badge">' + esc(it.format) + "</span>";
}

function statusBadge(it) {
  if (it.exact_matches && it.exact_matches.length) {
    return '<span class="badge bad"><span class="sign" aria-hidden="true">!</span>Identical file in Calibre</span>';
  }
  if (it.blockers && it.blockers.length) {
    return '<span class="badge bad"><span class="sign" aria-hidden="true">!</span>Blocked</span>';
  }
  if (it.matches && it.matches.length) {
    const canAdd = it.matches.some((m) => m.can_add_format);
    return canAdd
      ? '<span class="badge warn"><span class="sign" aria-hidden="true">+</span>Matches existing book · new format (' + esc(it.primary_format) + ")</span>"
      : '<span class="badge warn"><span class="sign" aria-hidden="true">?</span>Matches existing book · ' + esc(it.primary_format) + " already in library</span>";
  }
  if (it.staged_matches && it.staged_matches.length) {
    return '<span class="badge warn"><span class="sign" aria-hidden="true">?</span>Same book as another staged file</span>';
  }
  return '<span class="badge good"><span class="sign" aria-hidden="true">✓</span>New book</span>';
}

/** Which other staged files look like the same book, and what to do about it. */
function stagedMatchNote(it) {
  const sm = it.staged_matches || [];
  if (!sm.length) return "";
  const list = sm.map((m) => esc(m.filename) + " (" + esc(m.evidence.join(", ")) + ")").join("; ");
  const earlier = sm.filter((m) => m.earlier);
  // A file becomes a new format of the other's book only when that book won't already have its format.
  let advice;
  if (earlier.length) {
    const first = earlier[0];
    advice = "Add " + esc(first.filename) + " first. " + (first.target_formats.includes(it.primary_format)
      ? "That gives the book " + esc(it.primary_format) + " already, so skip this file, or add it then as a separate book if it's another edition."
      : "Once it's applied, this file is offered as a new format of it; if it's another edition, add it then as a separate book.");
  } else {
    const later = sm.filter((m) => !it.target_formats.includes(m.primary_format));
    advice = "Add this one first. " + (later.length
      ? "Once it's applied, " + later.map((m) => esc(m.filename)).join(", ") + " is offered as a new format of it."
      : "The other file has the same format, so skip it, or add it later as a separate book if it's another edition.");
  }
  return '<p class="warning">Also staged, and looks like the same book: ' + list + ". " + advice + "</p>";
}

function contentsTable(it) {
  if (!it.matches || !it.matches.length) return "";
  const allBooks = [{ id: "upload", label: "Uploaded (" + it.filename + ")", contents: it.contents }].concat(
    it.matches.map((m) => ({ id: m.book.id, label: m.book.id, contents: m.book.contents }))
  );
  const fmts = ["EPUB", "PDF"].filter((f) => allBooks.some((b) => b.contents && b.contents[f]));
  if (!fmts.length) return "";
  const kb = (n) => (n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");
  const shared = (f, b) => {
    const o = it.content_overlap && it.content_overlap[f];
    if (!o) return "—";
    if (o.reference === b.id) return "reference";
    const n = o.shared[b.id];
    return n === undefined ? "—" : Math.round(n * 100) + "% with " + o.reference;
  };
  const rows = {
    EPUB: [
      ["Shared text", (p, b) => shared("EPUB", b), "text"],
      ["Words", (p) => num(p.words), "words"],
      ["Contents entries", (p) => num(p.contents), "contents"],
      ["Print pages mapped", (p) => (p.page_list ? num(p.page_list) : "none"), "page_list"],
      ["Internal links", (p) => num(p.links), "links"],
      ["Images", (p) => num(p.images) + " (" + kb(p.image_bytes) + ")", "images"],
      ["Fonts", (p) => kb(p.font_bytes)],
      ["Markup", (p) => kb(p.text_bytes)],
      ["Ends like a sample", (p) => (p.sample ? "yes" : "no"), "sample"],
    ],
    PDF: [
      ["Shared text", (p, b) => shared("PDF", b), "text"],
      ["Pages", (p) => num(p.pages), "pages"],
      ["Pages with text", (p) => num(p.text_pages), "text_pages"],
      ["Words", (p) => num(p.words), "words"],
      ["Bookmarks", (p) => num(p.contents), "contents"],
      ["Printed page numbers", (p) => (p.page_labels ? "yes" : "no")],
      ["Internal links", (p) => num(p.links), "links"],
      ["Ends like a sample", (p) => (p.sample ? "yes" : "no"), "sample"],
    ],
  };
  const short = (b, f, measure) => (it.content_warnings || []).some((w) => w.format === f && w.measure === measure && w.copy === b.id);
  return '<details' + ((it.content_warnings || []).length ? " open" : "") + "><summary>Compare contents with matched library records</summary>" +
    fmts.map((f) => '<div class="scroll"><table class="contents"><thead><tr><th>' + f + "</th>" + allBooks.map((b) => "<th>" + esc(b.label) + "</th>").join("") + "</tr></thead><tbody>" +
      rows[f].map(([label, show, key]) => "<tr><th>" + esc(label) + "</th>" + allBooks.map((b) => {
        const p = b.contents && b.contents[f];
        return !p ? "<td>—</td>" : p.pending ? "<td>checking…</td>" : p.error ? '<td class="short">unreadable</td>' : "<td" + (short(b, f, key) ? ' class="short"' : "") + ">" + esc(show(p, b)) + "</td>";
      }).join("") + "</tr>").join("") + "</tbody></table></div>").join("") + "</details>";
}

function updateBatch() {
  const readyItems = items.filter((it) => actionable(it));
  const chosen = readyItems.filter((it) => picked[it.id]);
  const addBooks = chosen.filter((it) => it.draft.action === "add_book").length;
  const addFormats = chosen.filter((it) => it.draft.action === "add_format").length;
  const blocked = items.filter((it) => it.blockers.length || ((it.matches.length || (it.staged_matches || []).some((m) => m.earlier)) && it.draft.action === "skip")).length;
  const selectedBytes = chosen.reduce((sum, it) => sum + it.size, 0);
  const over = selectedBytes - batchLimit;
  const btn = document.getElementById("preview-batch");
  btn.disabled = !chosen.length || over > 0;
  const parts = [];
  if (addBooks) parts.push(addBooks + " new book" + (addBooks === 1 ? "" : "s"));
  if (addFormats) parts.push(addFormats + " format addition" + (addFormats === 1 ? "" : "s"));
  btn.textContent = chosen.length ? "Preview " + chosen.length + " file" + (chosen.length === 1 ? "" : "s") + " (" + parts.join(", ") + ")" : "Preview selected";
  const size = document.getElementById("batch-size");
  size.className = over > 0 ? "warning" : "note";
  const waiting = readyItems.filter((it) => !picked[it.id]).length;
  size.textContent = !chosen.length ? "" : over > 0
    ? "Selected " + bytes(selectedBytes) + ", " + bytes(over) + " over the " + bytes(batchLimit) + " preview limit."
    : "Selected " + bytes(selectedBytes) + " of " + bytes(batchLimit) + "." + (waiting ? " " + waiting + " left for the next preview." : "");
  document.getElementById("select-ready").disabled = !readyItems.length;
  document.getElementById("select-none").disabled = !chosen.length;
  document.getElementById("clear-staged").disabled = !canWrite || !items.length;
  document.getElementById("count").textContent = items.length
    ? items.length + " staged file" + (items.length === 1 ? "" : "s") + (blocked ? " · " + blocked + " duplicate/blocked file" + (blocked === 1 ? "" : "s") + " intercepted" : "")
    : "No files staged.";
}

function render() {
  if (!items.length) {
    document.getElementById("items").innerHTML = '<p class="empty">No files staged yet. Choose or drop ebook files above to check them against the library.</p>';
    updateBatch();
    return;
  }
  document.getElementById("items").innerHTML = items.map((it, idx) => {
    const act = it.draft.action;
    const isReady = actionable(it);
    const warnings = []
      .concat(it.matches.map((m) => m.edition_warning).filter(Boolean))
      .concat((it.content_warnings || []).map((w) => w.message))
      .concat(it.size_warnings || []);
    const uniqueWarnings = [...new Set(warnings)];
    const addFormatCandidates = it.matches.filter((m) => m.can_add_format);
    const ck = it.proposed_citekey;
    const ckNote = ck.blockers.length
      ? "Citekey blocked (" + ck.blockers.join(", ") + ")"
      : "Proposed citekey: " + ck.key + (ck.provisional ? " (provisional until Calibre sorts author names)" : "");

    const matchedHtml = it.matches.length
      ? '<div class="compare">' + it.matches.map((m) => {
          const b = m.book;
          const isTarget = act === "add_format" && it.draft.target_book_id === b.id;
          const calibreLink = calibreWebUrl && b.library === writableLibrary
            ? ' · <a href="' + esc((calibreWebUrl.endsWith("/") ? calibreWebUrl.slice(0, -1) : calibreWebUrl) + "/book/" + b.calibre_id) + '" target="_blank" rel="noopener">Open in Calibre-Web</a>'
            : "";
          const refs = Object.entries(b.references || {}).filter(([, v]) => v).map(([k, v]) => k + ": " + v).join(", ");
          return '<div class="member' + (isTarget ? " target" : "") + '">' +
            '<img class="cover" src="/api/books/' + encodeURIComponent(b.id) + '/cover" alt="" loading="lazy" onerror="this.remove()">' +
            "<h3>" + bookLink(b.id, b.title) + "</h3>" +
            "<p>" + esc(b.id) + " · " + esc(b.authors.join("; ")) + " · " + esc(b.year ?? "Year unknown") + calibreLink + "</p>" +
            "<p>Matched by: <strong>" + esc(m.evidence.join(", ")) + "</strong></p>" +
            "<p>Existing formats: " + esc(b.formats.join(", ") || "none") + (m.missing_formats.length ? " · <strong>Missing: " + esc(m.missing_formats.join(", ")) + "</strong>" : " · already has " + esc(it.primary_format)) + "</p>" +
            "<p>" + Object.entries(b.identifiers || {}).map(([k, v]) => esc(k + ": " + v)).join(" · ") + "</p>" +
            "<p>Saved references: " + esc(refs || "none") + (b.shelves.length ? " · Shelves: " + esc(b.shelves.join(", ")) : "") + "</p>" +
            "</div>";
        }).join("") + "</div>" + contentsTable(it)
      : "";

    const choices = [];
    if (it.allowed_actions.includes("add_format")) {
      choices.push('<label><input type="radio" name="act-' + idx + '" data-action="' + idx + '" value="add_format"' + (act === "add_format" ? " checked" : "") + (canWrite ? "" : " disabled") + "> Add " + esc(it.target_formats.join(" + ")) + " format to existing book</label>");
    } else if (it.matches.length && !it.exact_matches.length) {
      choices.push('<label class="note" title="The matched record already has this format"><input type="radio" disabled> Add format to existing book (already has ' + esc(it.primary_format) + ")</label>");
    }
    if (it.allowed_actions.includes("add_book")) {
      choices.push('<label><input type="radio" name="act-' + idx + '" data-action="' + idx + '" value="add_book"' + (act === "add_book" ? " checked" : "") + (canWrite ? "" : " disabled") + "> " + (it.matches.length || (it.staged_matches || []).some((m) => m.earlier) ? "Add as separate book (another edition)" : "Add as new book") + "</label>");
    }
    choices.push('<label><input type="radio" name="act-' + idx + '" data-action="' + idx + '" value="skip"' + (act === "skip" ? " checked" : "") + (canWrite ? "" : " disabled") + "> Skip</label>");

    const targetPicker = act === "add_format" && addFormatCandidates.length > 1
      ? '<div class="fields"><label>Target book in Calibre<select data-target="' + idx + '">' +
        addFormatCandidates.map((m) => '<option value="' + esc(m.book.id) + '"' + (it.draft.target_book_id === m.book.id ? " selected" : "") + ">" + esc(m.book.id + " — " + m.book.title) + "</option>").join("") +
        "</select></label></div>"
      : "";

    const metadataEditor = act === "add_book"
      ? '<div class="fields">' +
        '<label>Title<input type="text" data-field="title" data-idx="' + idx + '" value="' + esc(it.draft.title) + '"' + (canWrite ? "" : " disabled") + "></label>" +
        '<label>Authors (separate multiple with ;)<input type="text" data-field="authors" data-idx="' + idx + '" value="' + esc(it.draft.authors.join("; ")) + '"' + (canWrite ? "" : " disabled") + "></label>" +
        '<label>Publication year<input type="number" min="1001" max="9999" data-field="year" data-idx="' + idx + '" value="' + esc(it.draft.year ?? "") + '" placeholder="Optional"' + (canWrite ? "" : " disabled") + "></label>" +
        '<label>Tags / categories (comma-separated)<input type="text" list="vocab" data-field="tags" data-idx="' + idx + '" value="' + esc(it.draft.tags.join(", ")) + '" placeholder="Optional"' + (canWrite ? "" : " disabled") + "></label>" +
        '</div><p class="note">' + esc(ckNote) + (it.extracted.identifiers.isbn ? " · ISBN: " + esc(it.extracted.identifiers.isbn) : "") + (it.extracted.identifiers.asin ? " · ASIN: " + esc(it.extracted.identifiers.asin) : "") + "</p>"
      : "";

    return '<section class="card item">' +
      '<div class="item-head">' +
        '<h2><label><input type="checkbox" data-pick="' + idx + '"' + (picked[it.id] && isReady ? " checked" : "") + (isReady ? "" : " disabled") + "> " + esc(it.filename) + "</label></h2>" +
        '<div>' + formatPlanBadge(it) + statusBadge(it) + '<span class="note">' + esc(bytes(it.size)) + " · " + esc(it.sha256.slice(0, 12)) + '…</span> <button type="button" data-remove="' + idx + '"' + (canWrite ? "" : " disabled") + ">Remove</button></div>" +
      "</div>" +
      ((it.contents_pending || []).length ? '<p class="note">Checking the ' + esc(it.contents_pending.join(" and ")) + " contents of this file in the background; this page updates when done.</p>" : "") +
      (coverPending(it) ? '<p class="note">Looking for a cover in the background; this page updates when done.</p>' : "") +
      it.blockers.map((b) => '<p class="bad"><strong>' + esc(b) + "</strong></p>").join("") +
      uniqueWarnings.map((w) => '<p class="warning">' + esc(w) + "</p>").join("") +
      (it.content_notes || []).map((w) => '<p class="note">' + esc(w) + "</p>").join("") +
      stagedMatchNote(it) +
      matchedHtml +
      '<div class="choice">' + choices.join("") + "</div>" +
      targetPicker +
      metadataEditor +
      (act === "add_book" ? coverHtml(it, idx) : "") +
      "</section>";
  }).join("");
  updateBatch();
}

async function load() {
  try {
    const prevPending = new Set(items.filter(pending).map((x) => x.id));
    // A file that couldn't be chosen before (one waiting on its pair, now offered as a format of the book
    // that was just added) is ticked like a newly staged file. A file the reader unticked stays unticked.
    const prevWaiting = new Set(items.filter((x) => !pending(x) && !actionable(x)).map((x) => x.id));
    const data = await api("/api/upload");
    items = data.items;
    if (data.max_batch_bytes) batchLimit = data.max_batch_bytes;
    calibreWebUrl = data.calibre_web_url;
    writableLibrary = data.writable_library;
    schedulePoll();
    items.forEach((it) => {
      if (prevPending.has(it.id) || pending(it)) it.was_pending = true;
      if (prevWaiting.has(it.id)) it.became_ready = true;
      initItem(it);
    });
    keepSelectionWithinLimit();
    document.getElementById("freshness").textContent = (data.last_scan ? "Catalogue refreshed " + when(data.last_scan) + ". " : "No completed catalogue refresh yet. ") + "Preview also checks the live Calibre database directly.";
    render();
  } catch (e) {
    document.getElementById("items").textContent = e.message;
  }
}

async function uploadFiles(fileList) {
  if (!canWrite || !fileList || !fileList.length) return;
  const note = document.getElementById("drop-note");
  const chooseBtn = document.getElementById("choose-files");
  chooseBtn.disabled = true;
  let uploaded = 0;
  try {
    for (const file of fileList) {
      uploaded++;
      note.textContent = "Staging " + uploaded + " of " + fileList.length + ": " + file.name + "…";
      const res = await fetch("/api/upload/files", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-upload-filename": encodeURIComponent(file.name) },
        body: file,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "Upload failed (" + res.status + ")");
      freshPick[out.id] = true;
      picked[out.id] = !out.blockers.length && (out.draft.action === "add_book" || out.draft.action === "add_format");
    }
    note.textContent = "Staged " + fileList.length + " file" + (fileList.length === 1 ? "" : "s") + ".";
  } catch (e) {
    toast(e.message);
    note.textContent = e.message;
  } finally {
    chooseBtn.disabled = !canWrite;
    document.getElementById("file-input").value = "";
    await load();
  }
}

document.getElementById("choose-files").addEventListener("click", () => document.getElementById("file-input").click());
document.getElementById("file-input").addEventListener("change", (e) => uploadFiles(e.target.files));

const dz = document.getElementById("dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); if (canWrite) dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  if (canWrite && e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

document.getElementById("refresh-source").addEventListener("click", async () => {
  if (refreshRunning) return;
  refreshRunning = true;
  const button = document.getElementById("refresh-source"), status = document.getElementById("refresh-status");
  button.disabled = true;
  try {
    const out = await post("/api/admin/jobs", { kind: "refresh", mode: "apply" });
    const link = '<a href="/admin/jobs/' + out.id + '">Refresh job #' + out.id + "</a>";
    status.innerHTML = "Pulling changes from Calibre and updating the catalogue… " + link;
    let job;
    do {
      await new Promise((r) => setTimeout(r, 1000));
      job = await api("/api/admin/jobs/" + out.id);
    } while (job.status === "running");
    await load();
    status.innerHTML = job.status === "succeeded" ? "Catalogue updated. " + link : "Refresh did not complete. " + link;
  } catch (e) {
    status.textContent = e.message;
  } finally {
    refreshRunning = false;
    button.disabled = !canWrite;
  }
});

document.getElementById("select-ready").addEventListener("click", () => {
  for (const it of items) picked[it.id] = actionable(it);
  render();
});
document.getElementById("select-none").addEventListener("click", () => {
  for (const it of items) picked[it.id] = false;
  render();
});
document.getElementById("clear-staged").addEventListener("click", async () => {
  const back = items.filter((it) => it.returns_to_intake).length;
  const msg = "Remove all staged upload files? Files staged from the Intake page are marked as left on the NAS and are not staged again" +
    (back ? ", except " + back + " waiting on a book that was just added: if staged from Intake, " + (back === 1 ? "it goes" : "they go") + " back to its list, to be offered as a format of that book." : ".");
  if (!items.length || !confirm(msg)) return;
  try {
    await post("/api/upload/clear", {});
    picked = {};
    await load();
  } catch (e) {
    toast(e.message);
  }
});

async function saveDraft(it, explicitAction = false) {
  try {
    const body = {
      title: it.draft.title,
      authors: it.draft.authors,
      year: it.draft.year,
      tags: it.draft.tags,
      target_book_id: it.draft.target_book_id,
    };
    if (explicitAction) body.action = it.draft.action;
    const updated = await post("/api/upload/files/" + encodeURIComponent(it.id), body);
    const i = items.findIndex((x) => x.id === it.id);
    if (i >= 0) items[i] = updated;
    if (updated.draft.action === "add_book" || updated.draft.action === "add_format") {
      if (picked[updated.id] === undefined) picked[updated.id] = true;
    }
    if (!actionable(updated)) picked[updated.id] = false;
    // An edited title or author can make or break a match with another staged file, whose card changes too.
    if ((it.staged_matches || []).length || (updated.staged_matches || []).length) { await load(); return; }
    render();
    schedulePoll();
  } catch (e) {
    toast(e.message);
  }
}

document.getElementById("items").addEventListener("change", (e) => {
  const t = e.target, d = t.dataset;
  if (d.pick !== undefined) {
    const it = items[Number(d.pick)];
    picked[it.id] = t.checked && actionable(it);
    updateBatch();
  } else if (d.action !== undefined) {
    const it = items[Number(d.action)];
    it.draft.action = t.value;
    if (t.value === "add_format" && !it.draft.target_book_id) it.draft.target_book_id = it.suggested_target;
    picked[it.id] = t.value === "add_book" || t.value === "add_format";
    saveDraft(it, true);
  } else if (d.cover !== undefined) {
    const it = items[Number(d.cover)];
    post("/api/upload/files/" + encodeURIComponent(it.id), { use_cover: t.checked })
      .then((updated) => { const i = items.findIndex((x) => x.id === it.id); if (i >= 0) items[i] = updated; render(); })
      .catch((err) => { t.checked = !t.checked; toast(err.message); });
  } else if (d.target !== undefined) {
    const it = items[Number(d.target)];
    it.draft.target_book_id = t.value;
    saveDraft(it, false);
  } else if (d.field !== undefined) {
    const it = items[Number(d.idx)];
    if (d.field === "title") it.draft.title = t.value.trim();
    else if (d.field === "authors") it.draft.authors = t.value.split(";").map((s) => s.trim()).filter(Boolean);
    else if (d.field === "year") it.draft.year = t.value.trim() ? Number(t.value.trim()) : null;
    else if (d.field === "tags") it.draft.tags = t.value.split(",").map((s) => s.trim()).filter(Boolean);
    saveDraft(it, false);
  }
});

document.getElementById("items").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-remove]");
  if (!btn) return;
  const it = items[Number(btn.dataset.remove)];
  btn.disabled = true;
  try {
    await post("/api/upload/files/" + encodeURIComponent(it.id) + "/remove", {});
    delete picked[it.id];
    await load();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

document.getElementById("preview-batch").addEventListener("click", async (e) => {
  const chosen = items.filter((it) => picked[it.id] && actionable(it));
  if (!chosen.length) return;
  e.target.disabled = true;
  try {
    const selections = chosen.map((it) => ({
      id: it.id,
      sha256: it.sha256,
      action: it.draft.action,
      target_book_id: it.draft.target_book_id,
      title: it.draft.title,
      authors: it.draft.authors,
      year: it.draft.year,
      tags: it.draft.tags,
    }));
    const out = await post("/api/upload/preview", { items: selections });
    location.href = "/admin/jobs/" + out.id;
  } catch (err) {
    toast(err.message);
    e.target.disabled = false;
  }
});

Promise.all([ME, VOCAB]).then(([me, labels]) => {
  canWrite = me.can_write;
  document.getElementById("refresh-source").disabled = !canWrite;
  document.getElementById("choose-files").disabled = !canWrite;
  document.getElementById("vocab").innerHTML = [...labels].map(([tag, label]) => '<option value="' + esc(tag) + '">' + esc(label) + "</option>").join("");
  load();
});
`,
});
