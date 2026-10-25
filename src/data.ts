import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * data.db: primary data that cannot be rebuilt from the books (pinned citekeys now, quotes next).
 * Unlike the index it is never deleted or regenerated, and `corpus-mcp backup` copies it nightly.
 */
export const DATA_SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- The citekey Concept Clusters assigned when it filed the book in Zotero. Keyed by Calibre UUID,
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
  log TEXT NOT NULL
);`;

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
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(DATA_SCHEMA_VERSION));
  return db;
}

export function pinnedByUuid(data: DataStore, uuid: string | null): PinnedCitekey | undefined {
  if (!uuid) return undefined;
  return data.prepare<[string], PinnedCitekey>("SELECT * FROM citekeys WHERE calibre_uuid = ?").get(uuid);
}

export function pinnedByKey(data: DataStore, citekey: string): PinnedCitekey | undefined {
  return data.prepare<[string], PinnedCitekey>("SELECT * FROM citekeys WHERE citekey = ?").get(citekey.toLowerCase());
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
