import { page } from "./layout.js";

/** /admin/proposals: agent-proposed category sets to approve, edit, or reject (formerly /review). */
export const PROPOSALS_HTML = page({
  title: "Proposals",
  nav: "proposals",
  css: `
.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.tabs button[aria-pressed="true"] { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.prop { margin-bottom: 12px; }
.prop h3 { font-size: 1rem; margin: 0; text-transform: none; letter-spacing: 0; color: var(--text); }
.meta { color: var(--muted); font-size: 0.86rem; margin: 2px 0 8px; }
.why { font-size: 0.92rem; margin: 10px 0; padding-left: 10px; border-left: 3px solid var(--border); }
.label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 10px 0 4px; }
.diff .add { background: var(--ok-bg); } .diff .del { background: var(--danger-bg); text-decoration: line-through; }
.addrow { display: flex; gap: 8px; margin-top: 8px; } .addrow input { flex: 1; }
.act { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center; }`,
  body: `
<h1>Proposals</h1>
<p class="sub">Category sets proposed by agents. Approving sets the book's complete set of categories; apply approved sets to Calibre from the dashboard or a book's page.</p>
<div class="tabs" id="tabs"></div>
<datalist id="vocab"></datalist>
<section id="list" aria-live="polite"></section>
<button type="button" class="more" id="more">Load more</button>`,
  script: `
const STATUSES = ["pending", "approved", "rejected"];
let status = new URLSearchParams(location.search).get("status") || "pending", offset = 0, counts = {}, canWrite = false;
const list = document.getElementById("list");

function tabs() {
  document.getElementById("tabs").innerHTML = STATUSES.map((s) => '<button type="button" data-status="' + s + '" aria-pressed="' + (s === status) + '">' +
    s[0].toUpperCase() + s.slice(1) + " (" + num(counts[s] || 0) + ")</button>").join("");
}
const chips = (tags, editable) => tags.map((t) => tagChip(t, editable ? '<button type="button" class="remove" data-tag="' + esc(t) + '" aria-label="Remove">×</button>' : "")).join("");
function diff(d) {
  if (!d || (!d.add.length && !d.remove.length)) return '<span class="note">No change to Calibre.</span>';
  return '<span class="diff">' + d.add.map((t) => '<span class="chip add" title="' + esc(t) + '">+ ' + esc(LABELS.get(t) || t) + "</span>").join("") +
    d.remove.map((t) => '<span class="chip del" title="' + esc(t) + '">− ' + esc(LABELS.get(t) || t) + "</span>").join("") + "</span>";
}
function card(p) {
  const editable = p.status === "pending" && canWrite;
  const tags = p.approved_tags || p.tags;
  return '<article class="card prop" data-uuid="' + esc(p.calibre_uuid) + '"><h3>' + bookLink(p.book_id, p.title) + "</h3>" +
    '<div class="meta">' + esc(p.authors.join(", ")) + (p.year ? " · " + p.year : "") + " · " + esc(p.book_id) + (p.proposed_by ? " · proposed by " + esc(p.proposed_by) : "") + " · " + esc(ago(p.proposed_at)) + "</div>" +
    (p.shelves.length || p.calibre_tags.length ? "<div>" + p.shelves.map((s) => '<span class="chip muted">Shelf: ' + esc(s) + "</span>").join("") + p.calibre_tags.map((t) => '<span class="chip muted" title="' + esc(t) + '">' + esc(LABELS.get(t) || t) + "</span>").join("") + "</div>" : "") +
    (p.description ? '<p class="note">' + esc(p.description) + "</p>" : "") +
    '<p class="why">' + esc(p.rationale) + "</p>" +
    '<div class="label">' + (p.status === "approved" ? "Approved set" : "Proposed set") + '</div><div class="tags">' + chips(tags, editable) + "</div>" +
    (editable ? '<div class="addrow"><input type="text" list="vocab" placeholder="Add a category (title or slug)" aria-label="Add a category"><button type="button" class="add-tag">Add</button></div>' : "") +
    '<div class="label">In Calibre</div>' + (p.status === "approved" && p.in_calibre ? badge("category", "categorized") : diff(p.calibre_changes)) +
    '<div class="act">' + (p.status === "pending"
      ? '<button type="button" class="primary approve"' + (canWrite ? "" : " disabled") + '>Approve</button><button type="button" class="danger reject"' + (canWrite ? "" : " disabled") + ">Reject</button>"
      : '<button type="button" class="reopen"' + (canWrite ? "" : " disabled") + ">Reopen</button>") +
    (p.reviewed_by ? '<span class="note">' + esc(p.status) + " by " + esc(p.reviewed_by) + " · " + esc(ago(p.reviewed_at)) + "</span>" : "") + "</div></article>";
}
async function load(reset) {
  if (reset) { offset = 0; list.innerHTML = ""; history.replaceState(null, "", location.pathname + (status === "pending" ? "" : "?status=" + status)); }
  let d;
  try { d = await api("/api/tag-proposals?status=" + status + "&limit=50&offset=" + offset); } catch (e) { toast(e.message); return; }
  counts = d.counts; tabs();
  if (!d.proposals.length && !offset) list.innerHTML = '<p class="empty">Nothing ' + status + ".</p>";
  list.insertAdjacentHTML("beforeend", d.proposals.map(card).join(""));
  offset += d.proposals.length;
  document.getElementById("more").style.display = offset < (counts[status] || 0) ? "block" : "none";
}
document.getElementById("tabs").addEventListener("click", (e) => { const s = e.target.closest("button")?.dataset.status; if (s && s !== status) { status = s; load(true); } });
document.getElementById("more").addEventListener("click", () => load(false));
list.addEventListener("click", async (e) => {
  const article = e.target.closest("article"); if (!article) return;
  if (e.target.matches(".remove")) { e.target.closest(".chip").remove(); return; }
  if (e.target.matches(".add-tag")) {
    const input = article.querySelector(".addrow input"), value = input.value.trim().toLowerCase();
    const match = [...LABELS].find(([tag, label]) => tag === value || label.toLowerCase() === value);
    if (!match) { toast("Not in the vocabulary."); return; }
    if (![...article.querySelectorAll(".tags .chip")].some((c) => c.title === match[0])) article.querySelector(".tags").insertAdjacentHTML("beforeend", chips([match[0]], true));
    input.value = ""; return;
  }
  const action = e.target.matches(".approve") ? "approve" : e.target.matches(".reject") ? "reject" : e.target.matches(".reopen") ? "reopen" : null;
  if (!action) return;
  const tags = [...article.querySelectorAll(".tags .chip")].map((c) => c.title);
  try {
    await post("/api/tag-proposals/" + encodeURIComponent(article.dataset.uuid), { action, tags });
    article.remove(); counts[status]--; tabs(); toast(action === "approve" ? "Approved." : action === "reject" ? "Rejected." : "Reopened.");
    if (!list.children.length) load(true);
  } catch (err) { toast(err.message); }
});
Promise.all([ME, VOCAB]).then(([me, labels]) => {
  canWrite = me.can_write;
  document.getElementById("vocab").innerHTML = [...labels].map(([tag, label]) => '<option value="' + esc(label) + '">' + esc(tag) + "</option>").join("");
  load(true);
});`,
});
