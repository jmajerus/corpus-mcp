import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDataStore } from "../src/data.js";
import { openDatabase } from "../src/db.js";
import { etagMatches, holdingsBooks, holdingsBooksResponse } from "../src/holdings.js";
import { scanLibraries } from "../src/indexer.js";
import type { Corpus } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

let root: string;
let c: Corpus;
const o = { excludeTags: ["private"], zoteroLibrary: "users/1" };

beforeAll(() => {
  root = tempDir();
  makeLibrary(root, "main", [
    { id: 1, title: "Networks", authors: ["Ann Author"], pubdate: "2001-01-01", isbn: "978-0-306-40615-7", files: { pdf: makePdf({ pages: [["Weak ties carry novel information"]] }) } },
    { id: 2, title: "Crowds", authors: ["Bob Writer"], pubdate: "1999-01-01", isbn: "978-0-306-40615-8", files: { pdf: makePdf({ pages: [["Crowds and their moods"]] }) } },
    { id: 3, title: "Diary", authors: ["Cy Self"], tags: ["private"], files: { pdf: makePdf({ pages: [["Not for anyone"]] }) } },
    { id: 4, title: "Patterns", authors: ["Dee Maker"], pubdate: "2010-01-01", files: { pdf: makePdf({ pages: [[""]] }) } },
  ]);
  const vocabularyPath = path.join(import.meta.dirname, "vocabulary.json");
  const config: Config = {
    booksRoot: root, libraries: ["main"], excludeTags: ["private"], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
    citekeyPreset: "author-year-word", vocabularyPath,
  };
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  const data = openDataStore(config.dataDbPath);
  data.prepare("INSERT INTO citekeys (calibre_uuid, citekey, book_id, title, pinned_at) VALUES ('uuid-1', 'author2001networks', 'main:1', 'Networks', '2026-10-28')").run();
  // Filed with book 2's UUID in Extra: a match, which brings its citekey.
  data.prepare("INSERT INTO zotero_items (key, version, item_type, title, calibre_uuid, citekey, synced_at) VALUES ('ITEM2', 1, 'book', 'Crowds', 'uuid-2', 'writer1999crowds', '2026-10-28')").run();
  // The same title and author as book 4, but nothing ties it to the book: a candidate only.
  data.prepare("INSERT INTO zotero_items (key, version, item_type, title, title_norm, first_creator, year, citekey, synced_at) VALUES ('ITEM4', 1, 'book', 'Patterns', 'patterns', 'maker', 2010, 'maker2010patterns', '2026-10-28')").run();
  c = { db, data, booksRoot: root, vocabulary: Vocabulary.load(vocabularyPath) };
});

afterAll(() => {
  c.db.close();
  c.data.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("sends every book but the private ones, with real keys and confirmed matches only", () => {
  const feed = holdingsBooks(c, o);
  expect(feed.version).toBe(1);
  expect(feed.books.map((b) => b.book_id)).toEqual(["main:1", "main:2", "main:4"]);
  const [networks, crowds, patterns] = feed.books;
  expect(networks).toEqual({
    calibre_uuid: "uuid-1", book_id: "main:1", library: "main", title: "Networks", authors: ["Ann Author"], year: 2001,
    formats: ["pdf"], has_text: true, isbns: ["9780306406157"], citekey: "author2001networks", citekey_source: "pinned", zotero: null,
  });
  // A failed check digit isn't sent, and a book with no ISBN has an empty list.
  expect([crowds.isbns, patterns.isbns]).toEqual([[], []]);
  expect(crowds).toMatchObject({ citekey: "writer1999crowds", citekey_source: "zotero", zotero: { library: "users/1", key: "ITEM2", matched_by: "calibre_uuid" } });
  // A candidate isn't a match, and a proposed citekey isn't a key.
  expect(patterns).toMatchObject({ has_text: false, citekey: null, citekey_source: null, zotero: null });
});

it("has no Zotero items without a mirrored library", () => {
  expect(holdingsBooks(c, { excludeTags: ["private"] }).books.every((b) => b.zotero === null)).toBe(true);
});

it("keeps its ETag until a book's keys change", () => {
  const first = holdingsBooksResponse(c, o);
  expect(first.etag).toMatch(/^"[0-9a-f]{32}"$/);
  expect(holdingsBooksResponse(c, o).etag).toBe(first.etag);
  c.data.prepare("UPDATE citekeys SET citekey = 'author2001revised' WHERE calibre_uuid = 'uuid-1'").run();
  try {
    expect(holdingsBooksResponse(c, o).etag).not.toBe(first.etag);
  } finally {
    c.data.prepare("UPDATE citekeys SET citekey = 'author2001networks' WHERE calibre_uuid = 'uuid-1'").run();
  }
});

it("leaves out books the index couldn't read, and matches an ETag weakly", () => {
  c.db.prepare("UPDATE books SET status = 'failed' WHERE id = 'main:4'").run();
  try {
    expect(holdingsBooks(c, o).books.map((b) => b.book_id)).toEqual(["main:1", "main:2"]);
  } finally {
    c.db.prepare("UPDATE books SET status = 'indexed' WHERE id = 'main:4'").run();
  }
  const { etag } = holdingsBooksResponse(c, o);
  for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) expect(etagMatches(header, etag), header).toBe(true);
  for (const header of [undefined, "", `"other"`, `W/"other"`]) expect(etagMatches(header, etag), String(header)).toBe(false);
});
