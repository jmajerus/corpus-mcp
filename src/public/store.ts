import fs from "node:fs";
import Database from "better-sqlite3";

/**
 * What the public pages need from a snapshot: queries with bound parameters. Async, so the same pages run
 * over better-sqlite3 on the LAN and over D1 in a Worker, which only has an async API.
 */
export interface PublicStore {
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T>(sql: string, ...params: unknown[]): Promise<T | null>;
}

export function sqliteStore(db: Database.Database): PublicStore {
  return {
    async all<T>(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
  };
}

/**
 * The snapshot at `file`, opened read-only and reopened when it is replaced (the builder renames a new one
 * into place); null while there isn't one.
 */
export function snapshotReader(file: string): () => PublicStore | null {
  let open: { db: Database.Database; store: PublicStore; ino: number; mtime: number } | null = null;
  return () => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      open?.db.close();
      open = null;
      return null;
    }
    if (!open || open.ino !== stat.ino || open.mtime !== stat.mtimeMs) {
      open?.db.close();
      const db = new Database(file, { readonly: true, fileMustExist: true });
      open = { db, store: sqliteStore(db), ino: stat.ino, mtime: stat.mtimeMs };
    }
    return open.store;
  };
}
