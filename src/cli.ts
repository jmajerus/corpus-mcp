#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { backupDataStore, notYetLogged, openDataStore, recordChanges } from "./data.js";
import { openDatabase } from "./db.js";
import { scanLibraries } from "./indexer.js";
import { reanchorQuotes } from "./quotes.js";

const USAGE = `Usage:
  corpus-mcp index [--force]   Scan the libraries and update the index
  corpus-mcp serve [--stdio]   Serve MCP over Streamable HTTP (default) or stdio
  corpus-mcp backup            Copy data.db (pinned citekeys) to the backup directory
  corpus-mcp publish [--sql <file>] [--status]
                               Rebuild the public catalogue snapshot (CORPUS_PUBLIC=catalogue) and ship
                               what changed to its replica in D1, as the server's drain does every 15 s;
                               --sql writes a file that loads a local D1 from scratch; --status shows the queue

Environment: CORPUS_BOOKS_ROOT, CORPUS_LIBRARIES, CORPUS_EXCLUDE_TAGS, CORPUS_DB, CORPUS_DATA_DB,
CORPUS_BACKUP_DIR, CORPUS_HOST, CORPUS_PORT, CORPUS_PUBLIC, CORPUS_PUBLIC_DB, CORPUS_PUBLIC_PORT,
CORPUS_PUBLIC_TITLE, CORPUS_PUBLIC_URL, CORPUS_SITE_LINKS, CORPUS_PUBLISH_INTERVAL_MINUTES,
CORPUS_D1_PROXY_URL, CORPUS_D1_PROXY_TOKEN`;

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
      const drain = await import("./public/drain.js");
      const { d1ConfigFrom, d1Http } = await import("./public/d1-http.js");
      const file = config.public?.file ?? "";
      const state = () => drain.openReplicaState(drain.replicaStateFile(file));
      if (flags.includes("--status")) {
        console.log(JSON.stringify(drain.pending(state())));
        break;
      }
      const c = openCorpus(config);
      const s = await publishSnapshot(c, config, (line) => console.error(line));
      console.error(s.changed ? `public snapshot written to ${s.file}` : `public snapshot unchanged (${s.file})`,
        { books: s.books, subjects: s.subjects, shelves: s.shelves, links: s.links });
      c.db.close();
      c.data.close();
      const sqlAt = flags.indexOf("--sql");
      if (sqlAt >= 0) {
        const out = flags[sqlAt + 1];
        if (!out) throw new Error("--sql takes a file name.");
        const { replicaScript } = await import("./public/replica.js");
        const snap = new Database(file, { readonly: true });
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, replicaScript(snap));
        snap.close();
        console.error(`replica SQL written to ${out}`);
        break;
      }
      const d1 = d1ConfigFrom(process.env, "worker/wrangler.jsonc");
      if (!d1) {
        console.error("No D1 configured (CORPUS_D1_PROXY_URL and CORPUS_D1_PROXY_TOKEN); the snapshot is built for the LAN only.");
        break;
      }
      const shipped = await drain.tick(file, state(), d1Http(d1));
      console.error(`replica: ${shipped.queued} queued, ${shipped.shipped} shipped to D1`);
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
