import { createHash } from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { pinnedByUuid } from "../data.js";
import { type BookRow, type Corpus, effectiveCitekey } from "../tools.js";
import { zoteroMatch } from "../zotero.js";

/**
 * The public snapshot: the library's catalogue as the public site may show it, copied out of the index
 * and data.db into a SQLite database of its own. The public pages (src/public/site.ts) read only this,
 * on the LAN and, once it is replicated to D1, in a Worker. The rules for what's public are applied here
 * and nowhere else: book text, page images, quotes, proposals, and the change log are never copied, so
 * no page can show them.
 *
 * A book's keys for linking with other sites (see `site.json`) are real keys only: its citekey from
 * Calibre or a pin, and the Zotero item the mirror matched it to, with that item's citekey. A proposed
 * citekey isn't a key anywhere yet, so it's left out.
 */

export const SNAPSHOT_VERSION = 1;

export const SNAPSHOT_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE books (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL, year INTEGER, publisher TEXT, language TEXT, isbn TEXT,
  format TEXT, citekeys TEXT NOT NULL, zotero_keys TEXT NOT NULL, sort TEXT NOT NULL
);
CREATE TABLE subjects (tag TEXT PRIMARY KEY, name TEXT NOT NULL, label TEXT NOT NULL, parent TEXT, books INTEGER NOT NULL);
CREATE TABLE book_subjects (book_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (book_id, tag));
CREATE INDEX book_subjects_tag ON book_subjects (tag);
CREATE TABLE shelves (id INTEGER PRIMARY KEY, name TEXT NOT NULL, books INTEGER NOT NULL);
CREATE TABLE book_shelves (book_id TEXT NOT NULL, shelf_id INTEGER NOT NULL, ord INTEGER, PRIMARY KEY (book_id, shelf_id));
CREATE INDEX book_shelves_shelf ON book_shelves (shelf_id, ord);
CREATE TABLE sites (url TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, fetched_at TEXT NOT NULL, keys TEXT NOT NULL);
CREATE TABLE links (book_id TEXT NOT NULL, site_url TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (book_id, site_url));
CREATE VIRTUAL TABLE books_fts USING fts5(book_id UNINDEXED, title, authors, subjects, tokenize = 'unicode61 remove_diacritics 2');
`;

/** Another public site, as its `site.json` and key list describe it. */
export interface LinkedSite {
  url: string;
  name: string;
  kind: string;
  fetched_at: string;
  keys: { citekeys: Record<string, string>; zotero_keys: Record<string, string> };
}

export interface SnapshotOptions {
  /** The site's name, shown as its title and given in `site.json`. */
  title: string;
  /** The public base URL, for `site.json`; empty when it has none yet. */
  url: string;
  /** Books carrying any of these Calibre tags are left out (the index already skips them). */
  excludeTags: string[];
  /** The Zotero library the mirror reads ("users/<id>" or "groups/<id>"), for Zotero item keys. */
  zoteroLibrary?: string;
  sites: LinkedSite[];
}

type Row = Record<string, unknown>;

/** Copies what's public into an empty snapshot database. */
function fill(c: Corpus, snap: Database.Database, o: SnapshotOptions): void {
  const insert = (table: string, row: Row) => {
    const keys = Object.keys(row);
    snap.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((k) => `@${k}`).join(", ")})`).run(row);
  };
  const vocabulary = c.vocabulary;
  // By id, grouping terms included: find() leaves those out, but they head the subject tree.
  const terms = new Map(vocabulary.terms.map((t) => [t.tag, t]));
  const excluded = new Set(o.excludeTags.map((t) => t.toLowerCase()));
  const books = (c.db.prepare("SELECT * FROM books ORDER BY id").all() as BookRow[])
    .filter((b) => !(JSON.parse(b.tags) as string[]).some((t) => excluded.has(t.toLowerCase())));

  // Subjects: the vocabulary terms books carry, and the terms above them, so the tree can be browsed.
  const used = new Map<string, Set<string>>();
  const subjectsOf = new Map<string, string[]>();
  for (const b of books) {
    const tags = [...new Set((JSON.parse(b.tags) as string[]).filter((t) => vocabulary.has(t)).map((t) => t.trim().toLowerCase()))];
    subjectsOf.set(b.id, tags);
    for (const tag of tags) {
      for (let t: string | null = tag; t; t = terms.get(t)?.parent ?? null) {
        if (!used.has(t)) used.set(t, new Set());
        used.get(t)!.add(b.id);
      }
    }
  }
  for (const [tag, ids] of used) {
    const term = terms.get(tag);
    if (term) insert("subjects", { tag, name: term.name, label: term.label, parent: term.parent, books: ids.size });
  }

  const links: { book: string; citekeys: string[]; zotero: string[] }[] = [];
  for (const b of books) {
    const pin = b.uuid ? pinnedByUuid(c.data, b.uuid) : undefined;
    const citekeys = new Set<string>();
    const own = effectiveCitekey(b, pin).citekey;
    if (own) citekeys.add(own);
    const zotero: string[] = [];
    if (o.zoteroLibrary) {
      const { match } = zoteroMatch(c, b);
      if (match) {
        zotero.push(`${o.zoteroLibrary}/${match.key}`);
        if (match.citekey) citekeys.add(match.citekey);
      }
    }
    const authors = JSON.parse(b.authors) as string[];
    const sorts = JSON.parse(b.author_sorts) as string[];
    insert("books", {
      id: b.id, title: b.title, authors: b.authors, year: b.year, publisher: b.publisher, language: b.language, isbn: b.isbn, format: b.format,
      citekeys: JSON.stringify([...citekeys]), zotero_keys: JSON.stringify(zotero),
      sort: `${(sorts[0] ?? authors[0] ?? "￿").toLowerCase()}\u0000${b.title.toLowerCase()}`,
    });
    const subjects = subjectsOf.get(b.id)!;
    for (const tag of subjects) insert("book_subjects", { book_id: b.id, tag });
    snap.prepare("INSERT INTO books_fts (book_id, title, authors, subjects) VALUES (?, ?, ?, ?)")
      .run(b.id, b.title, authors.join(", "), subjects.map((t) => terms.get(t)!.label).join("; "));
    links.push({ book: b.id, citekeys: [...citekeys], zotero });
  }

  // Calibre-Web's public shelves, with only the books that are in the catalogue.
  const ids = new Set(books.map((b) => b.id));
  for (const s of c.db.prepare("SELECT id, name FROM shelves ORDER BY name").all() as { id: number; name: string }[]) {
    const members = (c.db.prepare("SELECT book_id, ord FROM book_shelves WHERE shelf_id = ?").all(s.id) as { book_id: string; ord: number | null }[])
      .filter((m) => ids.has(m.book_id));
    insert("shelves", { id: s.id, name: s.name, books: members.length });
    for (const m of members) insert("book_shelves", { book_id: m.book_id, shelf_id: s.id, ord: m.ord });
  }

  // Links to the same book on other sites, matched on either kind of key.
  for (const site of o.sites) {
    insert("sites", { url: site.url, name: site.name, kind: site.kind, fetched_at: site.fetched_at, keys: JSON.stringify(site.keys) });
    for (const l of links) {
      const path = l.zotero.map((k) => site.keys.zotero_keys[k]).find(Boolean) ?? l.citekeys.map((k) => site.keys.citekeys[k]).find(Boolean);
      if (path) insert("links", { book_id: l.book, site_url: site.url, path });
    }
  }

  insert("meta", { key: "version", value: String(SNAPSHOT_VERSION) });
  insert("meta", { key: "title", value: o.title });
  insert("meta", { key: "url", value: o.url });
}

/** A hash of everything in a snapshot but its build time, so an unchanged snapshot is recognised. */
function contentHash(snap: Database.Database): string {
  const hash = createHash("sha256");
  const tables = snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'books_fts%' ORDER BY name").pluck().all() as string[];
  for (const t of tables) {
    hash.update(`\u0001${t}`);
    // Sites are compared by their keys, not when they were fetched.
    const columns = t === "sites" ? "url, name, kind, keys" : "*";
    for (const row of snap.prepare(`SELECT ${columns} FROM ${t} ORDER BY 1, 2`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
}

export interface SnapshotSummary { file: string; hash: string; changed: boolean; books: number; subjects: number; shelves: number; links: number }

/** The hash of the snapshot at `file`, or null when there isn't a readable one. */
function previousHash(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    const db = new Database(file, { readonly: true });
    try {
      return (db.prepare("SELECT value FROM meta WHERE key = 'hash'").pluck().get() as string | undefined) ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Builds the snapshot at `file`: written beside it under a temporary name and renamed into place, so a
 * server reading the old one never sees half of the new. An unchanged snapshot leaves the old file alone.
 */
export function buildSnapshot(c: Corpus, o: SnapshotOptions, file: string): SnapshotSummary {
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  const snap = new Database(temp);
  try {
    snap.pragma("journal_mode = DELETE");
    snap.exec(SNAPSHOT_SCHEMA);
    snap.transaction(() => fill(c, snap, o))();
    const hash = contentHash(snap);
    snap.prepare("INSERT INTO meta (key, value) VALUES ('hash', ?), ('built_at', ?)").run(hash, new Date().toISOString());
    const count = (t: string) => snap.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() as number;
    const summary = { file, hash, changed: hash !== previousHash(file), books: count("books"), subjects: count("subjects"), shelves: count("shelves"), links: count("links") };
    snap.close();
    if (summary.changed) fs.renameSync(temp, file);
    else fs.rmSync(temp, { force: true });
    return summary;
  } catch (error) {
    if (snap.open) snap.close();
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** The sites recorded in the snapshot at `file`, so a site that can't be reached keeps its last links. */
function previousSites(file: string): Map<string, LinkedSite> {
  const sites = new Map<string, LinkedSite>();
  if (!fs.existsSync(file)) return sites;
  try {
    const db = new Database(file, { readonly: true });
    try {
      for (const r of db.prepare("SELECT * FROM sites").all() as (Omit<LinkedSite, "keys"> & { keys: string })[]) {
        sites.set(r.url, { ...r, keys: JSON.parse(r.keys) });
      }
    } finally {
      db.close();
    }
  } catch {
    // An unreadable old snapshot just has no sites to keep.
  }
  return sites;
}

const keyMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(v && typeof v === "object" ? v : {}).filter(([k, p]) => k && typeof p === "string" && p.startsWith("/")));

/**
 * Fetches each linked site's `site.json` and key list. A site that can't be reached, or answers with
 * something that isn't version 1, keeps what the snapshot at `file` had for it, or is left out.
 */
export async function fetchSites(urls: string[], file: string, fetchImpl: typeof fetch = fetch): Promise<{ sites: LinkedSite[]; errors: string[] }> {
  const previous = previousSites(file);
  const sites: LinkedSite[] = [];
  const errors: string[] = [];
  for (const raw of urls) {
    const url = raw.replace(/\/+$/, "");
    try {
      const get = async (path: string) => {
        const res = await fetchImpl(new URL(path, `${url}/`), { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
      };
      const site = await get("site.json");
      if (site.version !== 1 || typeof site.name !== "string" || typeof site.citekeys !== "string") throw new Error("site.json isn't version 1");
      const keys = await get(site.citekeys.replace(/^\//, ""));
      sites.push({
        url, name: site.name, kind: typeof site.kind === "string" ? site.kind : "site", fetched_at: new Date().toISOString(),
        keys: { citekeys: keyMap(keys.citekeys), zotero_keys: keyMap(keys.zotero_keys) },
      });
    } catch (error) {
      errors.push(`${url}: ${(error as Error).message}`);
      const kept = previous.get(url);
      if (kept) sites.push(kept);
    }
  }
  return { sites, errors };
}

/** Fetches the linked sites, then builds the snapshot; what `corpus-mcp publish` and the server's timer run. */
export async function publishSnapshot(c: Corpus, config: Config, log: (line: string) => void = () => {}): Promise<SnapshotSummary> {
  const p = config.public;
  if (!p || p.level === "none") throw new Error("There's nothing to publish with CORPUS_PUBLIC=none; set it to catalogue.");
  const { sites, errors } = await fetchSites(p.links, p.file);
  for (const e of errors) log(`linked site not refreshed: ${e}`);
  return buildSnapshot(c, { title: p.title, url: p.url, excludeTags: config.excludeTags, zoteroLibrary: config.zotero?.library, sites }, p.file);
}
