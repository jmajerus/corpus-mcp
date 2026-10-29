import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,               -- "<library>:<calibre id>"
  library TEXT NOT NULL,
  calibre_id INTEGER NOT NULL,
  uuid TEXT,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,             -- JSON array
  author_sorts TEXT NOT NULL DEFAULT '[]', -- JSON array, Calibre's sort form per author
  publisher TEXT,
  year INTEGER,
  language TEXT,
  isbn TEXT,
  calibre_citekey TEXT,              -- Calibre identifier "citekey", set by hand
  proposed_citekey TEXT,             -- the citekey rule applied to the metadata
  citekey_blockers TEXT NOT NULL DEFAULT '[]', -- JSON array of CitekeyBlocker
  printed_isbns TEXT,                -- JSON array of IsbnCandidate found in the text; null until scanned
  printed_isbns_version INTEGER,     -- ISBN_SCAN_VERSION that produced printed_isbns
  text_chars INTEGER,                -- total extracted characters; null until counted
  printed_years TEXT,                -- JSON array of YearCandidate found in the text; null until scanned
  printed_years_version INTEGER,     -- YEAR_SCAN_VERSION that produced printed_years
  printed_year INTEGER,              -- the year to cite from printed_years (src/years.ts printedYear), or null
  title_page TEXT,                   -- JSON TitlePageScan: author and title candidates (src/titlepage.ts); null until scanned
  title_page_version INTEGER,        -- TITLE_PAGE_SCAN_VERSION that produced title_page
  tags TEXT NOT NULL,                -- JSON array
  description TEXT,
  folder TEXT NOT NULL,              -- relative to the books root
  format TEXT,                       -- null when the folder has no supported ebook file
  file_path TEXT,                    -- relative to the books root
  file_size INTEGER,
  file_mtime INTEGER,
  sha256 TEXT,
  extractor_version INTEGER,
  reflowable INTEGER,
  page_count INTEGER,
  status TEXT NOT NULL,              -- indexed | no_file | failed
  error TEXT,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outline (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  start_page INTEGER,
  PRIMARY KEY (book_id, ord)
);

CREATE TABLE IF NOT EXISTS pages (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  label TEXT,
  section_path TEXT,
  text TEXT NOT NULL,
  PRIMARY KEY (book_id, page_index)
);

CREATE TABLE IF NOT EXISTS passages (
  id INTEGER PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS passages_book ON passages(book_id, page_index);

-- Calibre-Web's public shelves, replaced from its export on every scan. book_shelves.book_id joins
-- books.id; it can name a book not (yet) in the index, so it has no foreign key.
CREATE TABLE IF NOT EXISTS shelves (
  id INTEGER PRIMARY KEY,            -- Calibre-Web shelf id
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_shelves (
  book_id TEXT NOT NULL,             -- "<library>:<calibre id>"
  shelf_id INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  ord INTEGER,                       -- the shelf's manual order
  PRIMARY KEY (book_id, shelf_id)
);
CREATE INDEX IF NOT EXISTS book_shelves_shelf ON book_shelves(shelf_id, ord);

-- One row per scan, for the admin dashboard's refresh history (the newest 500 are kept).
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  seconds REAL NOT NULL,
  summary TEXT NOT NULL              -- JSON ScanSummary
);

CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
  text, content='passages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS passages_ai AFTER INSERT ON passages BEGIN
  INSERT INTO passages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS passages_ad AFTER DELETE ON passages BEGIN
  INSERT INTO passages_fts(passages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

export type DB = Database.Database;

export function openDatabase(dbPath: string, { readonly = false } = {}): DB {
  if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly, fileMustExist: readonly });
  db.pragma("foreign_keys = ON");
  if (readonly) {
    // Schema changes are additive, so an index newer than this code still reads correctly.
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();
    if (!(Number(version) >= SCHEMA_VERSION)) {
      throw new Error(`Index schema is ${version ?? "missing"}, expected ${SCHEMA_VERSION}. Run "corpus-mcp index".`);
    }
    return db;
  }
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

/** Columns added after schema 1, for an index created by older code. Metadata fills in on the next scan. */
const ADDED_BOOK_COLUMNS: Record<string, string> = {
  author_sorts: "TEXT NOT NULL DEFAULT '[]'",
  calibre_citekey: "TEXT",
  proposed_citekey: "TEXT",
  citekey_blockers: "TEXT NOT NULL DEFAULT '[]'",
  printed_isbns: "TEXT",
  printed_isbns_version: "INTEGER",
  text_chars: "INTEGER",
  printed_years: "TEXT",
  printed_years_version: "INTEGER",
  printed_year: "INTEGER",
  title_page: "TEXT",
  title_page_version: "INTEGER",
};

function migrate(db: DB): void {
  const existing = new Set((db.prepare("PRAGMA table_info(books)").all() as { name: string }[]).map((c) => c.name));
  for (const [column, type] of Object.entries(ADDED_BOOK_COLUMNS)) {
    if (!existing.has(column)) db.exec(`ALTER TABLE books ADD COLUMN ${column} ${type}`);
  }
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

export function getMeta(db: DB, key: string): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined) ?? null;
}
