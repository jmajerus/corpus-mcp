import { page } from "./layout.js";

/** /admin/intake: scan a read-only ebook directory and stage a review batch. Apply stays on /admin/upload. */
export const INTAKE_HTML = page({
  title: "Intake",
  nav: "intake",
  css: `
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.filters button[aria-pressed="true"] { background: var(--chip); color: var(--chip-text); border-color: transparent; }
.path { overflow-wrap: anywhere; }
`,
  body: `
<h1>Intake from the master directory</h1>
<p class="sub">Scan a read-only directory of ebook files and stage a batch for the <a href="/admin/upload">Upload</a> page. Exact copies already in Calibre are skipped. Nothing is added until you preview and apply there, and nothing on the NAS is moved or deleted.</p>
<p id="off" class="note" hidden>Intake is off until <code>CORPUS_INTAKE_ROOT</code> is a read-only mount of the master ebook directory. Mount it on this host (a read-only NFS or CIFS share, or a read-only bind into the container). Do not point it at the Calibre library.</p>
<p id="root-error" class="warning" hidden></p>
<p id="root" class="note"></p>
<div class="actions">
  <button type="button" id="scan" class="primary" disabled>Scan directory</button>
  <button type="button" id="stage" disabled>Stage next batch</button>
  <a href="/admin/upload">Review staged files</a>
  <span id="room" class="note"></span>
</div>
<p id="notice" role="status" aria-live="polite"></p>
<div class="filters" id="filters"></div>
<div class="actions">
  <input type="search" id="q" placeholder="Path or title" aria-label="Filter the list">
  <button type="button" id="skip" disabled>Leave selected on the NAS</button>
</div>
<div class="scroll"><table><thead><tr><th></th><th>File</th><th>Title</th><th class="num">Size</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div>
<button type="button" class="more" id="more" hidden>Load more</button>`,
  script: `
let statusFilter = "candidate", offset = 0, items = [], total = 0, canWrite = false, enabled = false, counts = {};
const STATUS_LABELS = {
  candidate: "Ready to review", present: "Already in the library", staged: "Staged for upload",
  applied: "Added", skipped: "Left on the NAS", problem: "Damaged or DRM", too_large: "Too large"
};
const ORDER = ["candidate", "present", "staged", "applied", "skipped", "problem", "too_large"];
const dismissible = (row) => row.status === "candidate" || row.status === "problem" || row.status === "too_large";

function query() {
  const params = new URLSearchParams();
  params.set("status", statusFilter);
  params.set("limit", "50");
  params.set("offset", String(offset));
  const q = document.getElementById("q").value.trim();
  if (q) params.set("q", q);
  return "/api/intake?" + params.toString();
}

function renderFilters() {
  document.getElementById("filters").innerHTML = ORDER.map((key) =>
    '<button type="button" data-status="' + key + '" aria-pressed="' + (statusFilter === key) + '">' + esc(STATUS_LABELS[key]) + " " + num(counts[key] || 0) + "</button>").join("");
}

function renderRows() {
  const body = document.getElementById("rows");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">' + (enabled ? "Nothing in this list." : "Intake is off.") + "</td></tr>";
  } else {
    body.innerHTML = items.map((row) => "<tr><td>" +
      (dismissible(row) ? '<input type="checkbox" data-path="' + esc(row.path) + '" aria-label="Select ' + esc(row.path) + '">' : "") +
      '</td><td class="path">' + esc(row.path) + "</td><td>" + esc(row.title || "") +
      (row.authors && row.authors.length ? '<br><span class="note">' + esc(row.authors.join(", ")) + "</span>" : "") +
      (row.problem ? '<br><span class="warning">' + esc(row.problem) + "</span>" : "") +
      '</td><td class="num">' + bytes(row.size) + "</td><td>" +
      (row.book_id ? '<a href="/admin/books/' + encodeURIComponent(row.book_id) + '">' + esc(STATUS_LABELS[row.status] || row.status) + "</a>" : esc(STATUS_LABELS[row.status] || row.status)) +
      (row.status === "staged" ? ' · <a href="/admin/upload">Upload</a>' : "") +
      "</td></tr>").join("");
  }
  document.getElementById("more").hidden = offset + items.length >= total;
  document.getElementById("skip").disabled = !canWrite;
  document.getElementById("stage").disabled = !canWrite || !enabled || !(counts.candidate > 0);
  document.getElementById("scan").disabled = !canWrite || !enabled;
}

async function load(reset) {
  if (reset) { offset = 0; items = []; }
  let data;
  try { data = await api(query()); } catch (e) { toast(e.message); return; }
  enabled = data.enabled && !data.error;
  counts = data.counts || {};
  total = data.total || 0;
  items = reset ? data.items : items.concat(data.items);
  document.getElementById("off").hidden = data.enabled;
  const err = document.getElementById("root-error");
  err.hidden = !data.error;
  err.textContent = data.error || "";
  document.getElementById("root").textContent = data.root ? "Directory: " + data.root : "";
  const room = data.staging || {};
  document.getElementById("room").textContent = data.enabled
    ? num(room.files) + " of " + num(room.max_files) + " files staged, " + bytes(room.bytes) + " of " + bytes(room.max_bytes)
    : "";
  renderFilters();
  renderRows();
}

document.getElementById("filters").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-status]");
  if (!button) return;
  statusFilter = button.dataset.status;
  load(true);
});
document.getElementById("q").addEventListener("change", () => load(true));
document.getElementById("more").addEventListener("click", () => { offset += 50; load(false); });
document.getElementById("scan").addEventListener("click", async () => {
  try {
    const out = await post("/api/intake/scan", {});
    location.href = "/admin/jobs/" + out.id;
  } catch (e) { toast(e.message); }
});
document.getElementById("stage").addEventListener("click", async () => {
  const notice = document.getElementById("notice");
  notice.textContent = "Staging…";
  try {
    const out = await post("/api/intake/stage", {});
    notice.textContent = out.staged
      ? "Staged " + num(out.staged) + " file" + (out.staged === 1 ? "" : "s") + ". Review them on the Upload page, then preview and apply."
      : "No new files were copied.";
    await load(true);
  } catch (e) { notice.textContent = ""; toast(e.message); }
});
document.getElementById("skip").addEventListener("click", async () => {
  const paths = [...document.querySelectorAll("#rows input:checked")].map((box) => box.getAttribute("data-path"));
  if (!paths.length) { toast("Select files to leave on the NAS."); return; }
  try {
    const out = await post("/api/intake/skip", { paths });
    toast("Left " + num(out.skipped) + " on the NAS.");
    await load(true);
  } catch (e) { toast(e.message); }
});

Promise.all([ME, load(true)]).then(([me]) => {
  canWrite = me.can_write;
  renderRows();
}).catch((e) => toast(e.message));`,
});
