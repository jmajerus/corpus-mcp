#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { backupDataStore, notYetLogged, openDataStore, recordChanges } from "./data.js";
import { openDatabase } from "./db.js";
import { scanLibraries } from "./indexer.js";
import { reanchorQuotes } from "./quotes.js";

const USAGE = `Usage:
  corpus-mcp index [--force]   Scan the libraries and update the index
  corpus-mcp serve [--stdio]   Serve MCP over Streamable HTTP (default) or stdio
  corpus-mcp backup            Copy data.db (pinned citekeys) to the backup directory
  corpus-mcp publish           Rebuild the public catalogue snapshot (CORPUS_PUBLIC=catalogue)

Environment: CORPUS_BOOKS_ROOT, CORPUS_LIBRARIES, CORPUS_EXCLUDE_TAGS, CORPUS_DB, CORPUS_DATA_DB,
CORPUS_BACKUP_DIR, CORPUS_HOST, CORPUS_PORT, CORPUS_PUBLIC, CORPUS_PUBLIC_DB, CORPUS_PUBLIC_PORT,
CORPUS_PUBLIC_TITLE, CORPUS_PUBLIC_URL, CORPUS_SITE_LINKS, CORPUS_PUBLISH_INTERVAL_MINUTES`;

async function main(argv: string[]): Promise<void> {
  const [command, ...flags] = argv;
  const config = loadConfig();

  switch (command) {
    case "index": {
      const db = openDatabase(config.dbPath);
      const data = openDataStore(config.dataDbPath);
      const started = Date.now();
      // Changes the scan sees in Calibre go to the change log, unless an admin job already logged them.
      const record = (changes: Parameters<typeof notYetLogged>[1]) => recordChanges(data, notYetLogged(data, changes));
      const summary = scanLibraries(config, db, { force: flags.includes("--force"), log: (m) => console.error(m), record });
      // Quotes whose book file changed are found again by their text, or marked orphaned.
      const quotes = reanchorQuotes(db, data);
      if (quotes.reanchored || quotes.orphaned) console.error(`quotes: ${quotes.reanchored} re-anchored, ${quotes.orphaned} orphaned`);
      db.close();
      data.close();
      console.error(`scan finished in ${((Date.now() - started) / 1000).toFixed(1)}s`, summary);
      // A book that fails extraction is recorded and reported by corpus_status; only an
      // unreadable library catalogue fails the run.
      if (summary.unreadableLibraries.length > 0) process.exitCode = 2;
      break;
    }
    case "backup": {
      const data = openDataStore(config.dataDbPath);
      console.error(`backed up to ${await backupDataStore(data, config.backupDir)}`);
      data.close();
      break;
    }
    case "publish": {
      const { openCorpus } = await import("./server.js");
      const { publishSnapshot } = await import("./public/snapshot.js");
      const c = openCorpus(config);
      const s = await publishSnapshot(c, config, (line) => console.error(line));
      console.error(s.changed ? `public snapshot written to ${s.file}` : `public snapshot unchanged (${s.file})`,
        { books: s.books, subjects: s.subjects, shelves: s.shelves, links: s.links });
      c.db.close();
      c.data.close();
      break;
    }
    case "serve": {
      const { serveHttp, serveStdio } = await import("./server.js");
      await (flags.includes("--stdio") ? serveStdio(config) : serveHttp(config));
      break;
    }
    default:
      console.error(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exit(1);
});
