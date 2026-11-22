import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * data.db: primary data that cannot be rebuilt from the books (pinned citekeys now, quotes next).
 * Unlike the index it is never deleted or regenerated, and `corpus-mcp backup` copies it nightly.
 */
export const DATA_SCHEMA_VERSION = 17;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS duplicate_decisions (
  pair_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, reviewed_at TEXT NOT NULL, reviewed_by TEXT
);

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

-- quote-mcp's quotes, anchored in a book's text (src/anchors.ts; docs/dev-briefs/holdings-and-quotes.md
-- §2): quote-mcp owns the quote, this keeps where it is, and the wording only to find it again.
CREATE TABLE IF NOT EXISTS anchors (
  quote_id INTEGER PRIMARY KEY,      -- quote-mcp's id
  calibre_uuid TEXT NOT NULL,
  book_id TEXT NOT NULL,             -- when last anchored; the Calibre UUID is the stable link
  sha256 TEXT,                       -- the book file the anchor refers to
  start_page INTEGER NOT NULL,       -- as in quotes
  start_offset INTEGER NOT NULL,
  end_page INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  page_label TEXT,
  end_page_label TEXT,
  section_path TEXT,
  prefix TEXT NOT NULL,
  suffix TEXT NOT NULL,
  text TEXT NOT NULL,
  reading TEXT,                      -- the printed reading, when text lost letters to ligatures (verify's restored)
  status TEXT NOT NULL CHECK (status IN ('verified', 'orphaned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS anchors_book ON anchors(calibre_uuid, start_page);

-- What quote-mcp follows: every change to an anchor, numbered. meta's anchor_log names this numbering.
CREATE TABLE IF NOT EXISTS anchor_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stored', 'replaced', 'reanchored', 'orphaned', 'found', 'deleted')),
  status TEXT,                       -- null once deleted
  anchor TEXT,                       -- JSON, as GET /api/anchors/changes sends it; null once deleted
  at TEXT NOT NULL
);

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
  replaces TEXT NOT NULL DEFAULT '[]', -- JSON: keys of items merged into this one (Zotero's dc:replaces)
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS zotero_items_uuid ON zotero_items(calibre_uuid);
CREATE INDEX IF NOT EXISTS zotero_items_title ON zotero_items(title_norm);
CREATE TABLE IF NOT EXISTS zotero_isbns (
  isbn TEXT NOT NULL,                -- ISBN-13
  key TEXT NOT NULL,
  PRIMARY KEY (isbn, key)
);
-- Duplicate-review content profiles by file identity ("<path>|<size>|<mtime>"), so a restart doesn't read every file again.
CREATE TABLE IF NOT EXISTS file_profiles (
  stamp TEXT PRIMARY KEY,
  profile TEXT NOT NULL,              -- JSON: a ContentProfile, or { error }
  profiled_at TEXT NOT NULL
);
-- One row per ebook file seen under CORPUS_INTAKE_ROOT (src/intake.ts). Survives a reindex.
CREATE TABLE IF NOT EXISTS intake_files (
  path TEXT PRIMARY KEY,             -- relative to the intake root, "/" separators
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('present', 'candidate', 'staged', 'applied', 'skipped', 'problem', 'too_large', 'absent')),
  title TEXT,
  authors TEXT,                      -- JSON array
  problem TEXT,
  staged_id TEXT,                    -- upload staging id, once copied for review
  book_id TEXT,                      -- index id once the bytes are in the library, or after Apply
  seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_files_status ON intake_files(status, path);
-- SHA-256 of each Calibre format file, keyed by path|size|mtime, so a later intake scan does not read it again.
CREATE TABLE IF NOT EXISTS intake_format_hashes (
  stamp TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL
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
-- A Calibre UUID that no longer names a live record, and the record that stands for it now: a duplicate
-- trashed into its keeper, or a record replaced by a re-import. Lookups by UUID resolve through this, so
-- references kept elsewhere (quote-mcp's checked quotes) keep working. Never chained: uuid is always live
-- as far as this table knows (recordAlias re-points older aliases).
CREATE TABLE IF NOT EXISTS book_aliases (
  old_uuid TEXT PRIMARY KEY COLLATE NOCASE,
  uuid TEXT NOT NULL COLLATE NOCASE,
  old_book_id TEXT,
  reason TEXT NOT NULL,              -- duplicate_merged
  job_id INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS book_aliases_uuid ON book_aliases(uuid);
-- The value corpus-mcp last wrote to, or agreed with, a place a book's record is edited (surface: calibre),
-- one row per field. A later refresh that finds another value there knows it was edited in that place
-- (PLAN.md, Calibre downstream: sync). value is JSON.
CREATE TABLE IF NOT EXISTS sync_baselines (
  calibre_uuid TEXT NOT NULL COLLATE NOCASE,
  surface TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  job_id INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (calibre_uuid, surface, field)
);
-- What tools/calibre-health.py found in the Calibre library (src/health.ts), newest last; the last 30 are kept.
CREATE TABLE IF NOT EXISTS health_reports (
  id INTEGER PRIMARY KEY,
  job_id INTEGER,
  at TEXT NOT NULL,
  report TEXT NOT NULL               -- JSON, as the script printed it
);
-- A book's printed page numbering, pinned by a person or agent (pin_page_labels) for a PDF whose page-label
-- metadata is missing or wrong. The refresh writes it into the index (src/printed-pages.ts); sha256 is the
-- file it was pinned against, and a pin with no ranges is a clear, which the refresh undoes and then drops.
CREATE TABLE IF NOT EXISTS page_label_pins (
  calibre_uuid TEXT PRIMARY KEY COLLATE NOCASE,
  book_id TEXT NOT NULL,
  title TEXT NOT NULL,
  ranges TEXT NOT NULL,              -- JSON [{ file_page, page_label }], each running to the next
  sha256 TEXT,
  pinned_at TEXT NOT NULL,
  pinned_by TEXT
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
  const anchorColumns = new Set((db.prepare("PRAGMA table_info(anchors)").all() as { name: string }[]).map((c) => c.name));
  if (!anchorColumns.has("reading")) db.exec("ALTER TABLE anchors ADD COLUMN reading TEXT");
  const zoteroColumns = new Set((db.prepare("PRAGMA table_info(zotero_items)").all() as { name: string }[]).map((c) => c.name));
  if (!zoteroColumns.has("replaces")) {
    // Mirrors from before merges were followed: add the column and fetch everything again to fill it.
    db.exec("ALTER TABLE zotero_items ADD COLUMN replaces TEXT NOT NULL DEFAULT '[]'");
    db.exec("DELETE FROM meta WHERE key = 'zotero_version'");
  }
  // Schemas 5 to 7 categorized quotes; since 8 a quote's subject is its book's, and tags do the rest.
  for (const column of ["category_mode", "categories"]) if (quoteColumns.has(column)) db.exec(`ALTER TABLE quotes DROP COLUMN ${column}`);
  // Intake gained an "absent" status after the table first shipped. SQLite cannot widen a CHECK, so rebuild.
  const intakeSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intake_files'").pluck().get() as string | undefined;
  if (intakeSql && !intakeSql.includes("'absent'")) {
    db.exec(`
      CREATE TABLE intake_files_new (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        sha256 TEXT,
        status TEXT NOT NULL CHECK (status IN ('present', 'candidate', 'staged', 'applied', 'skipped', 'problem', 'too_large', 'absent')),
        title TEXT,
        authors TEXT,
        problem TEXT,
        staged_id TEXT,
        book_id TEXT,
        seen_at TEXT NOT NULL
      );
      INSERT INTO intake_files_new SELECT path, size, mtime_ms, sha256, status, title, authors, problem, staged_id, book_id, seen_at FROM intake_files;
      DROP TABLE intake_files;
      ALTER TABLE intake_files_new RENAME TO intake_files;
      CREATE INDEX IF NOT EXISTS intake_files_status ON intake_files(status, path);
    `);
  }
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

/** The live UUID an old one stands for; the UUID itself when it has no alias. */
export function resolveUuid(data: DataStore, uuid: string): string {
  return (data.prepare("SELECT uuid FROM book_aliases WHERE old_uuid = ?").pluck().get(uuid) as string | undefined) ?? uuid;
}

/** The old UUIDs that now mean this record, oldest first. */
export function aliasesOf(data: DataStore, uuid: string): string[] {
  return data.prepare("SELECT old_uuid FROM book_aliases WHERE uuid = ? ORDER BY at, old_uuid").pluck().all(uuid) as string[];
}

/** `oldUuid` now means `uuid`. Aliases that pointed at oldUuid follow it, so a lookup is one step. */
export function recordAlias(data: DataStore, alias: { old_uuid: string; uuid: string; old_book_id?: string | null; reason: string; job_id?: number | null }): void {
  if (alias.old_uuid.toLowerCase() === alias.uuid.toLowerCase()) return;
  const at = new Date().toISOString();
  data.transaction(() => {
    data.prepare("UPDATE book_aliases SET uuid = ? WHERE uuid = ?").run(alias.uuid, alias.old_uuid);
    // The keeper is live: an alias left from an earlier life of that UUID would send lookups away from it.
    data.prepare("DELETE FROM book_aliases WHERE old_uuid = ?").run(alias.uuid);
    data.prepare(`INSERT INTO book_aliases (old_uuid, uuid, old_book_id, reason, job_id, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (old_uuid) DO UPDATE SET uuid = excluded.uuid, old_book_id = excluded.old_book_id, reason = excluded.reason, job_id = excluded.job_id, at = excluded.at`)
      .run(alias.old_uuid, alias.uuid, alias.old_book_id ?? null, alias.reason, alias.job_id ?? null, at);
  })();
}

export interface SyncBaseline { calibre_uuid: string; surface: "calibre"; field: string; value: unknown; job_id?: number | null }

/** What was just written to a surface, as the value a later comparison starts from. */
export function recordBaselines(data: DataStore, baselines: SyncBaseline[]): void {
  if (!baselines.length) return;
  const at = new Date().toISOString();
  const put = data.prepare(`INSERT INTO sync_baselines (calibre_uuid, surface, field, value, job_id, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (calibre_uuid, surface, field) DO UPDATE SET value = excluded.value, job_id = excluded.job_id, at = excluded.at`);
  data.transaction(() => {
    for (const b of baselines) put.run(b.calibre_uuid, b.surface, b.field, JSON.stringify(b.value), b.job_id ?? null, at);
  })();
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
  "tag_proposed", "proposal_approved", "proposal_rejected", "proposal_reopened", "proposal_moved", "filing_moved", "quotes_moved", "citekey_pinned",
  "duplicate_resolution_failed", "duplicate_reviewed", "duplicate_resolved", "metadata_corrected", "categories_edited", "citekey_unpinned",
  "quote_saved", "quote_edited", "quote_deleted", "quote_reanchored", "quote_orphaned",
  "zotero_linked", "cover_set", "page_labels_pinned", "page_labels_applied",
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
  const bookAdded = data.prepare("SELECT 1 FROM changes WHERE source = 'admin-job' AND kind = 'book_added' AND book_id = ? AND at >= ? LIMIT 1");
  return changes.filter((c) => {
    if (!c.book_id) return true;
    if (c.kind === "tag_added" || c.kind === "tag_removed") return !sameChange.get(c.book_id, c.kind, c.detail ?? null, since);
    if (c.kind === "book_reextracted" && c.detail?.includes("→")) return !formatAdded.get(c.book_id, since);
    if (c.kind === "book_added") return !bookAdded.get(c.book_id, since);
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
