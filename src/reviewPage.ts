/** The /review page: approve, edit, or reject agent-proposed vocabulary tags. Served by serveHttp. */
export const REVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tag Review</title>
<style>
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --border: #dedcd6;
  --accent: #2f5d8a; --accent-text: #ffffff; --ok: #2e7d4f; --warn: #a15c07; --danger: #b3261e;
  --chip: #eef2f7; --chip-text: #23405e; --chip-muted: #f0efeb;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935;
    --accent: #7fb0e0; --accent-text: #0f1a24; --ok: #6cc290; --warn: #e0a85a; --danger: #f08a82;
    --chip: #233142; --chip-text: #cfe0f2; --chip-muted: #2a2a27;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935;
  --accent: #7fb0e0; --accent-text: #0f1a24; --ok: #6cc290; --warn: #e0a85a; --danger: #f08a82;
  --chip: #233142; --chip-text: #cfe0f2; --chip-muted: #2a2a27;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 20px; }
nav { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
nav button { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit; }
nav button[aria-pressed="true"] { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 14px; }
.card h2 { font-size: 1.05rem; margin: 0; }
.meta { color: var(--muted); font-size: 0.88rem; margin: 2px 0 10px; }
.desc { font-size: 0.9rem; color: var(--muted); margin: 8px 0; }
.why { font-size: 0.92rem; margin: 10px 0; padding-left: 10px; border-left: 3px solid var(--border); }
.label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 10px 0 4px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); color: var(--chip-text); border-radius: 6px; padding: 3px 8px; font-size: 0.86rem; max-width: 100%; overflow-wrap: anywhere; }
.chip.muted { background: var(--chip-muted); color: var(--muted); }
.chip button { border: 0; background: none; color: inherit; cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 2px; }
.add { display: flex; gap: 8px; margin-top: 8px; }
.add input { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 0.88rem; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
.actions button { border: 1px solid var(--border); border-radius: 6px; padding: 7px 14px; cursor: pointer; font: inherit; background: var(--surface); color: var(--text); }
.actions .approve { background: var(--ok); color: #fff; border-color: var(--ok); }
.actions .reject { color: var(--danger); }
.status { font-size: 0.88rem; }
.status.ok { color: var(--ok); } .status.warn { color: var(--warn); } .status.err { color: var(--danger); }
.empty { color: var(--muted); text-align: center; padding: 40px 0; }
#more { display: none; margin: 8px auto; }
</style>
</head>
<body>
<main>
  <h1>Tag Review</h1>
  <p class="sub">Approve, edit, or reject the Concept Clusters tags an agent proposed for each book. Approved tags reach Calibre when <code>tools/calibre-tags.sh</code> is applied.</p>
  <nav id="tabs"></nav>
  <datalist id="vocabulary"></datalist>
  <section id="list" aria-live="polite"></section>
  <div class="actions"><button id="more" type="button">Load more</button></div>
</main>
<script>
const STATUSES = ["pending", "approved", "rejected"];
let status = "pending", offset = 0, counts = {}, labels = new Map();
const list = document.getElementById("list");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function renderTabs() {
  document.getElementById("tabs").innerHTML = STATUSES.map((s) =>
    '<button type="button" data-status="' + s + '" aria-pressed="' + (s === status) + '">' + s[0].toUpperCase() + s.slice(1) + " (" + (counts[s] ?? 0) + ")</button>").join("");
}
document.getElementById("tabs").addEventListener("click", (e) => {
  const s = e.target.closest("button")?.dataset.status;
  if (s && s !== status) { status = s; load(true); }
});

// Vocabulary tags are slugs; show their titles, with the slug on hover.
function chips(tags, editable) {
  return tags.map((t) => {
    const label = labels.get(t) ?? t;
    return '<span class="chip" data-tag="' + esc(t) + '" title="' + esc(t) + '">' + esc(label) +
      (editable ? '<button type="button" class="remove" aria-label="Remove ' + esc(label) + '">×</button>' : "") + "</span>";
  }).join("");
}

function card(p) {
  const editable = p.status === "pending";
  const tags = p.approved_tags ?? p.tags;
  const state = p.status === "approved"
    ? (p.in_calibre ? '<span class="status ok">In Calibre</span>' : '<span class="status warn">Waiting for calibre-tags.sh</span>')
    : "";
  return '<article class="card" data-uuid="' + esc(p.calibre_uuid) + '">' +
    "<h2>" + esc(p.title) + "</h2>" +
    '<div class="meta">' + esc(p.authors.join(", ")) + (p.year ? " · " + p.year : "") + " · " + esc(p.book_id) + "</div>" +
    (p.shelves.length || p.calibre_tags.length ? '<div class="chips">' + p.shelves.map((s) => '<span class="chip muted">Shelf: ' + esc(s) + "</span>").join("") +
      p.calibre_tags.map((t) => '<span class="chip muted">' + esc(t) + "</span>").join("") + "</div>" : "") +
    (p.description ? '<p class="desc">' + esc(p.description) + "</p>" : "") +
    '<p class="why">' + esc(p.rationale) + "</p>" +
    '<div class="label">' + (p.status === "approved" ? "Approved tags" : "Proposed tags") + "</div>" +
    '<div class="chips tags">' + chips(tags, editable) + "</div>" +
    (editable ? '<div class="add"><input list="vocabulary" placeholder="Add a vocabulary tag" aria-label="Add a vocabulary tag"><button type="button" class="add-tag">Add</button></div>' : "") +
    '<div class="actions">' +
      (editable ? '<button type="button" class="approve">Approve</button><button type="button" class="reject">Reject</button>'
                : '<button type="button" class="reopen">Reopen</button>') +
      state + '<span class="status msg"></span></div></article>';
}

async function load(reset) {
  if (reset) { offset = 0; list.innerHTML = ""; }
  const res = await fetch("api/tag-proposals?status=" + status + "&limit=50&offset=" + offset);
  const data = await res.json();
  counts = data.counts; renderTabs();
  if (!data.proposals.length && !offset) list.innerHTML = '<p class="empty">Nothing ' + status + ".</p>";
  list.insertAdjacentHTML("beforeend", data.proposals.map(card).join(""));
  offset += data.proposals.length;
  document.getElementById("more").style.display = offset < (counts[status] ?? 0) ? "block" : "none";
}
document.getElementById("more").addEventListener("click", () => load(false));

function addTag(article) {
  const input = article.querySelector(".add input");
  const value = input.value.trim();
  const msg = article.querySelector(".msg");
  const lower = value.toLowerCase();
  const match = [...labels].find(([tag, label]) => tag === lower || label.toLowerCase() === lower)?.[0];
  if (!match) { msg.className = "status msg err"; msg.textContent = "Not in the vocabulary."; return; }
  if (![...article.querySelectorAll(".tags .chip")].some((c) => c.dataset.tag === match)) {
    article.querySelector(".tags").insertAdjacentHTML("beforeend", chips([match], true));
  }
  input.value = ""; msg.textContent = "";
}

async function act(article, action) {
  const msg = article.querySelector(".msg");
  const tags = [...article.querySelectorAll(".tags .chip")].map((c) => c.dataset.tag);
  msg.className = "status msg"; msg.textContent = "Saving…";
  const res = await fetch("api/tag-proposals/" + encodeURIComponent(article.dataset.uuid), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, tags }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { msg.className = "status msg err"; msg.textContent = body.error ?? "Failed."; return; }
  counts[status]--; counts[body.status] = (counts[body.status] ?? 0) + 1; offset--;
  article.remove(); renderTabs();
  if (!list.children.length) load(true);
}

list.addEventListener("click", (e) => {
  const article = e.target.closest("article"); if (!article) return;
  if (e.target.matches(".remove")) e.target.closest(".chip").remove();
  else if (e.target.matches(".add-tag")) addTag(article);
  else if (e.target.matches(".approve")) act(article, "approve");
  else if (e.target.matches(".reject")) act(article, "reject");
  else if (e.target.matches(".reopen")) act(article, "reopen");
});
list.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches(".add input")) { e.preventDefault(); addTag(e.target.closest("article")); }
});

fetch("api/vocabulary").then((r) => r.json()).then((v) => {
  labels = new Map(v.tags.map((t) => [t.tag, t.label]));
  document.getElementById("vocabulary").innerHTML = v.tags.map((t) => '<option value="' + esc(t.label) + '">' + esc(t.tag) + "</option>").join("");
  load(true);
});
</script>
</body>
</html>
`;
