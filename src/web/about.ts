import { page } from "./layout.js";

/**
 * /admin/about: what the server runs and how it stands, as the VS Code status-bar items show it
 * (tools/corpus-status.mjs and tools/replica-status.mjs), for anyone without VS Code at hand.
 */
export const ABOUT_HTML = page({
  title: "About · Corpus Admin",
  nav: "about",
  css: `
.warn { color: var(--warn); } .bad { color: var(--danger); } .good { color: var(--ok); }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; font-size: 0.9rem; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; overflow-wrap: anywhere; }
.card .note { margin: 10px 0 0; }
.label { font-size: 1.3rem; font-weight: 600; margin-bottom: 8px; }`,
  body: `
<h1>About</h1>
<p class="sub">What this server runs, and how the public catalogue stands. GitHub and the public site are checked every few minutes.</p>
<div id="about" class="grid"><p class="empty">Loading…</p></div>`,
  script: `
const kv = (rows) => '<dl class="kv">' + rows.filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== "").map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + v + "</dd>").join("") + "</dl>";
const card = (title, top, rows, note, cls) => '<div class="card"><h3>' + esc(title) + "</h3>" + (top ? '<div class="label ' + (cls || "") + '">' + top + "</div>" : "") + kv(rows) + (note ? '<p class="note">' + note + "</p>" : "") + "</div>";

function running(a) {
  const d = a.deployed, o = a.origin;
  if (!d || !d.commit) return card("Running", "?", [["Version", esc(a.version)]], "The server has no deploy record yet. Deploy it once with the Deploy Corpus button.", "warn");
  const repo = "https://github.com/" + a.repository;
  const marks = [];
  let note = "";
  if (o && o.pr_state && o.pr_state !== "open") {
    marks.push(o.pr_state === "merged" ? "✓ merged" : "✗ closed");
    note = "The pull request is no longer open. Switch the server to main with the Deploy Corpus button.";
  }
  if (o && o.behind) {
    marks.push("↓" + o.behind);
    if (!note) note = "Redeploy current branch with the Deploy Corpus button to catch up.";
  }
  if (d.local) marks.push(d.dirty ? "local*" : "local");
  const label = d.pr ? '<a href="' + repo + "/pull/" + d.pr + '">#' + d.pr + "</a>" : esc(d.branch);
  const lagging = (o && o.behind) || note || d.dirty || (o && o.behind === null && !(o.pr_state && o.pr_state !== "open"));
  return card("Running", label + (marks.length ? ' <span class="note">' + esc(marks.join(" ")) + "</span>" : ""), [
    ["Branch", esc(d.branch) + (d.pr ? " (pull request #" + d.pr + (o && o.pr_title ? ": " + esc(o.pr_title) : "") + ")" : "")],
    ["Commit", '<a href="' + repo + "/commit/" + esc(d.commit) + '"><code>' + esc(d.commit.slice(0, 7)) + "</code></a>" + (d.local ? " from a local checkout" + (d.dirty ? ", with uncommitted changes" : "") : "")],
    ["Behind origin", !o ? null : o.behind === null ? (o.pr_state && o.pr_state !== "open" ? null : '<span class="warn" title="' + esc(o.error || "") + '">unknown</span>') : String(o.behind)],
    ["Deployed", d.at ? esc(when(d.at)) + " (" + esc(ago(d.at)) + ")" : null],
    ["Checked", o && o.checked_at ? esc(ago(o.checked_at)) : null],
  ], esc(note), lagging ? "warn" : "good");
}

function server(a) {
  return card("Server", "corpus-mcp " + esc(a.version), [
    ["Node", esc(a.node)], ["Up since", esc(when(a.started_at))], ["Books indexed", num(a.books)], ["Last scan", a.last_scan ? esc(ago(a.last_scan)) : "never"],
    ["Source", '<a href="https://github.com/' + esc(a.repository) + '">' + esc(a.repository) + "</a>"],
  ]);
}

function editing(a) {
  const e = a.editing;
  return card("Editing", null, [
    ["On the LAN", e.lan ? "Yes, recorded as " + esc(e.lan_actor) : '<span class="warn">Read-only</span> (CORPUS_LAN_EDITS=off)'],
    ["Through Cloudflare", e.access ? "Yes, after an Access sign-in" : '<span class="warn">Not configured</span> (CORPUS_ACCESS_TEAM_DOMAIN, CORPUS_ACCESS_AUD)'],
  ]);
}

function catalogue(a) {
  const p = a.public, r = p.replica;
  if (p.level === "none") return card("Public catalogue", "Off", [], "Set CORPUS_PUBLIC=catalogue to publish the catalogue (docs/public-site.md).");
  const preview = p.preview_port ? "http://" + location.hostname + ":" + p.preview_port + "/" : null;
  let top = "In step", cls = "good", note = "";
  if (!r) { top = "No drain"; cls = "warn"; note = "The server reports no upload queue."; }
  else if (r.phase === "off") { top = "Not uploading"; cls = "warn"; note = "The server has no D1 settings. Put CORPUS_D1_PROXY_URL and CORPUS_D1_PROXY_TOKEN in .env and deploy."; }
  else if (r.phase === "error") { top = "Upload failing"; cls = "bad"; note = "Rows stay queued, and the next try is within 15 seconds."; }
  else if (r.pending > 0) { top = "↑ " + num(r.pending) + " waiting"; cls = ""; note = "Queued rows upload within 15 seconds."; }
  else if (p.url && p.published !== "yes") { top = "Not answering"; cls = "warn"; note = "The queue is empty, but the public site doesn't answer as published."; }
  return card("Public catalogue", top, [
    ["Public site", p.url ? '<a href="' + esc(p.url) + '">' + esc(p.url) + "</a>" : '<span class="note">No CORPUS_PUBLIC_URL</span>'],
    ["Published", p.published ? esc(p.published) : null],
    ["Preview", preview ? '<a href="' + esc(preview) + '">' + esc(preview) + "</a>" : '<span class="note">No CORPUS_PUBLIC_PORT</span>'],
    ["Upload queue", r ? esc(r.phase) : null],
    ["Waiting", r ? num(r.pending) : null],
    ["Last uploaded", r ? esc(ago(r.shipped_at)) : null],
    ["Error", r && r.error ? '<span class="bad">' + esc(r.error) + "</span>" : null],
  ], esc(note), cls);
}

async function load() {
  let a;
  try { a = await api("/api/about"); } catch (e) { toast(e.message); return; }
  document.getElementById("about").innerHTML = running(a) + server(a) + editing(a) + catalogue(a);
}
load();
setInterval(load, 60000);
`,
});
