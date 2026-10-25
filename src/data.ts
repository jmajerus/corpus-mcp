import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * data.db: primary data that cannot be rebuilt from the books (pinned citekeys now, quotes next).
 * Unlike the index it is never deleted or regenerated, and `corpus-mcp backup` copies it nightly.
 */
export const DATA_SCHEMA_VERSION = 9;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- A citekey assigned elsewhere (the reference manager the book was filed in). Keyed by Calibre UUID,
-- which survives renumbering and re-indexing; book_id and title record what it was pinned to.
CREATE TABLE IF NOT EXISTS citekeys (
  calibre_uuid TEXT PRIMARY KEY,
  citekey TEXT NOT NULL UNIQUE,
  book_id TEXT NOT NULL,
  title TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  pinned_by TEXT
);

-- Agent-proposed vocabulary tags for a book, reviewed on the /review page. Approved tags are applied
-- to Calibre by tools/calibre-tags.sh; corpus-mcp itself never writes to Calibre.
CREATE TABLE IF NOT EXISTS tag_proposals (
  calibre_uuid TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL,                -- JSON array: the tags as proposed
  rationale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_tags TEXT,                -- JSON array: the tags as approved, possibly edited
  proposed_by TEXT,
  proposed_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS tag_proposals_status ON tag_proposals(status, proposed_at);

-- Admin jobs launched from /admin (see src/jobs.ts), with their output.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('preview', 'apply')),
  params TEXT NOT NULL,              -- JSON; a preview stores the plan its apply will run
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
  requested_by TEXT,
  preview_of INTEGER REFERENCES jobs(id),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  log TEXT NOT NULL,
  items TEXT                         -- JSON: per-book changes the job made, or for a preview, would make
);

-- The change log behind /admin/changes: one row per atomic change to the corpus.
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                -- see ChangeKind in this file
  source TEXT NOT NULL,              -- admin-job | calibre (seen by a refresh) | review | agent
  job_id INTEGER,
  book_id TEXT,
  calibre_uuid TEXT,
  title TEXT,
  detail TEXT,                       -- the tag, format change, citekey, or note
  actor TEXT
);
CREATE INDEX IF NOT EXISTS changes_at ON changes(at);
CREATE INDEX IF NOT EXISTS changes_book ON changes(book_id, at);
CREATE INDEX IF NOT EXISTS changes_kind ON changes(kind, at);

-- Quotable excerpts, verified against the book's text when saved (src/quotes.ts). The anchor (pages,
-- offsets into the stored page text, and the text around it) lets a re-index find the quote again.
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  calibre_uuid TEXT NOT NULL,
  book_id TEXT NOT NULL,             -- at save time; the Calibre UUID is the stable link
  title TEXT NOT NULL,
  text TEXT NOT NULL,                -- the book's exact wording
  note TEXT,
  labels TEXT NOT NULL DEFAULT '[]', -- JSON: free-form tags (themes, forms, links), shown as "Tags"
  start_page INTEGER NOT NULL,       -- 0-based page or location index
  start_offset INTEGER NOT NULL,     -- character offset in that page's stored text
  end_page INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,       -- exclusive
  page_label TEXT,
  end_page_label TEXT,
  section_path TEXT,
  prefix TEXT NOT NULL,              -- about 40 characters before, for re-anchoring
  suffix TEXT NOT NULL,              -- about 40 characters after
  sha256 TEXT,                       -- the book file the anchor refers to
  status TEXT NOT NULL CHECK (status IN ('verified', 'orphaned')),
  source TEXT NOT NULL,              -- agent | admin
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS quotes_book ON quotes(calibre_uuid, start_page);

-- A read-only mirror of the Zotero library's top-level items (src/zotero.ts): the fields that tie a
-- Calibre book to its Zotero item, refreshed by version so nothing waits on zotero.org.
CREATE TABLE IF NOT EXISTS zotero_items (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  title TEXT,
  title_norm TEXT,                   -- normalizedTitle(), for candidate matches
  first_creator TEXT,                -- the first author's (or editor's) family name, folded
  year INTEGER,
  citekey TEXT,                      -- Better BibTeX's, from the citationKey field or Extra
  calibre_uuid TEXT,                 -- the "Calibre UUID:" line filing wrote to Extra
  trashed INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS zotero_items_uuid ON zotero_items(calibre_uuid);
CREATE INDEX IF NOT EXISTS zotero_items_title ON zotero_items(title_norm);
CREATE TABLE IF NOT EXISTS zotero_isbns (
  isbn TEXT NOT NULL,                -- ISBN-13
  key TEXT NOT NULL,
  PRIMARY KEY (isbn, key)
);
-- A person's verdict on a title-only match: this Zotero item is (or is not) this Calibre book.
CREATE TABLE IF NOT EXISTS zotero_links (
  calibre_uuid TEXT NOT NULL,
  zotero_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'rejected')),
  linked_by TEXT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (calibre_uuid, zotero_key)
);
CREATE VIRTUAL TABLE IF NOT EXISTS quotes_fts USING fts5(
  text, note, labels, content='quotes', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS quotes_ai AFTER INSERT ON quotes BEGIN
  INSERT INTO quotes_fts(rowid, text, note, labels) VALUES (new.id, new.text, new.note, new.labels);
END;
CREATE TRIGGER IF NOT EXISTS quotes_ad AFTER DELETE ON quotes BEGIN
  INSERT INTO quotes_fts(quotes_fts, rowid, text, note, labels) VALUES ('delete', old.id, old.text, old.note, old.labels);
END;
CREATE TRIGGER IF NOT EXISTS quotes_au AFTER UPDATE ON quotes BEGIN
  INSERT INTO quotes_fts(quotes_fts, rowid, text, note, labels) VALUES ('delete', old.id, old.text, old.note, old.labels);
  INSERT INTO quotes_fts(rowid, text, note, labels) VALUES (new.id, new.text, new.note, new.labels);
END;`;

export type DataStore = Database.Database;

export interface PinnedCitekey {
  calibre_uuid: string;
  citekey: string;
  book_id: string;
  title: string;
  pinned_at: string;
  pinned_by: string | null;
}

export function openDataStore(dbPath: string): DataStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  // Columns added after a table first shipped.
  const jobColumns = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
  if (!jobColumns.has("items")) db.exec("ALTER TABLE jobs ADD COLUMN items TEXT");
  const quoteColumns = new Set((db.prepare("PRAGMA table_info(quotes)").all() as { name: string }[]).map((c) => c.name));
  // Schemas 5 to 7 categorized quotes; since 8 a quote's subject is its book's, and tags do the rest.
  for (const column of ["category_mode", "categories"]) if (quoteColumns.has(column)) db.exec(`ALTER TABLE quotes DROP COLUMN ${column}`);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(DATA_SCHEMA_VERSION));
  return db;
}

export function pinnedByUuid(data: DataStore, uuid: string | null): PinnedCitekey | undefined {
  if (!uuid) return undefined;
  return data.prepare<[string], PinnedCitekey>("SELECT * FROM citekeys WHERE calibre_uuid = ?").get(uuid);
}

export function pinnedByKey(data: DataStore, citekey: string): PinnedCitekey | undefined {
  return data.prepare<[string], PinnedCitekey>("SELECT * FROM citekeys WHERE citekey = ? COLLATE NOCASE").get(citekey.toLowerCase());
}

export function allPinned(data: DataStore): Map<string, PinnedCitekey> {
  const rows = data.prepare("SELECT * FROM citekeys").all() as PinnedCitekey[];
  return new Map(rows.map((r) => [r.calibre_uuid, r]));
}

/** An online backup to <dir>/data-<UTC date>.db, keeping the newest `keep` copies. */
export async function backupDataStore(data: DataStore, dir: string, keep = 14): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `data-${new Date().toISOString().slice(0, 10)}.db`);
  await data.backup(target);
  const old = fs.readdirSync(dir).filter((f) => /^data-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return target;
}

export const CHANGE_KINDS = [
  "tag_added", "tag_removed", "format_added", "book_added", "book_reextracted", "book_removed", "extraction_failed",
  "tag_proposed", "proposal_approved", "proposal_rejected", "proposal_reopened", "citekey_pinned",
  "categories_edited", "citekey_unpinned",
  "quote_saved", "quote_edited", "quote_deleted", "quote_reanchored", "quote_orphaned",
  "zotero_linked",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type ChangeSource = "admin-job" | "admin" | "cli" | "calibre" | "review" | "agent" | "zotero";

export interface Change {
  kind: ChangeKind; source: ChangeSource; job_id?: number | null; book_id?: string | null; calibre_uuid?: string | null;
  title?: string | null; detail?: string | null; actor?: string | null; at?: string;
}

export function recordChanges(data: DataStore, changes: Change[]): void {
  if (!changes.length) return;
  const insert = data.prepare(`
    INSERT INTO changes (at, kind, source, job_id, book_id, calibre_uuid, title, detail, actor)
    VALUES (@at, @kind, @source, @job_id, @book_id, @calibre_uuid, @title, @detail, @actor)`);
  const now = new Date().toISOString();
  data.transaction(() => {
    for (const c of changes) {
      insert.run({ at: c.at ?? now, kind: c.kind, source: c.source, job_id: c.job_id ?? null, book_id: c.book_id ?? null,
        calibre_uuid: c.calibre_uuid ?? null, title: c.title ?? null, detail: c.detail ?? null, actor: c.actor ?? null });
    }
  })();
}

/**
 * The changes a refresh saw in Calibre that an admin job did not already log in the last day: an
 * apply logs its changes, then refreshes, and that refresh sees the same tag changes, or re-extracts
 * a book whose EPUB the job added.
 */
export function notYetLogged(data: DataStore, changes: Change[]): Change[] {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sameChange = data.prepare(`
    SELECT 1 FROM changes WHERE source = 'admin-job' AND book_id = ? AND kind = ? AND COALESCE(detail, '') = COALESCE(?, '') AND at >= ? LIMIT 1`);
  const formatAdded = data.prepare("SELECT 1 FROM changes WHERE source = 'admin-job' AND kind = 'format_added' AND book_id = ? AND at >= ? LIMIT 1");
  return changes.filter((c) => {
    if (!c.book_id) return true;
    if (c.kind === "tag_added" || c.kind === "tag_removed") return !sameChange.get(c.book_id, c.kind, c.detail ?? null, since);
    if (c.kind === "book_reextracted" && c.detail?.includes("→")) return !formatAdded.get(c.book_id, since);
    return true;
  });
}

export interface ChangeQuery {
  since?: string; until?: string; kinds?: string[]; sources?: string[]; q?: string; tag?: string; job?: number; actor?: string;
  /** One book, by exact id. */
  book?: string;
  limit?: number; offset?: number;
}

/** Filtered changes, newest first, with the total, per-kind counts, and per-day counts for the same filters. */
export function queryChanges(data: DataStore, query: ChangeQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.since) { where.push("at >= @since"); params.since = query.since; }
  if (query.until) { where.push("at < @until"); params.until = query.until; }
  if (query.sources?.length) { where.push("source IN (SELECT value FROM json_each(@sources))"); params.sources = JSON.stringify(query.sources); }
  if (query.q) { where.push("(lower(title) LIKE @q OR lower(book_id) LIKE @q)"); params.q = `%${query.q.toLowerCase()}%`; }
  if (query.tag) { where.push("kind IN ('tag_added', 'tag_removed', 'tag_proposed', 'proposal_approved') AND lower(detail) LIKE @tag"); params.tag = `%${query.tag.toLowerCase()}%`; }
  if (query.job) { where.push("job_id = @job"); params.job = query.job; }
  if (query.book) { where.push("book_id = @book"); params.book = query.book; }
  if (query.actor) { where.push("lower(actor) LIKE @actor"); params.actor = `%${query.actor.toLowerCase()}%`; }
  // Kind counts ignore the kind filter, so every kind stays visible as a filter chip.
  const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const byKind = Object.fromEntries((data.prepare(`SELECT kind, COUNT(*) AS n FROM changes ${base} GROUP BY kind`).all(params) as { kind: string; n: number }[])
    .map((r) => [r.kind, r.n]));
  if (query.kinds?.length) { where.push("kind IN (SELECT value FROM json_each(@kinds))"); params.kinds = JSON.stringify(query.kinds); }
  const filtered = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = data.prepare(`SELECT COUNT(*) FROM changes ${filtered}`).pluck().get(params) as number;
  const byDay = data.prepare(`SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM changes ${filtered} GROUP BY day ORDER BY day`).all(params);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const rows = data.prepare(`SELECT * FROM changes ${filtered} ORDER BY at DESC, id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset: Math.max(query.offset ?? 0, 0) });
  const actors = data.prepare("SELECT DISTINCT actor FROM changes WHERE actor IS NOT NULL ORDER BY actor").pluck().all();
  return { total, by_kind: byKind, by_day: byDay, actors, rows };
}
