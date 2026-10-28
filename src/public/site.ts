import { CSS } from "../web/layout.js";
import type { PublicStore } from "./store.js";

/**
 * The public site: the library's catalogue, read from the public snapshot (src/public/snapshot.ts) and
 * nothing else, so it can show only what was published. Pages are rendered on the server, the same way on
 * the LAN and in a Worker; `site.json` and the key list let another public site link to these pages.
 *
 *   /                      the front page: counts, search, shelves, top-level subjects, other sites
 *   /books[?q=]            books by author, or matching a search over titles, authors, and subjects
 *   /books/<id>            one book's catalogue entry, with links to it on other sites
 *   /subjects[/<tag>]      the subject tree, and the books under a subject
 *   /shelves[/<id>]        Calibre-Web's public shelves
 *   /site.json             this site, for other sites (version 1)
 *   /api/public/citekeys   each book's citekeys and Zotero item keys, to the path of its page
 */

export interface PublicResponse { status: number; type: string; body: string; etag?: string }

interface Book {
  id: string; title: string; authors: string; year: number | null; publisher: string | null; language: string | null; isbn: string | null;
  format: string | null; citekeys: string; zotero_keys: string;
}
interface Subject { tag: string; name: string; label: string; parent: string | null; books: number }
interface Shelf { id: number; name: string; books: number }
interface Site { url: string; name: string; kind: string }

const PAGE = 50;

const SITE_CSS = `
.intro { max-width: 46rem; }
form.search { display: flex; gap: 8px; margin: 14px 0; max-width: 40rem; }
form.search input { flex: 1; }
.books { list-style: none; padding: 0; margin: 0; }
.books li { padding: 6px 0; border-bottom: 1px solid var(--grid); }
.books .by { color: var(--muted); font-size: 0.9rem; }
.tree, .tree ul { list-style: none; margin: 0; padding-left: 0; }
.tree ul { padding-left: 18px; }
.tree li { padding: 2px 0; }
.count { color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
dl.entry { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 16px 0; }
dl.entry dt { color: var(--muted); }
dl.entry dd { margin: 0; overflow-wrap: anywhere; }
.pager { display: flex; gap: 12px; margin: 14px 0; }
`;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (n: number) => n.toLocaleString("en");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const bookHref = (id: string) => `/books/${encodeURIComponent(id)}`;
const subjectHref = (tag: string) => `/subjects/${encodeURIComponent(tag)}`;
const authorsOf = (b: Pick<Book, "authors">) => (JSON.parse(b.authors) as string[]).join(", ");

type Section = "home" | "books" | "subjects" | "shelves";

async function page(store: PublicStore, title: string | null, section: Section, body: string): Promise<string> {
  const site = await siteTitle(store);
  const nav: [Section, string, string][] = [["home", "Home", "/"], ["books", "Books", "/books"], ["subjects", "Subjects", "/subjects"], ["shelves", "Shelves", "/shelves"]];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${esc(title)} · ` : ""}${esc(site)}</title><style>${CSS}${SITE_CSS}</style></head><body>
<header class="topbar"><div class="topbar-inner"><a class="brand" href="/" style="color:inherit;text-decoration:none">${esc(site)}</a><nav class="nav">
${nav.map(([k, label, href]) => `<a href="${href}"${k === section ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
</nav></div></header><main>${body}</main></body></html>`;
}

async function meta(store: PublicStore, key: string): Promise<string | null> {
  return (await store.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", key))?.value ?? null;
}

async function siteTitle(store: PublicStore): Promise<string> {
  return (await meta(store, "title")) || "Library";
}

const searchForm = (q = "") => `<form class="search" method="get" action="/books"><input type="search" name="q" value="${esc(q)}" placeholder="Title, author, or subject" aria-label="Search the catalogue"><button>Search</button></form>`;

function bookList(books: Book[]): string {
  if (!books.length) return '<p class="empty">No books.</p>';
  return `<ul class="books">${books.map((b) => `<li><a href="${bookHref(b.id)}">${esc(b.title)}</a>${b.year ? ` <span class="count">(${b.year})</span>` : ""}<div class="by">${esc(authorsOf(b))}</div></li>`).join("")}</ul>`;
}

function pager(path: string, params: URLSearchParams, total: number, offset: number): string {
  if (total <= PAGE) return "";
  const at = (o: number) => {
    const p = new URLSearchParams(params);
    if (o) p.set("offset", String(o));
    else p.delete("offset");
    const qs = p.toString();
    return `${path}${qs ? `?${qs}` : ""}`;
  };
  return `<div class="pager">${offset > 0 ? `<a href="${at(Math.max(offset - PAGE, 0))}">← Previous</a>` : ""}<span class="count">${num(offset + 1)}–${num(Math.min(offset + PAGE, total))} of ${num(total)}</span>${offset + PAGE < total ? `<a href="${at(offset + PAGE)}">Next →</a>` : ""}</div>`;
}

/** Words for FTS5, each quoted so nothing typed is read as syntax, the last one as a prefix. */
function ftsQuery(q: string): string | null {
  const words = q.split(/\s+/).map((w) => w.replace(/"/g, "")).filter(Boolean);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

const offsetOf = (params: URLSearchParams) => Math.max(Number.parseInt(params.get("offset") ?? "0", 10) || 0, 0);

async function home(store: PublicStore): Promise<string> {
  const count = async (t: string) => (await store.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
  const [books, shelves, top, sites] = await Promise.all([
    count("books"),
    store.all<Shelf>("SELECT * FROM shelves WHERE books > 0 ORDER BY name"),
    store.all<Subject>("SELECT * FROM subjects WHERE parent IS NULL ORDER BY name"),
    store.all<Site>("SELECT url, name, kind FROM sites ORDER BY name"),
  ]);
  const title = await siteTitle(store);
  return page(store, null, "home", `<h1>${esc(title)}</h1>
<p class="sub">${plural(books, "book")} in the catalogue. Book text isn't published here, only the catalogue.</p>
${searchForm()}
${shelves.length ? `<h2>Shelves</h2><div class="grid">${shelves.map((s) => `<a class="card" style="text-decoration:none" href="/shelves/${s.id}"><h3>${esc(s.name)}</h3><div>${plural(s.books, "book")}</div></a>`).join("")}</div>` : ""}
${top.length ? `<h2>Subjects</h2><ul class="tree">${top.map((s) => `<li><a href="${subjectHref(s.tag)}">${esc(s.name)}</a> <span class="count">${num(s.books)}</span></li>`).join("")}</ul>` : ""}
${sites.length ? `<h2>Elsewhere</h2><ul class="tree">${sites.map((s) => `<li><a href="${esc(s.url)}/">${esc(s.name)}</a></li>`).join("")}</ul>` : ""}`);
}

async function books(store: PublicStore, params: URLSearchParams): Promise<string> {
  const q = params.get("q")?.trim() ?? "";
  const offset = offsetOf(params);
  const match = ftsQuery(q);
  if (q && !match) return page(store, "Books", "books", `<h1>Books</h1>${searchForm(q)}<p class="empty">No books.</p>`);
  const [total, list] = match
    ? await Promise.all([
      store.first<{ n: number }>("SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?", match),
      store.all<Book>(`SELECT b.* FROM books_fts f JOIN books b ON b.id = f.book_id WHERE books_fts MATCH ? ORDER BY rank LIMIT ${PAGE} OFFSET ?`, match, offset),
    ])
    : await Promise.all([
      store.first<{ n: number }>("SELECT COUNT(*) AS n FROM books"),
      store.all<Book>(`SELECT * FROM books ORDER BY sort LIMIT ${PAGE} OFFSET ?`, offset),
    ]);
  return page(store, q ? `“${q}”` : "Books", "books", `<h1>Books</h1>
<p class="sub">${q ? `${plural(total!.n, "book")} matching “${esc(q)}”` : `${plural(total!.n, "book")}, by author`}</p>
${searchForm(q)}${bookList(list)}${pager("/books", params, total!.n, offset)}`);
}

async function book(store: PublicStore, id: string): Promise<string | null> {
  const b = await store.first<Book>("SELECT * FROM books WHERE id = ?", id);
  if (!b) return null;
  const [subjects, shelves, links] = await Promise.all([
    store.all<Subject>("SELECT s.* FROM book_subjects bs JOIN subjects s ON s.tag = bs.tag WHERE bs.book_id = ? ORDER BY s.label", id),
    store.all<Shelf>("SELECT s.* FROM book_shelves bs JOIN shelves s ON s.id = bs.shelf_id WHERE bs.book_id = ? ORDER BY s.name", id),
    store.all<Site & { path: string }>("SELECT s.url, s.name, s.kind, l.path FROM links l JOIN sites s ON s.url = l.site_url WHERE l.book_id = ? ORDER BY s.name", id),
  ]);
  const citekeys = JSON.parse(b.citekeys) as string[];
  const rows: [string, string][] = [
    ["Authors", esc(authorsOf(b))],
    ...(b.year ? [["Year", String(b.year)] as [string, string]] : []),
    ...(b.publisher ? [["Publisher", esc(b.publisher)] as [string, string]] : []),
    ...(b.isbn ? [["ISBN", esc(b.isbn)] as [string, string]] : []),
    ...(b.language ? [["Language", esc(b.language)] as [string, string]] : []),
    ...(b.format ? [["Format", esc(b.format.toUpperCase())] as [string, string]] : []),
    ...(subjects.length ? [["Subjects", subjects.map((s) => `<a class="chip" href="${subjectHref(s.tag)}">${esc(s.label)}</a>`).join("")] as [string, string]] : []),
    ...(shelves.length ? [["Shelves", shelves.map((s) => `<a class="chip muted" href="/shelves/${s.id}">${esc(s.name)}</a>`).join("")] as [string, string]] : []),
    ...(citekeys.length ? [["Citekey", citekeys.map((k) => `<code>${esc(k)}</code>`).join(", ")] as [string, string]] : []),
  ];
  const elsewhere = links.map((l) => `<li><a href="${esc(l.url)}${esc(l.path)}">${l.kind === "quotes" ? "Quotes from this book" : "This book"} on ${esc(l.name)}</a></li>`).join("");
  return page(store, b.title, "books", `<p><a href="/books">← Books</a></p><h1>${esc(b.title)}</h1>
<dl class="entry">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
${elsewhere ? `<h2>Elsewhere</h2><ul class="tree">${elsewhere}</ul>` : ""}`);
}

async function subjects(store: PublicStore): Promise<string> {
  const all = await store.all<Subject>("SELECT * FROM subjects ORDER BY name");
  const children = new Map<string | null, Subject[]>();
  for (const s of all) children.set(s.parent, [...(children.get(s.parent) ?? []), s]);
  const tree = (parent: string | null): string => {
    const list = children.get(parent);
    return list ? `<ul${parent === null ? ' class="tree"' : ""}>${list.map((s) => `<li><a href="${subjectHref(s.tag)}">${esc(s.name)}</a> <span class="count">${num(s.books)}</span>${tree(s.tag)}</li>`).join("")}</ul>` : "";
  };
  return page(store, "Subjects", "subjects", `<h1>Subjects</h1><p class="sub">Each count includes the books under narrower subjects.</p>${all.length ? tree(null) : '<p class="empty">No subjects yet.</p>'}`);
}

async function subject(store: PublicStore, tag: string, params: URLSearchParams): Promise<string | null> {
  const s = await store.first<Subject>("SELECT * FROM subjects WHERE tag = ?", tag);
  if (!s) return null;
  const offset = offsetOf(params);
  const under = "SELECT DISTINCT book_id FROM book_subjects WHERE tag = ? OR tag LIKE ? ESCAPE '\\'";
  const prefix = `${tag.replace(/[\\%_]/g, (c) => `\\${c}`)}.%`;
  const [narrower, list, parent] = await Promise.all([
    store.all<Subject>("SELECT * FROM subjects WHERE parent = ? ORDER BY name", tag),
    store.all<Book>(`SELECT * FROM books WHERE id IN (${under}) ORDER BY sort LIMIT ${PAGE} OFFSET ?`, tag, prefix, offset),
    s.parent ? store.first<Subject>("SELECT * FROM subjects WHERE tag = ?", s.parent) : Promise.resolve(null),
  ]);
  return page(store, s.name, "subjects", `<p><a href="${parent ? subjectHref(parent.tag) : "/subjects"}">← ${esc(parent?.name ?? "Subjects")}</a></p>
<h1>${esc(s.name)}</h1><p class="sub">${esc(s.label)} · ${plural(s.books, "book")}</p>
${narrower.length ? `<h2>Narrower subjects</h2><ul class="tree">${narrower.map((n) => `<li><a href="${subjectHref(n.tag)}">${esc(n.name)}</a> <span class="count">${num(n.books)}</span></li>`).join("")}</ul>` : ""}
<h2>Books</h2>${bookList(list)}${pager(subjectHref(tag), params, s.books, offset)}`);
}

async function shelves(store: PublicStore): Promise<string> {
  const list = await store.all<Shelf>("SELECT * FROM shelves WHERE books > 0 ORDER BY name");
  return page(store, "Shelves", "shelves", `<h1>Shelves</h1>${list.length
    ? `<ul class="tree">${list.map((s) => `<li><a href="/shelves/${s.id}">${esc(s.name)}</a> <span class="count">${num(s.books)}</span></li>`).join("")}</ul>`
    : '<p class="empty">No shelves.</p>'}`);
}

async function shelf(store: PublicStore, id: number, params: URLSearchParams): Promise<string | null> {
  const s = await store.first<Shelf>("SELECT * FROM shelves WHERE id = ?", id);
  if (!s) return null;
  const offset = offsetOf(params);
  const list = await store.all<Book>(`SELECT b.* FROM book_shelves bs JOIN books b ON b.id = bs.book_id WHERE bs.shelf_id = ? ORDER BY bs.ord, b.sort LIMIT ${PAGE} OFFSET ?`, id, offset);
  return page(store, s.name, "shelves", `<p><a href="/shelves">← Shelves</a></p><h1>${esc(s.name)}</h1><p class="sub">${plural(s.books, "book")}</p>${bookList(list)}${pager(`/shelves/${id}`, params, s.books, offset)}`);
}

async function siteJson(store: PublicStore): Promise<unknown> {
  return { version: 1, name: await siteTitle(store), kind: "library", url: (await meta(store, "url")) ?? "", level: "catalogue", citekeys: "/api/public/citekeys" };
}

async function keyList(store: PublicStore): Promise<unknown> {
  const citekeys: Record<string, string> = {};
  const zotero: Record<string, string> = {};
  for (const b of await store.all<Pick<Book, "id" | "citekeys" | "zotero_keys">>("SELECT id, citekeys, zotero_keys FROM books ORDER BY id")) {
    for (const k of JSON.parse(b.citekeys) as string[]) citekeys[k] ??= bookHref(b.id);
    for (const k of JSON.parse(b.zotero_keys) as string[]) zotero[k] ??= bookHref(b.id);
  }
  return { citekeys, zotero_keys: zotero };
}

/** True for the paths the public site serves, on the LAN server's shared port and on its own. */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/site.json" || pathname === "/api/public/citekeys"
    || /^\/(books|subjects|shelves)(\/[^/]+)?$/.test(pathname);
}

/** A public page or JSON document from the snapshot; null for a path that isn't public. */
export async function renderPublic(store: PublicStore, pathname: string, params = new URLSearchParams()): Promise<PublicResponse | null> {
  if (!isPublicPath(pathname)) return null;
  const etag = `"${(await meta(store, "hash")) ?? ""}"`;
  const html = (body: string | null): PublicResponse =>
    body === null ? { status: 404, type: "text/html; charset=utf-8", body: "<!doctype html><title>Not found</title><p>Not found.</p>" } : { status: 200, type: "text/html; charset=utf-8", body, etag };
  const json = (value: unknown): PublicResponse => ({ status: 200, type: "application/json", body: JSON.stringify(value), etag });
  const segment = pathname.split("/")[2];
  const id = segment === undefined ? undefined : decodeURIComponent(segment);
  if (pathname === "/") return html(await home(store));
  if (pathname === "/site.json") return json(await siteJson(store));
  if (pathname === "/api/public/citekeys") return json(await keyList(store));
  if (pathname.startsWith("/books")) return html(id === undefined ? await books(store, params) : await book(store, id));
  if (pathname.startsWith("/subjects")) return html(id === undefined ? await subjects(store) : await subject(store, id, params));
  if (id === undefined) return html(await shelves(store));
  return html(/^\d+$/.test(id) ? await shelf(store, Number(id), params) : null);
}
