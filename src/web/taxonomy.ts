import { page } from "./layout.js";

/** /admin/taxonomy: where the vocabulary comes from, how far corpus-mcp follows terminology-mcp, and the provisional terms. */
export const TAXONOMY_HTML = page({
  title: "Taxonomy",
  nav: "taxonomy",
  css: `
.term { margin-bottom: 12px; }
.term h3 { font-size: 1rem; margin: 0; text-transform: none; letter-spacing: 0; color: var(--text); }
.meta { color: var(--muted); font-size: 0.86rem; margin: 2px 0 8px; }
.path { font-size: 0.82rem; background: var(--code); border-radius: 4px; padding: 0 4px; }
.scope { font-size: 0.92rem; margin: 8px 0; padding-left: 10px; border-left: 3px solid var(--border); }`,
  body: `
<h1>Taxonomy</h1>
<p class="sub" id="lead">The tag vocabulary.</p>
<section class="grid" id="summary"></section>
<h2>Provisional terms</h2>
<p class="note">Proposed in terminology-mcp (agents use add_provisional_term) and usable for tagging now. Its owner confirms, merges, or retires them there.</p>
<section id="list" aria-live="polite"></section>`,
  script: `
const card = (title, big, rows) => '<div class="card"><h3>' + esc(title) + '</h3><div class="big">' + big + '</div><div class="rows">' + rows.map(([k, v]) => "<div><span>" + esc(k) + "</span><span>" + v + "</span></div>").join("") + "</div></div>";
const short = (v) => (v ? '<code title="' + esc(v) + '">' + esc(String(v).slice(0, 26)) + (String(v).length > 26 ? "…" : "") + "</code>" : "–");
// terminology-mcp's editor: on this host's name for it through the tunnel, else its LAN address.
const editor = (t) => /^corpus-mcp[.:]/.test(location.host) ? location.protocol + "//" + location.host.replace(/^corpus-mcp/, "terminology-mcp") + "/" : t.url + "/";
function render(data) {
  const v = data.vocabulary, t = data.terminology;
  document.getElementById("lead").innerHTML = t
    ? 'Followed from terminology-mcp\\'s <code>cc-subjects</code> scheme, where terms are added, renamed, and moved: <a href="' + esc(editor(t)) + '">open its editor</a>. A change that alters a tag retires the old one; the tags job re-tags books when there is one replacement, and the <a href="/admin/categories">vocabulary report</a> lists the rest for a person.'
    : "Installed by Concept Clusters' push (CORPUS_TERMINOLOGY_URL is off).";
  document.getElementById("summary").innerHTML =
    card("Vocabulary", num(v.assignable), [["Terms", num(v.terms)], ["Retired tags", num(v.retired)], ["Version", short(v.version)], ["Problem", v.error ? esc(v.error) : "none"]]) +
    (t ? card("Following terminology-mcp", t.through ? "#" + num(t.through) : "–", [["Synced", t.synced_at ? esc(ago(t.synced_at)) : "not yet"], ["Reported", t.reported_at ? esc(ago(t.reported_at)) : "not yet"],
      ["Every", num(t.every_seconds) + " s"], ["Problem", t.error ? esc(t.error) : "none"]]) : "");
  document.getElementById("list").innerHTML = data.provisional.length ? data.provisional.map((p) =>
    '<article class="card term"><h3>' + esc(p.label) + '</h3><div class="meta"><span class="path">' + esc(p.tag) + "</span> · " +
    '<a href="/admin/books?tag=' + encodeURIComponent(p.tag) + '">' + num(p.books) + " book" + (p.books === 1 ? "" : "s") + "</a></div>" +
    (p.scopeNote ? '<p class="scope">' + esc(p.scopeNote) + "</p>" : "") + "</article>").join("") : '<p class="empty">No provisional terms.</p>';
}
api("/api/taxonomy").then(render, (e) => toast(e.message));`,
});
