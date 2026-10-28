/**
 * The shared frame of the corpus admin pages: theme tokens, navigation, the sign-in badge, and
 * client helpers. Pages are plain HTML strings with their own script; keep backslashes out of them,
 * since a TypeScript template literal would swallow them.
 */

import { FAVICON_LINK } from "./favicon.js";

export type NavKey = "dashboard" | "books" | "quotes" | "categories" | "taxonomy" | "citekeys" | "proposals" | "shelves" | "jobs" | "changes" | "zotero";

const NAV: [NavKey, string, string][] = [
  ["dashboard", "Dashboard", "/admin"],
  ["books", "Books", "/admin/books"],
  ["quotes", "Quotes", "/admin/quotes"],
  ["categories", "Categories", "/admin/categories"],
  ["taxonomy", "Taxonomy", "/admin/taxonomy"],
  ["citekeys", "Citekeys", "/admin/citekeys"],
  ["zotero", "Zotero", "/admin/zotero"],
  ["proposals", "Proposals", "/admin/proposals"],
  ["shelves", "Shelves", "/admin/shelves"],
  ["jobs", "Jobs", "/admin/jobs"],
  ["changes", "Changes", "/admin/changes"],
];

export const CSS = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --border: #dedcd6; --grid: #ecebe7;
  --accent: #2f5d8a; --accent-text: #ffffff; --bar: #2a78d6; --ok: #2e7d4f; --warn: #a15c07; --danger: #b3261e;
  --ok-bg: #e6f3eb; --warn-bg: #fdf1e0; --danger-bg: #fbeae8; --chip: #eef2f7; --chip-text: #23405e; --code: #f0efeb;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935; --grid: #2c2c29;
    --accent: #7fb0e0; --accent-text: #0f1a24; --bar: #3987e5; --ok: #6cc290; --warn: #e0a85a; --danger: #f08a82;
    --ok-bg: #1d3326; --warn-bg: #3a2c18; --danger-bg: #3a2220; --chip: #233142; --chip-text: #cfe0f2; --code: #262624;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935; --grid: #2c2c29;
  --accent: #7fb0e0; --accent-text: #0f1a24; --bar: #3987e5; --ok: #6cc290; --warn: #e0a85a; --danger: #f08a82;
  --ok-bg: #1d3326; --warn-bg: #3a2c18; --danger-bg: #3a2220; --chip: #233142; --chip-text: #cfe0f2; --code: #262624;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
.topbar { background: var(--surface); border-bottom: 1px solid var(--border); }
.topbar-inner { max-width: 1200px; margin: 0 auto; padding: 10px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; }
.brand { font-weight: 700; margin-right: 8px; }
.nav { display: flex; flex-wrap: wrap; gap: 2px; flex: 1; }
.nav a { color: var(--text); text-decoration: none; padding: 4px 10px; border-radius: 6px; font-size: 0.92rem; }
.nav a:hover { background: var(--bg); }
.nav a[aria-current="page"] { background: var(--chip); color: var(--chip-text); font-weight: 600; }
.who { font-size: 0.85rem; color: var(--muted); }
.who.ok { color: var(--ok); }
main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 64px; }
h1 { font-size: 1.35rem; margin: 0 0 4px; }
h2 { font-size: 1.02rem; margin: 26px 0 10px; }
.sub { color: var(--muted); margin: 0 0 16px; font-size: 0.92rem; }
.note { color: var(--muted); font-size: 0.86rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.card h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 6px; font-weight: 600; }
.big { font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.rows { font-size: 0.88rem; margin-top: 6px; }
.rows div { display: flex; justify-content: space-between; gap: 8px; }
.rows a { text-decoration: none; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
.chip { display: inline-block; background: var(--chip); color: var(--chip-text); border-radius: 6px; padding: 1px 8px; margin: 1px 4px 1px 0; font-size: 0.82rem; overflow-wrap: anywhere; }
.chip.muted { background: var(--code); color: var(--muted); }
.chip button { border: 0; background: none; color: inherit; cursor: pointer; padding: 0 0 0 4px; font: inherit; }
.badge { display: inline-block; border-radius: 6px; padding: 1px 8px; font-size: 0.8rem; white-space: nowrap; border: 1px solid var(--border); margin: 1px 4px 1px 0; }
.badge.good { background: var(--ok-bg); border-color: transparent; }
.badge.warn { background: var(--warn-bg); border-color: transparent; }
.badge.bad { background: var(--danger-bg); border-color: transparent; }
.badge .sign { font-weight: 700; margin-right: 4px; }
.badge.good .sign { color: var(--ok); } .badge.warn .sign { color: var(--warn); } .badge.bad .sign { color: var(--danger); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
input[type=text], input[type=search], select, textarea { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 0.88rem; min-width: 0; }
button { border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit; font-size: 0.9rem; background: var(--surface); color: var(--text); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.danger { color: var(--danger); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.facets { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0; font-size: 0.86rem; }
.facet { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.facet > span { color: var(--muted); margin-right: 2px; }
.facet button { padding: 2px 9px; border-radius: 999px; font-size: 0.82rem; }
.facet button[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.facet .n { color: var(--muted); margin-left: 4px; font-variant-numeric: tabular-nums; }
.linkish { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-align: left; }
pre { background: var(--code); border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-size: 0.8rem; line-height: 1.4; max-height: 480px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
details summary { cursor: pointer; color: var(--muted); font-size: 0.88rem; }
.more { display: none; margin: 12px auto; }
.empty { text-align: center; color: var(--muted); padding: 28px 0; }
.toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 8px; font-size: 0.9rem; display: none; z-index: 10; max-width: 90vw; }
`;

const HELPERS = `
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString());
const bytes = (n) => { if (n === null || n === undefined) return "–"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + " " + u[i]; };
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "–");
function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return s + " s ago"; if (s < 5400) return Math.round(s / 60) + " min ago"; if (s < 129600) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " days ago";
}
async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Request failed (" + res.status + ")");
  return body;
}
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "Request failed (" + res.status + ")");
  return out;
}
function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message; t.style.display = "block";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.style.display = "none"; }, 4000);
}
const bookLink = (id, title) => '<a href="/admin/books/' + encodeURIComponent(id) + '">' + esc(title || id) + "</a>";
// Vocabulary tags are slugs; pages show their titles, with the slug on hover.
const VOCAB = fetch("/api/vocabulary").then((r) => r.json()).then((v) => new Map(v.tags.map((t) => [t.tag, t.label]))).catch(() => new Map());
let LABELS = new Map();
VOCAB.then((m) => { LABELS = m; });
const tagChip = (tag, extra) => '<span class="chip" title="' + esc(tag) + '">' + esc(LABELS.get(tag) || tag) + (extra || "") + "</span>";
// State names and tones shared by the book pages; every badge carries a sign and words, never colour alone.
const STATES = {
  category: { uncategorized: ["Uncategorized", "○", "warn"], categorized: ["Categorized", "✓", "good"], pending: ["Proposal pending", "?", "warn"], not_applied: ["Approved, not in Calibre", "↻", "warn"] },
  citekey: { calibre: ["Set in Calibre", "✓", "good"], pinned: ["Pinned", "✓", "good"], ready: ["Ready to file", "→", ""], blocked: ["Blocked", "!", "bad"] },
  isbn: { valid: ["ISBN", "✓", "good"], invalid: ["Invalid ISBN", "!", "bad"], printed: ["Printed ISBN only", "?", "warn"], none: ["No ISBN", "○", ""] },
  problem: { failed: ["Extraction failed", "!", "bad"], no_file: ["No readable file", "!", "bad"], no_text: ["No text layer", "!", "warn"], no_outline: ["No outline", "○", "warn"] },
};
const badge = (group, key) => { const [name, sign, tone] = (STATES[group] || {})[key] || [key, "", ""]; return '<span class="badge ' + tone + '"><span class="sign" aria-hidden="true">' + esc(sign) + "</span>" + esc(name) + "</span>"; };
// Who is signed in: every change needs Cloudflare Access; direct LAN access is read-only.
const ME = fetch("/api/whoami").then((r) => r.json()).catch(() => ({ can_write: false, reason: "Could not check sign-in." }));
ME.then((me) => {
  const el = document.getElementById("who");
  el.textContent = me.can_write ? "Signed in as " + (me.identity.email || me.identity.subject) : "Read-only";
  el.title = me.can_write ? "" : me.reason || "";
  el.className = "who" + (me.can_write ? " ok" : "");
});
`;

export function page(opts: { title: string; nav: NavKey; body: string; script: string; css?: string }): string {
  const nav = NAV.map(([key, label, href]) => `<a href="${href}"${key === opts.nav ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
${FAVICON_LINK}
<style>${CSS}${opts.css ?? ""}</style>
</head>
<body>
<header class="topbar"><div class="topbar-inner"><span class="brand">Corpus Admin</span><nav class="nav" aria-label="Admin pages">${nav}</nav><span id="who" class="who">Checking sign-in…</span></div></header>
<main>
${opts.body}
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>${HELPERS}</script>
<script>${opts.script}</script>
</body>
</html>
`;
}
