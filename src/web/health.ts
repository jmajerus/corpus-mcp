import { page } from "./layout.js";

/** /admin/health: what the last library check found. Read-only for now; actions come with their own previews. */
export const HEALTH_HTML = page({
  title: "Library health", nav: "health",
  css: `.summary{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.summary a{text-decoration:none}.stat{border:1px solid var(--border);border-radius:8px;padding:6px 12px;background:var(--surface)}.stat b{font-size:1.15rem;margin-right:6px}.stat.ok{opacity:.65}.files{margin:4px 0 0;padding-left:18px}.files li{margin:2px 0}section.card{margin:16px 0}h2 .note{font-weight:normal}.kind{font-size:.8rem;padding:1px 7px;border-radius:9px;background:var(--chip);color:var(--chip-text);margin-left:6px}`,
  body: `<h1>Library health</h1>
<p class="sub">Compares Calibre's catalogue (metadata.db) with the folders on disk and Calibre-Web's links, on the Calibre-Web host. The check only reads: nothing here changes the library. It runs once a day, and whenever you choose <em>Check now</em>.</p>
<div class="actions"><button id="check" disabled>Check now</button><span id="checked" class="note"></span></div>
<p id="status" role="status" aria-live="polite"></p>
<div id="summary" class="summary"></div>
<div id="sections">Loading…</div>`,
  script: `
let canWrite = false, checking = false;
const plural = (n, one, many) => num(n) + " " + (n === 1 ? one : (many || one + "s"));
const refsText = (refs) => Object.entries(refs || {}).map(([k, v]) => k.replace(/_/g, " ") + ": " + v).join(", ");
const KINDS = {
  leftover: ["Leftover", "Every book file in it matches a file of a book in the library. Usually what Calibre left behind when it moved a book's folder, or a book deleted without its folder."],
  lost: ["Lost book", "It has a book file that matches nothing in the library: a book Calibre no longer lists. Re-add it, or remove the folder if you don't want it."],
  empty: ["No book files", "Only a cover or metadata file."],
};
function section(id, title, count, intro, rows) {
  if (!count) return "";
  return '<section class="card" id="' + id + '"><h2>' + esc(title) + ' <span class="note">' + num(count) + '</span></h2>' + (intro ? '<p class="note">' + intro + '</p>' : '') + rows + '</section>';
}
function table(head, rows) {
  return '<div class="scroll"><table><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}
function more(shown, total) { return shown < total ? '<p class="note">Showing ' + num(shown) + ' of ' + num(total) + '.</p>' : ''; }
function render(data) {
  const r = data.report;
  if (!r) {
    document.getElementById('checked').textContent = 'Not checked yet.';
    document.getElementById('summary').innerHTML = '';
    document.getElementById('sections').innerHTML = '<p>No check has run yet. Choose <em>Check now</em>.</p>';
    return;
  }
  const c = r.counts;
  document.getElementById('checked').innerHTML = 'Last checked ' + esc(when(r.checked_at)) + ' (' + esc(ago(r.checked_at)) + '), ' + plural(r.records, 'record') + '.' + (data.job_id ? ' <a href="/admin/jobs/' + data.job_id + '">Job #' + data.job_id + '</a>' : '');
  const stat = (n, label, anchor) => '<a href="#' + anchor + '" class="stat' + (n ? '' : ' ok') + '"><b>' + num(n) + '</b>' + esc(label) + '</a>';
  document.getElementById('summary').innerHTML = [
    stat(c.records_missing, 'records with missing files', 'missing'), stat(c.orphans, 'folders with no record', 'orphans'),
    stat(c.cover_unflagged, 'covers not recorded', 'covers'), stat(c.app_db_missing_links, 'Calibre-Web links to gone books', 'appdb'),
    stat(c.strays, 'other items in the library folder', 'strays'), stat(c.corpus_backups, 'corpus-mcp backups in the library folder', 'backups'),
  ].join('');
  const missing = section('missing', 'Records with missing files', c.records_missing,
    'Calibre lists these books, but their folder or files are not on disk. Before removing one, check its saved references and whether another copy exists.',
    table(['Book', 'Folder', 'Missing', 'Saved references', 'Other copies'], r.records_missing.map((m) => '<tr><td>' + bookLink(m.book_id, m.title) + '<br><span class="note">' + esc(m.book_id) + '</span></td><td class="path">' + esc(m.path) + '</td><td>'
      + esc([m.folder_missing ? 'the whole folder' : '', m.formats_missing.length ? m.formats_missing.join(', ') : '', m.cover_missing ? 'cover' : ''].filter(Boolean).join('; ')) + '</td><td>' + esc(refsText(m.references) || 'none') + '</td><td>'
      + (m.copies.length ? m.copies.map((x) => bookLink(x.book_id, x.title) + ' <span class="note">' + esc(x.book_id) + '</span>').join('<br>') : '<span class="note">none found</span>') + '</td></tr>')) + more(r.records_missing.length, c.records_missing));
  const orphans = section('orphans', 'Folders with no record', c.orphans,
    'Book folders on disk that no record in metadata.db points to. ' + num(c.orphans_leftover) + ' leftover, ' + num(c.orphans_lost) + ' lost, ' + num(c.orphans_empty) + ' with no book files.',
    table(['Folder', 'Kind', 'Files', 'Record with this id'], r.orphans.map((o) => '<tr><td class="path">' + esc(o.path) + '<br><span class="note">' + esc(bytes(o.bytes)) + '</span></td><td><span class="kind" title="' + esc(KINDS[o.kind][1]) + '">' + esc(KINDS[o.kind][0]) + '</span></td><td>'
      + (o.files.length ? '<ul class="files">' + o.files.map((f) => '<li>' + esc(f.file) + ' <span class="note">' + esc(bytes(f.bytes)) + '</span>' + (f.matches.length ? ': same file as ' + f.matches.map((m) => bookLink(m.book_id, m.title || m.book_id) + ' (' + esc(m.format) + ')').join(', ') : ': <span class="warning">not found elsewhere</span>') + '</li>').join('') + '</ul>' : '<span class="note">none</span>')
      + '</td><td>' + (o.record ? (o.book_id ? bookLink(o.book_id, o.record.title) : esc(o.record.title)) + '<br><span class="note">' + esc(o.record.path) + (o.record.folder_exists ? '' : ' (also missing)') + '</span>' : '<span class="note">none</span>') + '</td></tr>')) + more(r.orphans.length, c.orphans));
  const covers = section('covers', 'Covers not recorded', c.cover_unflagged, 'These folders have a cover.jpg, but metadata.db says the book has no cover, so Calibre and Calibre-Web show none.',
    table(['Book', 'Folder'], r.cover_unflagged.map((x) => '<tr><td>' + bookLink(x.book_id, x.title) + '</td><td class="path">' + esc(x.path) + '</td></tr>')) + more(r.cover_unflagged.length, c.cover_unflagged));
  const appdb = !r.app_db.checked ? '<section class="card" id="appdb"><h2>Calibre-Web links</h2><p class="note">Calibre-Web\\'s app.db could not be read, so its links were not checked.</p></section>'
    : section('appdb', 'Calibre-Web links to books that are gone', c.app_db_missing_links, 'Shelf memberships, reading status, bookmarks and the like for Calibre ids no record has. Calibre-Web stores only the id, so a link to an id Calibre gave to a newer book would point at the wrong book; this check cannot see that case.',
      table(['Table', 'Calibre id', 'Links'], r.app_db.missing_links.map((l) => '<tr><td>' + esc(l.table) + '</td><td>' + esc(l.book_id) + '</td><td>' + num(l.count) + '</td></tr>')) + more(r.app_db.missing_links.length, c.app_db_missing_links));
  const strays = section('strays', 'Other items in the library folder', c.strays, 'Files and folders Calibre does not expect: files at the top or in an author folder, and folders without a book id.',
    table(['Path', 'Kind', 'Size'], r.strays.map((x) => '<tr><td class="path">' + esc(x.path) + '</td><td>' + esc(x.kind) + '</td><td>' + esc(bytes(x.bytes)) + '</td></tr>')) + more(r.strays.length, c.strays));
  const b = r.backups;
  const backups = '<section class="card" id="backups"><h2>Backups</h2>'
    + (c.corpus_backups ? '<p><b>' + plural(c.corpus_backups, 'corpus-mcp backup') + '</b> (' + esc(bytes(r.corpus_backups.bytes)) + ') are still in the library folder, where Calibre\\'s own library check lists each as an invalid book. New backups go to the folder below.</p>' : '<p>No corpus-mcp backups in the library folder.</p>')
    + (b ? '<p>Backup folder: <span class="path">' + esc(b.dir) + '</span>: ' + (b.exists ? plural(b.count, 'backup') + ', ' + esc(bytes(b.bytes)) + '. Each write job prunes it to the newest 20, plus any from the last 30 days.' : 'not created yet; the next write job creates it.') + '</p>' : '')
    + '</section>';
  const body = missing + orphans + covers + appdb + strays + backups;
  document.getElementById('sections').innerHTML = (c.records_missing || c.orphans || c.cover_unflagged || c.app_db_missing_links || c.strays || c.corpus_backups ? '' : '<p>No problems found.</p>') + body;
}
async function load() {
  try { render(await api('/api/health')); } catch (e) { document.getElementById('sections').textContent = e.message; }
}
document.getElementById('check').addEventListener('click', async () => {
  if (checking) return;
  checking = true;
  const button = document.getElementById('check'), status = document.getElementById('status');
  button.disabled = true;
  try {
    const out = await post('/api/admin/jobs', { kind: 'health', mode: 'apply' });
    const link = '<a href="/admin/jobs/' + out.id + '">Job #' + out.id + '</a>';
    status.innerHTML = 'Checking the library… ' + link;
    let job;
    do { await new Promise((resolve) => setTimeout(resolve, 1000)); job = await api('/api/admin/jobs/' + out.id); } while (job.status === 'running');
    await load();
    status.innerHTML = job.status === 'succeeded' ? 'Checked. ' + link : 'The check did not complete. ' + link;
  } catch (e) { status.textContent = e.message; } finally { checking = false; button.disabled = !canWrite; }
});
ME.then((me) => { canWrite = me.can_write; document.getElementById('check').disabled = !canWrite; });
load();`,
});
