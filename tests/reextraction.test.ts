import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { anchorChanges, storeAnchor, type Anchor } from "../src/anchors.js";
import { openDatabase } from "../src/db.js";
import { openDataStore } from "../src/data.js";
import { scanLibraries } from "../src/indexer.js";
import { getQuote, saveQuote } from "../src/quotes.js";
import { prepareEpubRollback, stageEpubReextraction } from "../src/reextraction.js";
import { readerQuotes } from "../src/quoteMcp.js";
import type { Config } from "../src/config.js";
import type { BookRow, Corpus } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { makeEpub, makeLibrary, tempDir } from "./fixtures.js";

it("stages corrected text, passages, and same-file anchors in copies, retaining refused books", async () => {
  const root = tempDir();
  const paragraph = "A sufficiently long opening with several visual lines and enough words to wrap. ".repeat(5) + "\u{1f642} ";
  const epub = makeEpub("Source", [{ title: "Chapter", paragraphs: [], css: "p {line-height:1.7;margin:0}",
    body: `<p>${paragraph}Repeated quote. Between them. Repeated quote. Target</p><p>lowercase next paragraph</p>` }]);
  makeLibrary(root, "main", [
    { id: 1, title: "Source", files: { epub } },
    { id: 2, title: "Unsupported", files: { epub: makeEpub("Grid", [{ title: "Grid", paragraphs: [], body: '<div style="display:grid">Grid layout.</div>' }]) } },
  ]);
  const config: Config = { booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"), shelvesFile: path.join(root, "shelves.json"),
    shelvesLibrary: "main", host: "127.0.0.1", port: 0, citekeyPreset: "author-year-word", vocabularyPath: path.join(import.meta.dirname, "vocabulary.json") };
  const db = openDatabase(config.dbPath), data = openDataStore(config.dataDbPath);
  let stagedDb: ReturnType<typeof openDatabase> | undefined, stagedData: ReturnType<typeof openDataStore> | undefined;
  try {
    scanLibraries(config, db);
    const c = { db, data, booksRoot: root, vocabulary: Vocabulary.load(config.vocabularyPath) } as Corpus;
    const before = db.prepare("SELECT text FROM pages WHERE book_id='main:1' AND page_index=0").pluck().get() as string;
    const hash = db.prepare("SELECT sha256 FROM books WHERE id='main:1'").pluck().get() as string;
    const offset = before.lastIndexOf("Repeated quote.");
    const old: Anchor = { calibre_uuid: "uuid-1", sha256: hash, start_page: 0, end_page: 0,
      start_offset: offset, end_offset: offset + "Repeated quote.".length, text: "Repeated quote.",
      prefix: "", suffix: "", page_label: null, end_page_label: null, section: null };
    expect(storeAnchor(c, { excludeTags: [] }, { quote_id: 70, anchor: old }).status).toBe(201);
    const saved = saveQuote(c, { book_id: "main:1", text: "Target lowercase next paragraph" }, undefined, "agent");
    expect(saved.saved).toBe(true);
    const quoteId = data.prepare("SELECT id FROM quotes").pluck().get() as number;
    const orphan = { ...(data.prepare("SELECT * FROM quotes WHERE id=?").get(quoteId) as Record<string, unknown>),
      id: quoteId + 1, status: "orphaned", text: "Legacy\n\nwording", prefix: "Old\n\nprefix", suffix: "old\n\nsuffix" };
    const keys = Object.keys(orphan);
    data.prepare(`INSERT INTO quotes (${keys.join(",")}) VALUES (${keys.map((k) => "@" + k).join(",")})`).run(orphan);
    const originalAnchors = data.prepare("SELECT * FROM anchors").all();
    const originalQuotes = data.prepare("SELECT * FROM quotes").all();
    const output = path.join(root, "candidate");
    const mirrorFile = path.join(root, "mirror.epub");
    fs.writeFileSync(mirrorFile, epub);
    // Rehearse the additive page-separator migration on a schema-6 snapshot.
    db.exec("ALTER TABLE pages DROP COLUMN separator_before");
    db.prepare("UPDATE meta SET value='6' WHERE key='schema_version'").run();
    const report = await stageEpubReextraction({ index: config.dbPath, data: config.dataDbPath, booksRoot: root, output, books: ["main:1", "main:2"], files: { "main:1": mirrorFile } });
    expect(report.promotionReady).toBe(false);
    expect(report.books).toMatchObject([{ book: "main:1", status: "staged" }, { book: "main:2", status: "refused" }]);
    expect(db.prepare("SELECT text FROM pages WHERE book_id='main:1' AND page_index=0").pluck().get()).toBe(before);
    expect(data.prepare("SELECT * FROM anchors").all()).toEqual(originalAnchors);
    expect(data.prepare("SELECT * FROM quotes").all()).toEqual(originalQuotes);
    expect(db.prepare("PRAGMA table_info(pages)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "separator_before" })]));
    stagedDb = openDatabase(path.join(output, "corpus.db")); stagedData = openDataStore(path.join(output, "data.db"));
    const after = stagedDb.prepare("SELECT text FROM pages WHERE book_id='main:1' AND page_index=0").pluck().get() as string;
    expect(after).toContain("Target\n\nlowercase");
    expect(stagedDb.prepare("SELECT separator_before FROM pages WHERE book_id='main:1' AND page_index=0").pluck().get()).toBe("");
    expect(stagedDb.prepare("SELECT text_chars FROM books WHERE id='main:1'").pluck().get()).toBe([...after].length);
    expect([...after].length).toBeLessThan(after.length);
    expect(stagedDb.prepare("SELECT sha256 FROM books WHERE id='main:1'").pluck().get()).toBe(hash);
    expect(stagedDb.prepare("SELECT extractor_version FROM books WHERE id='main:1'").pluck().get()).toBe(2);
    const migrated = stagedData.prepare("SELECT * FROM anchors WHERE quote_id=70").get() as Anchor;
    expect(migrated.start_offset).toBe(after.lastIndexOf("Repeated quote."));
    expect(migrated.start_offset).not.toBe(offset);
    expect((anchorChanges({ db: stagedDb, data: stagedData } as Corpus, "0").body as { changes: unknown[] }).changes).toHaveLength(2);
    const q = getQuote({ ...c, db: stagedDb, data: stagedData }, quoteId);
    expect(q.prose).toBe("Target\n\nlowercase next paragraph");
    const keptOrphan = getQuote({ ...c, db: stagedDb, data: stagedData }, quoteId + 1);
    expect(keptOrphan.prose).toBe("Legacy wording");
    expect(keptOrphan.context).toEqual({ before: "Old prefix", after: "old suffix" });
    const stagedBook = stagedDb.prepare("SELECT * FROM books WHERE id='main:1'").get() as BookRow;
    const external = (a: Anchor) => ({ id: 70, anchor: a, comment: null, tags: [], flags: [], admin_path: "/admin/quotes/70" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ quotes: [external(old)] }), { status: 200 })));
    expect((await readerQuotes("http://quote.test", stagedBook, 0, 0, stagedData)).quotes).toEqual([]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ quotes: [external(migrated)] }), { status: 200 })));
    expect((await readerQuotes("http://quote.test", stagedBook, 0, 0, stagedData)).quotes).toHaveLength(1);
    const { text: omittedText, ...withoutText } = migrated;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ quotes: [{ ...external(migrated), anchor: withoutText }] }), { status: 200 })));
    expect((await readerQuotes("http://quote.test", stagedBook, 0, 0, stagedData)).quotes).toHaveLength(1);
    const legacyBook = db.prepare("SELECT * FROM books WHERE id='main:1'").get() as BookRow;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ quotes: [{ ...external(migrated), anchor: withoutText }] }), { status: 200 })));
    expect((await readerQuotes("http://quote.test", legacyBook, 0, 0, data)).quotes).toEqual([]);
    vi.unstubAllGlobals();
    expect(stagedDb.prepare("SELECT text FROM passages WHERE book_id='main:1' ORDER BY ord").all()).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Target\n\nlowercase") })]));
    expect(stagedDb.prepare("SELECT extractor_version FROM books WHERE id='main:2'").pluck().get()).toBe(1);
    const refresh = scanLibraries({ ...config, dbPath: path.join(output, "corpus.db"), dataDbPath: path.join(output, "data.db") }, stagedDb, { force: true });
    expect(refresh).toMatchObject({ extracted: 2, failed: 0 });
    expect(stagedDb.prepare("SELECT extractor_version FROM books WHERE id='main:1'").pluck().get()).toBe(2);
    expect(stagedDb.prepare("SELECT extractor_version FROM books WHERE id='main:2'").pluck().get()).toBe(1);
    expect(stagedDb.prepare("SELECT text FROM pages WHERE book_id='main:1' AND page_index=0").pluck().get()).toBe(after);
    expect(stagedDb.prepare("SELECT separator_before FROM pages WHERE book_id='main:1' AND page_index=0").pluck().get()).toBe("");
    expect(stagedDb.prepare("SELECT printed_years_version FROM books WHERE id='main:1'").pluck().get()).not.toBeNull();
    await expect(stageEpubReextraction({ index: config.dbPath, data: config.dataDbPath, booksRoot: root, output, books: ["main:1"] })).rejects.toThrow(/new directory/);
    // A stale verified anchor refuses the whole book, with its index and anchors retained in the copy.
    data.prepare("UPDATE anchors SET start_offset=0 WHERE quote_id=70").run();
    const blocked = await stageEpubReextraction({ index: config.dbPath, data: config.dataDbPath, booksRoot: root, output: path.join(root, "blocked"), books: ["main:1"] });
    expect(blocked.books[0]).toMatchObject({ status: "refused", anchors: expect.arrayContaining([expect.objectContaining({ id: 70, status: "review", reason: "stale-old-anchor" })]) });
    // Existing version-2 metadata must not turn a pre-write extraction refusal into a write failure.
    db.prepare("UPDATE books SET extractor_version=2 WHERE id='main:2'").run();
    const preversioned = await stageEpubReextraction({ index: config.dbPath, data: config.dataDbPath, booksRoot: root, output: path.join(root, "preversioned"), books: ["main:2"] });
    expect(preversioned.books[0]).toMatchObject({ status: "refused" });
    data.prepare("UPDATE anchors SET start_offset=? WHERE quote_id=70").run(offset);
    db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON passages BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    const failedOutput = path.join(root, "write-failure");
    await expect(stageEpubReextraction({ index: config.dbPath, data: config.dataDbPath, booksRoot: root, output: failedOutput, books: ["main:1"] })).rejects.toThrow(/injected write failure/);
    expect(JSON.parse(fs.readFileSync(path.join(failedOutput, "report.json"), "utf8"))).toMatchObject({ failed: true, promotionReady: false });
    const originalLog = data.prepare("SELECT value FROM meta WHERE key='anchor_log'").pluck().get();
    const rollback = await prepareEpubRollback({ index: config.dbPath, data: config.dataDbPath, output: path.join(root, "rollback") });
    expect(rollback).toMatchObject({ promotionReady: false, requiresQuiescedWrites: true, anchorLogRotated: true });
    const rollbackData = openDataStore(path.join(rollback.directory, "data.db"));
    try { expect(rollbackData.prepare("SELECT value FROM meta WHERE key='anchor_log'").pluck().get()).not.toBe(originalLog); }
    finally { rollbackData.close(); }
    expect(data.prepare("SELECT value FROM meta WHERE key='anchor_log'").pluck().get()).toBe(originalLog);
  } finally {
    vi.unstubAllGlobals();
    stagedDb?.close(); stagedData?.close(); db.close(); data.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
