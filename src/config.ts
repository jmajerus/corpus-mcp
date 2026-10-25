import path from "node:path";

export interface Config {
  /** Directory holding one folder per Calibre library. */
  booksRoot: string;
  /** Library folder names to index. Anything else under booksRoot is ignored. */
  libraries: string[];
  /** Books carrying any of these Calibre tags (case-insensitive) are never indexed. */
  excludeTags: string[];
  dbPath: string;
  /** Primary data (pinned citekeys, quotes): never rebuilt, backed up nightly. */
  dataDbPath: string;
  backupDir: string;
  /** Calibre-Web's shelf export (see deploy/corpus-source.sh), and the library its book ids belong to. */
  shelvesFile: string;
  shelvesLibrary: string;
  host: string;
  port: number;
}

/** The library Calibre-Web serves on calibre-web.localdomain (/mnt/Calibre/main). */
const DEFAULT_LIBRARIES = ["main"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const libraries = env.CORPUS_LIBRARIES
    ? env.CORPUS_LIBRARIES.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_LIBRARIES;
  const excludeTags = (env.CORPUS_EXCLUDE_TAGS ?? "private").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    booksRoot: path.resolve(env.CORPUS_BOOKS_ROOT ?? "/srv/corpus/books"),
    libraries,
    excludeTags,
    dbPath: path.resolve(env.CORPUS_DB ?? "/var/lib/corpus-mcp/corpus.db"),
    dataDbPath: path.resolve(env.CORPUS_DATA_DB ?? "/var/lib/corpus-mcp/data.db"),
    backupDir: path.resolve(env.CORPUS_BACKUP_DIR ?? "/var/lib/corpus-mcp/backups"),
    shelvesFile: path.resolve(env.CORPUS_SHELVES_FILE ?? "/var/lib/corpus-mcp/shelves.json"),
    shelvesLibrary: env.CORPUS_SHELVES_LIBRARY ?? libraries[0],
    host: env.CORPUS_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.CORPUS_PORT ?? "8000", 10),
  };
}
