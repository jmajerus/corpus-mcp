import { page } from "./layout.js";

/** /admin/changes: the change log, filterable, with changes per day. History, kept apart from the current-state pages. */
export const CHANGES_HTML = page({
  title: "Changes",
  nav: "changes",
  css: `.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
.filters select, .filters input { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 0.88rem; min-width: 0; }
.filters input { width: 150px; }
.filters button { border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; background: var(--surface); color: var(--text); font: inherit; font-size: 0.88rem; cursor: pointer; }
.kinds { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.kind { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 3px 10px; font-size: 0.84rem; cursor: pointer; font: inherit; font-size: 0.84rem; }
.kind[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.kind .n { color: var(--muted); margin-left: 4px; font-variant-numeric: tabular-nums; }
.chart { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px 8px; position: relative; }
.chart h2 { font-size: 0.85rem; font-weight: 600; margin: 0 0 6px; color: var(--muted); }
.chart svg { display: block; width: 100%; height: 140px; }
.tip { position: absolute; pointer-events: none; background: var(--text); color: var(--bg); font-size: 0.8rem; padding: 4px 8px; border-radius: 6px; white-space: nowrap; transform: translate(-50%, -110%); display: none; }
.summary { margin: 14px 0 8px; font-size: 0.9rem; color: var(--muted); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
td.when { white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }
.badge { display: inline-block; border-radius: 6px; padding: 1px 8px; font-size: 0.8rem; white-space: nowrap; border: 1px solid var(--border); }
.badge.good { background: var(--good-bg); border-color: transparent; }
.badge.bad { background: var(--bad-bg); border-color: transparent; }
.badge .sign { font-weight: 700; margin-right: 4px; }
.badge.good .sign { color: var(--good); } .badge.bad .sign { color: var(--bad); }
.chip { display: inline-block; background: var(--chip); color: var(--chip-text); border-radius: 6px; padding: 1px 8px; font-size: 0.82rem; overflow-wrap: anywhere; }
.book { font-weight: 500; }
.book small { display: block; color: var(--muted); font-weight: 400; }
.linkish { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-align: left; }
#more { display: none; margin: 12px auto; border: 1px solid var(--border); border-radius: 6px; padding: 7px 14px; background: var(--surface); color: var(--text); font: inherit; cursor: pointer; }
.empty { text-align: center; color: var(--muted); padding: 32px 0; }`,
  body: `
  <h1>Changes</h1>
  <p class="sub">The history behind the current state: what changed in the corpus, when, and by whom.</p>
  <form class="filters" id="filters" role="search">
    <select name="range" aria-label="Time range">
      <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option>
      <option value="90">Last 90 days</option><option value="all">All time</option>
    </select>
    <select name="source" aria-label="Source">
      <option value="">Any source</option><option value="admin-job">Admin jobs</option><option value="admin">Admin pages</option><option value="cli">Command line</option>
      <option value="calibre">Seen in Calibre</option><option value="review">Review</option><option value="agent">Agents</option>
    </select>
    <input name="q" type="search" placeholder="Book title or id" aria-label="Book title or id">
    <input name="tag" type="search" placeholder="Tag" aria-label="Tag">
    <input name="job" type="search" inputmode="numeric" placeholder="Job #" aria-label="Job number" style="width: 80px">
    <select name="actor" aria-label="Person"><option value="">Anyone</option></select>
    <button type="button" id="clear">Clear</button>
  </form>
  <div class="kinds" id="kinds" aria-label="Change types"></div>
  <div class="chart"><h2 id="charttitle">Changes per day</h2><svg id="chart" role="img" aria-label="Changes per day"></svg><div class="tip" id="tip"></div></div>
  <p class="summary" id="summary"></p>
  <div class="scroll"><table><thead><tr><th>When</th><th>Change</th><th>Book</th><th>Detail</th><th>Source</th><th>By</th></tr></thead><tbody id="rows"></tbody></table></div>
  <button type="button" id="more">Load more</button>
`,
  script: `
const KINDS = {
  tag_added: ["Tag added", "+", "good"], tag_removed: ["Tag removed", "−", "bad"], format_added: ["EPUB added", "+", "good"],
  book_added: ["New book", "+", "good"], book_reextracted: ["Re-indexed", "↻", ""], book_removed: ["Book removed", "−", "bad"],
  extraction_failed: ["Extraction failed", "!", "bad"], tag_proposed: ["Tag proposed", "?", ""], proposal_approved: ["Proposal approved", "✓", "good"],
  proposal_rejected: ["Proposal rejected", "×", "bad"], proposal_reopened: ["Proposal reopened", "↺", ""], citekey_pinned: ["Citekey pinned", "#", ""],
  categories_edited: ["Categories set", "✎", ""], citekey_unpinned: ["Citekey unpinned", "−", "bad"],
};
const SOURCES = { "admin-job": "Admin job", admin: "Admin page", cli: "Command line", calibre: "Seen in Calibre", review: "Review", agent: "Agent" };
const form = document.getElementById("filters");
let kinds = new Set(), offset = 0, total = 0;

function fromUrl() {
  const p = new URLSearchParams(location.search);
  for (const name of ["range", "source", "q", "tag", "job"]) if (p.has(name)) form.elements[name].value = p.get(name);
  kinds = new Set(p.getAll("kind"));
  return p.get("actor") || "";
}
function toUrl() {
  const p = new URLSearchParams();
  for (const name of ["range", "source", "q", "tag", "job", "actor"]) { const v = form.elements[name].value.trim(); if (v && !(name === "range" && v === "30")) p.set(name, v); }
  for (const k of kinds) p.append("kind", k);
  history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : ""));
}
function apiQuery() {
  const p = new URLSearchParams();
  const range = form.elements.range.value;
  if (range !== "all") p.set("since", new Date(Date.now() - Number(range) * 86400000).toISOString());
  for (const name of ["source", "q", "tag", "job", "actor"]) { const v = form.elements[name].value.trim(); if (v) p.set(name, v); }
  for (const k of kinds) p.append("kind", k);
  p.set("offset", offset); p.set("limit", 100);
  return p;
}

function detail(r) {
  if (!r.detail) return "";
  if (["tag_added", "tag_removed", "tag_proposed", "proposal_approved"].includes(r.kind)) {
    return tagChip(r.detail);
  }
  return esc(r.detail);
}
function row(r) {
  const [name, sign, tone] = KINDS[r.kind] || [r.kind, "", ""];
  const when = new Date(r.at);
  const source = r.job_id ? '<a href="/admin/jobs/' + r.job_id + '">' + esc(SOURCES[r.source] || r.source) + " #" + r.job_id + "</a>" : esc(SOURCES[r.source] || r.source);
  return '<tr><td class="when" title="' + esc(when.toISOString()) + '">' + esc(when.toLocaleDateString()) + "<br>" + esc(when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) + "</td>" +
    '<td><span class="badge ' + tone + '"><span class="sign" aria-hidden="true">' + esc(sign) + "</span>" + esc(name) + "</span></td>" +
    '<td class="book">' + (r.book_id ? bookLink(r.book_id, r.title) + '<small><button type="button" class="linkish" data-book="' + esc(r.book_id) + '">' + esc(r.book_id) + "</button> · filter</small>" : "") + "</td>" +
    "<td>" + detail(r) + "</td><td>" + source + "</td><td>" + esc(r.actor || "") + "</td></tr>";
}

// Changes per day: one series, thin bars from a shared baseline, a tooltip per bar.
function chart(byDay, days) {
  const svg = document.getElementById("chart"), tip = document.getElementById("tip");
  const width = svg.clientWidth || 800, height = 140, top = 14, bottom = 22, left = 30;
  const counts = new Map(byDay.map((d) => [d.day, d.n]));
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  const first = byDay.length ? new Date(byDay[0].day + "T00:00:00Z") : end;
  const span = days === "all" ? Math.max(1, Math.round((end - first) / 86400000) + 1) : Number(days);
  const series = [];
  for (let i = span - 1; i >= 0; i--) { const d = new Date(end - i * 86400000).toISOString().slice(0, 10); series.push([d, counts.get(d) || 0]); }
  const max = Math.max(1, ...series.map((s) => s[1]));
  const slot = (width - left) / series.length, barW = Math.max(2, Math.min(24, slot - 2));
  const y = (v) => top + (height - top - bottom) * (1 - v / max);
  let out = '<line x1="' + left + '" x2="' + width + '" y1="' + y(max) + '" y2="' + y(max) + '" stroke="var(--grid)"/>' +
    '<text x="' + (left - 6) + '" y="' + (y(max) + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + max + "</text>" +
    '<line x1="' + left + '" x2="' + width + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="var(--border)"/>';
  series.forEach(([d, n], i) => {
    const x = left + i * slot + (slot - barW) / 2;
    if (n > 0) {
      const h = y(0) - y(n), r = Math.min(4, h, barW / 2);
      // Rounded at the data end, square at the baseline.
      out += '<path fill="var(--bar)" d="M' + x + "," + y(0) + "V" + (y(n) + r) + "Q" + x + "," + y(n) + " " + (x + r) + "," + y(n) + "H" + (x + barW - r) + "Q" + (x + barW) + "," + y(n) + " " + (x + barW) + "," + (y(n) + r) + "V" + y(0) + 'Z"/>';
    }
    out += '<rect class="hit" data-day="' + d + '" data-n="' + n + '" x="' + (left + i * slot) + '" y="' + top + '" width="' + slot + '" height="' + (height - top) + '" fill="transparent"/>';
  });
  const fmt = (d) => new Date(d + "T12:00:00Z").toLocaleDateString([], { month: "short", day: "numeric" });
  out += '<text x="' + left + '" y="' + (height - 6) + '" font-size="11" fill="var(--muted)">' + fmt(series[0][0]) + "</text>" +
    '<text x="' + width + '" y="' + (height - 6) + '" font-size="11" text-anchor="end" fill="var(--muted)">' + fmt(series.at(-1)[0]) + "</text>";
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.innerHTML = out;
  svg.onmousemove = (e) => {
    const hit = e.target.closest(".hit");
    if (!hit) { tip.style.display = "none"; return; }
    const box = svg.getBoundingClientRect(), rect = hit.getBoundingClientRect();
    tip.style.display = "block";
    tip.style.left = (rect.left - box.left + rect.width / 2 + 14) + "px";
    tip.style.top = (y(Number(hit.dataset.n)) + 12) + "px";
    tip.textContent = fmt(hit.dataset.day) + ": " + hit.dataset.n + " change" + (hit.dataset.n === "1" ? "" : "s");
  };
  svg.onmouseleave = () => { tip.style.display = "none"; };
}

async function load(reset) {
  if (reset) { offset = 0; document.getElementById("rows").innerHTML = ""; toUrl(); }
  const data = await (await fetch("/api/changes?" + apiQuery())).json();
  total = data.total;
  if (reset) {
    document.getElementById("kinds").innerHTML = Object.entries(KINDS).filter(([k]) => data.by_kind[k] || kinds.has(k)).map(([k, [name, sign]]) =>
      '<button type="button" class="kind" data-kind="' + k + '" aria-pressed="' + kinds.has(k) + '">' + esc(sign + " " + name) + '<span class="n">' + (data.by_kind[k] || 0) + "</span></button>").join("");
    const actor = form.elements.actor, current = actor.value;
    actor.innerHTML = '<option value="">Anyone</option>' + data.actors.map((a) => '<option value="' + esc(a) + '">' + esc(a) + "</option>").join("");
    actor.value = current;
    chart(data.by_day, form.elements.range.value);
  }
  const rows = document.getElementById("rows");
  if (!data.rows.length && !offset) rows.innerHTML = '<tr><td colspan="6" class="empty">No changes match these filters.</td></tr>';
  rows.insertAdjacentHTML("beforeend", data.rows.map(row).join(""));
  offset += data.rows.length;
  document.getElementById("summary").textContent = total.toLocaleString() + " change" + (total === 1 ? "" : "s") + (offset < total ? " · showing " + offset : "");
  document.getElementById("more").style.display = offset < total ? "block" : "none";
}

let timer;
form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => load(true), 300); });
form.addEventListener("submit", (e) => { e.preventDefault(); load(true); });
document.getElementById("clear").addEventListener("click", () => { form.reset(); kinds.clear(); load(true); });
document.getElementById("kinds").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]"); if (!b) return;
  kinds.has(b.dataset.kind) ? kinds.delete(b.dataset.kind) : kinds.add(b.dataset.kind);
  load(true);
});
document.getElementById("rows").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-book]"); if (!b) return;
  form.elements.q.value = b.dataset.book; load(true);
});
document.getElementById("more").addEventListener("click", () => load(false));
window.addEventListener("resize", () => { clearTimeout(timer); timer = setTimeout(() => load(true), 300); });

const actor = fromUrl();
VOCAB.finally(() => { if (actor) form.elements.actor.innerHTML = '<option value="">Anyone</option><option selected value="' + esc(actor) + '">' + esc(actor) + "</option>"; load(true); });
`,
});
