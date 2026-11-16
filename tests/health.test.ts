import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { openDataStore } from "../src/data.js";
import { healthView, latestHealthReport, parseHealthOutput } from "../src/health.js";
import { scanLibraries } from "../src/indexer.js";
import { JobRunner } from "../src/jobs.js";
import type { Corpus } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { HEALTH_HTML } from "../src/web/health.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

// tools/calibre-health.py (run on the Calibre-Web host by corpus-source.sh's "health" command), the job
// that keeps its reports, and the page's view of them.

const script = new URL("../tools/calibre-health.py", import.meta.url).pathname;
let root: string, lib: string, appDb: string, c: Corpus, config: Config;
const pdf = makePdf({ pages: [["A synthetic book for the health check"]] });
const other = makePdf({ pages: [["Different words in a lost book"]] });

beforeEach(() => {
  root = tempDir();
  makeLibrary(root, "main", [
    { id: 1, title: "Kept", authors: ["Ann Author"], files: { pdf } },
    { id: 2, title: "Broken", authors: ["Ann Author"], files: { pdf } },
    { id: 3, title: "Covered", authors: ["Bo Writer"], files: { pdf: other } },
  ]);
  lib = path.join(root, "main");
  const db = new Database(path.join(lib, "metadata.db"));
  // Calibre's own column: 2 says it has a cover (gone with its folder); 3 has a cover.jpg it doesn't record.
  db.exec("ALTER TABLE books ADD COLUMN has_cover INTEGER DEFAULT 0; UPDATE books SET has_cover = 1 WHERE id = 2");
  db.close();
  fs.writeFileSync(path.join(lib, "Bo Writer", "Covered (3)", "cover.jpg"), "jpg");
  config = loadConfig({ CORPUS_BOOKS_ROOT: root, CORPUS_LIBRARIES: "main", CORPUS_DB: path.join(root, "corpus.db"), CORPUS_DATA_DB: path.join(root, "data.db") });
  c = { db: openDatabase(config.dbPath), data: openDataStore(config.dataDbPath), booksRoot: root,
    vocabulary: new Vocabulary(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "vocabulary.json"), "utf8"))) };
  scanLibraries(config, c.db);
  // After the index: record 2's folder is gone from disk (as after an interrupted rename).
  fs.rmSync(path.join(lib, "Ann Author", "Broken (2)"), { recursive: true });
  // A leftover copy of book 1, a lost book nothing else has, a folder with only a cover, and strays.
  const leftover = path.join(lib, "Ann Author", "Kept (41)");
  fs.mkdirSync(leftover);
  fs.writeFileSync(path.join(leftover, "Kept - Ann Author.pdf"), pdf);
  const lost = path.join(lib, "Unknown", "Lost Book (612)");
  fs.mkdirSync(lost, { recursive: true });
  fs.writeFileSync(path.join(lost, "Lost Book.epub"), "a book only this folder has");
  fs.mkdirSync(path.join(lib, "Unknown", "Cover Only (7)"));
  fs.writeFileSync(path.join(lib, "Unknown", "Cover Only (7)", "cover.jpg"), "jpg");
  fs.writeFileSync(path.join(lib, "Unknown", "Book-layout1.indd - Unknown.pdf"), "stray");
  fs.writeFileSync(path.join(lib, "metadata.db.bak_2026-11-11"), "manual backup");
  fs.writeFileSync(path.join(lib, "metadata.db.before-upload-20261115"), "corpus backup");
  fs.mkdirSync(path.join(lib, "metadata.db.before-duplicates-1.files"));
  fs.writeFileSync(path.join(lib, "metadata.db.before-duplicates-1.files", "app.db"), "x");
  fs.mkdirSync(path.join(lib, ".caltrash"));
  appDb = path.join(root, "app.db");
  const app = new Database(appDb);
  app.exec(`CREATE TABLE book_shelf_link (id INTEGER PRIMARY KEY, book_id INTEGER, shelf INTEGER);
    CREATE TABLE book_read_link (id INTEGER PRIMARY KEY, book_id INTEGER, user_id INTEGER);
    CREATE TABLE settings (id INTEGER PRIMARY KEY);
    INSERT INTO book_shelf_link (book_id, shelf) VALUES (1, 1), (900, 1), (900, 2);
    INSERT INTO book_read_link (book_id, user_id) VALUES (901, 1);`);
  app.close();
});

afterEach(() => {
  c.db.close(); c.data.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const check = () => {
  const out = spawnSync("python3", ["-I", script, lib, "--app-db", appDb, "--backups", path.join(root, ".corpus-backups", "main")], { encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout;
};

it("finds broken records, classes orphan folders by their files, and lists covers, strays, backups and Calibre-Web links", () => {
  const before = fs.readFileSync(path.join(lib, "metadata.db"));
  const r = parseHealthOutput(check())!;
  expect(fs.readFileSync(path.join(lib, "metadata.db")).equals(before)).toBe(true);
  expect(r.counts).toEqual({ records_missing: 1, orphans: 3, orphans_leftover: 1, orphans_lost: 1, orphans_empty: 1, cover_unflagged: 1,
    strays: 2, corpus_backups: 2, app_db_missing_links: 2 });
  expect(r.records_missing).toEqual([{ id: 2, uuid: "uuid-2", title: "Broken", path: "Ann Author/Broken (2)", folder_missing: true, formats_missing: ["PDF"], cover_missing: true }]);
  expect(r.orphans.map((o) => [o.path, o.kind, o.id])).toEqual([
    ["Ann Author/Kept (41)", "leftover", 41], ["Unknown/Cover Only (7)", "empty", 7], ["Unknown/Lost Book (612)", "lost", 612]]);
  expect(r.orphans[0].files).toEqual([{ file: "Kept - Ann Author.pdf", bytes: pdf.length, matches: [{ id: 1, format: "PDF" }] }]);
  expect(r.orphans[0].record).toBeNull();
  expect(r.cover_unflagged).toEqual([{ id: 3, title: "Covered", path: "Bo Writer/Covered (3)" }]);
  expect(r.strays.map((s) => s.path)).toEqual(["Unknown/Book-layout1.indd - Unknown.pdf", "metadata.db.bak_2026-11-11"]);
  expect(r.corpus_backups.count).toBe(2);
  expect(r.app_db).toEqual({ checked: true, missing_links: [{ table: "book_read_link", book_id: 901, count: 1 }, { table: "book_shelf_link", book_id: 900, count: 2 }] });
  expect(r.backups).toEqual({ dir: path.join(root, ".corpus-backups", "main"), exists: false, count: 0, bytes: 0 });
});

it("names the record a folder's id still belongs to, when it lives elsewhere", () => {
  fs.mkdirSync(path.join(lib, "Unknown", "Kept (1)"));
  fs.writeFileSync(path.join(lib, "Unknown", "Kept (1)", "Kept - Unknown.pdf"), pdf);
  const r = parseHealthOutput(check())!;
  expect(r.orphans.find((o) => o.path === "Unknown/Kept (1)")).toMatchObject({ kind: "leftover", record: { title: "Kept", path: "Ann Author/Kept (1)", folder_exists: true } });
});

it("keeps each report from the job, and the page's view adds book ids, references and other copies", async () => {
  c.data.prepare("INSERT INTO citekeys (calibre_uuid, citekey, book_id, title, pinned_at) VALUES ('uuid-2', 'broken2020', 'main:2', 'Broken', 'now')").run();
  const r = new JobRunner(c, config, { refresh: async () => {}, calibre: async (command, _stdin, log) => {
    expect(command).toBe("health");
    // Split across chunks, as ssh delivers it.
    const out = check();
    log("checking\n" + out.slice(0, 50)); log(out.slice(50));
  } });
  const id = r.start("health", "apply", {}, "me@example.com");
  for (let i = 0; i < 200 && r.get(id).status === "running"; i++) await new Promise((done) => setTimeout(done, 5));
  const job = r.get(id);
  expect(job.status, job.log).toBe("succeeded");
  expect(job.log).toMatch(/^checking\n3 records checked\. 1 with missing files; 3 folders with no record \(1 leftover, 1 lost, 1 empty\)/);
  expect(job.log).not.toContain("@@health");
  expect(latestHealthReport(c.data)!.job_id).toBe(id);
  const view = healthView(c, "main");
  // Books 1 and 2 had the same PDF, so the duplicate check names 1 as another copy of the broken record.
  expect(view.report!.records_missing[0]).toMatchObject({ book_id: "main:2", references: { citekeys: 1 }, copies: [{ book_id: "main:1", title: "Kept", status: "indexed" }] });
  expect(view.report!.orphans[0].files[0].matches).toEqual([{ id: 1, format: "PDF", book_id: "main:1", title: "Kept" }]);
  expect(view.report!.cover_unflagged[0].book_id).toBe("main:3");
});

it("fails the job, keeping the last good report, when the host sends no report", async () => {
  const r = new JobRunner(c, config, { refresh: async () => {}, calibre: async (_command, _stdin, log) => { log("calibre-health: unable to open database file\n"); } });
  const id = r.start("health", "apply", {}, "me@example.com");
  for (let i = 0; i < 200 && r.get(id).status === "running"; i++) await new Promise((done) => setTimeout(done, 5));
  expect(r.get(id).status).toBe("failed");
  expect(latestHealthReport(c.data)).toBeNull();
});

it("renders a syntactically valid page script", () => {
  for (const match of HEALTH_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) expect(() => new Function(match[1])).not.toThrow();
});
