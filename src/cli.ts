#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { scanLibraries } from "./indexer.js";

const USAGE = `Usage:
  corpus-mcp index [--force]   Scan the libraries and update the index
  corpus-mcp serve [--stdio]   Serve MCP over Streamable HTTP (default) or stdio

Environment: CORPUS_BOOKS_ROOT, CORPUS_LIBRARIES, CORPUS_DB, CORPUS_HOST, CORPUS_PORT`;

async function main(argv: string[]): Promise<void> {
  const [command, ...flags] = argv;
  const config = loadConfig();

  switch (command) {
    case "index": {
      const db = openDatabase(config.dbPath);
      const started = Date.now();
      const summary = scanLibraries(config, db, { force: flags.includes("--force"), log: (m) => console.error(m) });
      db.close();
      console.error(`scan finished in ${((Date.now() - started) / 1000).toFixed(1)}s`, summary);
      // A book that fails extraction is recorded and reported by corpus_status; only an
      // unreadable library catalogue fails the run.
      if (summary.unreadableLibraries.length > 0) process.exitCode = 2;
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
