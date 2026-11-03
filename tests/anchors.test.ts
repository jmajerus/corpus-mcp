import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Anchor, anchorChanges, deleteAnchor, reanchorAnchors, storeAnchor, verifyPassage } from "../src/anchors.js";
import type { Config } from "../src/config.js";
import { openDataStore } from "../src/data.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import type { Corpus } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

let root: string;
let c: Corpus;
const o = { excludeTags: ["private"], zoteroLibrary: "users/1" };
const PASSAGE = "Weak ties carry novel information between groups.";

beforeAll(() => {
  root = tempDir();
  makeLibrary(root, "main", [
    { id: 1, title: "Networks", authors: ["Ann Author"], pubdate: "2001-01-01",
      files: { pdf: makePdf({ pages: [[PASSAGE, "Bridges matter."], ["Strong ties bind.", PASSAGE]] }) } },
    { id: 2, title: "Scans", authors: ["Bob Writer"], files: { pdf: makePdf({ pages: [[""], [""]] }) } },
    { id: 3, title: "Twins", authors: ["Cy Twin"], citekey: "twin2000book", files: { pdf: makePdf({ pages: [["The first copy of the twin text."]] }) } },
    { id: 4, title: "Twins", authors: ["Cy Twin"], citekey: "twin2000book", files: { pdf: makePdf({ pages: [["The second copy of the twin text."]] }) } },
    { id: 6, title: "Handbook", authors: ["Eve Isbn"], isbn: "9780306406157", files: { pdf: makePdf({ pages: [["Every handbook has an index at the back."]] }) } },
    { id: 5, title: "Diary", authors: ["Dee Self"], tags: ["private"], files: { pdf: makePdf({ pages: [["Not for anyone at all."]] }) } },
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
  data.prepare("INSERT INTO zotero_items (key, version, item_type, title, calibre_uuid, citekey, synced_at) VALUES ('ITEM1', 1, 'book', 'Networks', 'uuid-1', 'author2001networks', '2026-10-28')").run();
  data.prepare("INSERT INTO zotero_items (key, version, item_type, title, calibre_uuid, citekey, synced_at) VALUES ('ITEM2', 1, 'book', 'Scans', 'uuid-2', 'writer2000scans', '2026-10-28')").run();
  data.prepare("INSERT INTO zotero_items (key, version, item_type, title, synced_at) VALUES ('ITEM6', 1, 'book', 'Handbook', '2026-10-28')").run();
  data.prepare("INSERT INTO zotero_isbns (isbn, key) VALUES ('9780306406157', 'ITEM6')").run();
  c = { db, data, booksRoot: root, vocabulary: Vocabulary.load(vocabularyPath) };
});

afterAll(() => {
  c.db.close();
  c.data.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const verify = (body: unknown) => verifyPassage(c, o, body);
const matched = (body: unknown) => verify(body).body as { match: true; exact: boolean; text: string; locator: string | null; page_label: string | null; anchor: Anchor; book: { book_id: string } };

describe("verify", () => {
  it("finds a passage by any key the book has, with the book it checked", () => {
    for (const book of ["main:1", "author2001networks", "uuid-1", "zotero:users/1/ITEM1"]) {
      const answer = verify({ book, text: PASSAGE });
      expect(answer.status, book).toBe(200);
      const body = answer.body as ReturnType<typeof matched>;
      expect(body, book).toMatchObject({ match: true, exact: true, text: PASSAGE, book: { book_id: "main:1", citekey: "author2001networks", zotero: { key: "ITEM1" } } });
      expect(body.anchor).toMatchObject({ calibre_uuid: "uuid-1", start_page: 0, start_offset: 0, text: PASSAGE, prefix: "" });
      expect(body.locator).toBe(body.page_label ? `p. ${body.page_label}` : null);
    }
  });

  it("finds the book a Zotero item is matched to by ISBN, or through items merged into it", () => {
    expect(matched({ book: "zotero:users/1/ITEM6", text: "Every handbook has an index" }).book).toMatchObject({ book_id: "main:6", zotero: { matched_by: "isbn" } });
    c.data.prepare("INSERT INTO zotero_items (key, version, item_type, title, replaces, synced_at) VALUES ('ITEM9', 1, 'book', 'Networks', '[\"ITEM1\"]', '2026-10-28')").run();
    try {
      expect(matched({ book: "zotero:users/1/ITEM9", text: PASSAGE }).book).toMatchObject({ book_id: "main:1", zotero: { key: "ITEM9" } });
      expect(verify({ book: "zotero:users/1/ITEM1", text: PASSAGE }).status).toBe(404);
    } finally {
      c.data.prepare("DELETE FROM zotero_items WHERE key = 'ITEM9'").run();
    }
  });

  it("returns the book's wording, and says when it differs from what was sent", () => {
    expect(matched({ book: "main:1", text: "weak ties carry  novel information" })).toMatchObject({ exact: false, text: "Weak ties carry novel information" });
  });

  it("looks first on the page it's given", () => {
    expect(matched({ book: "main:1", text: PASSAGE, page: 2 }).anchor).toMatchObject({ start_page: 1 });
  });

  it("offers the closest passages when the text isn't there", () => {
    const answer = verify({ book: "main:1", text: "Weak ties carry stale gossip between groups." });
    expect(answer.status).toBe(200);
    const body = answer.body as { match: boolean; closest: { page: number; snippet: string }[]; book: { book_id: string } };
    expect(body).toMatchObject({ match: false, book: { book_id: "main:1" } });
    expect(body.closest[0]).toMatchObject({ page: expect.any(Number), snippet: expect.stringContaining("«") });
  });

  it("says when there's no book, no text, or more than one book", () => {
    for (const book of ["nobody2000none", "main:99", "main:5", "zotero:users/1/NOPE", "zotero:groups/9/ITEM1"]) {
      expect(verify({ book, text: PASSAGE }), book).toEqual({ status: 404, body: { error: "no-book" } });
    }
    expect(verify({ book: "zotero:users/1/ITEM2", text: PASSAGE })).toMatchObject({ status: 404, body: { error: "no-text", book: { book_id: "main:2", has_text: false } } });
    const twins = verify({ book: "twin2000book", text: "twin text" });
    expect(twins.status).toBe(409);
    expect((twins.body as { books: { book_id: string }[] }).books.map((b) => b.book_id)).toEqual(["main:3", "main:4"]);
  });

  it("refuses an empty, overlong, or malformed request", () => {
    for (const body of [null, {}, { book: "main:1" }, { book: "main:1", text: "  " }, { book: "", text: PASSAGE },
      { book: "main:1", text: "x".repeat(2001) }, { book: "main:1", text: PASSAGE, page: 0 }, { book: "main:1", text: PASSAGE, page: "2" }]) {
      expect(verify(body).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("anchors", () => {
  it("stores a verified anchor once per quote, replaces it, and numbers each change", () => {
    const first = matched({ book: "main:1", text: PASSAGE }).anchor;
    expect(storeAnchor(c, o, { quote_id: 7, anchor: first })).toEqual({ status: 201, body: { quote_id: 7, status: "verified", anchor: first } });
    // A retry after a timeout changes nothing.
    expect(storeAnchor(c, o, { quote_id: 7, anchor: first })).toEqual({ status: 200, body: { quote_id: 7, status: "verified", anchor: first } });
    // The same words further on: not the first occurrence on those pages, and still the right place.
    const second = matched({ book: "main:1", text: PASSAGE, page: 2 }).anchor;
    expect(storeAnchor(c, o, { quote_id: 7, anchor: second })).toMatchObject({ status: 200, body: { replaced: true, anchor: { start_page: 1 } } });

    const feed = anchorChanges(c, "0").body as { log: string; changes: { seq: number; quote_id: number; kind: string; anchor: Anchor | null }[]; last: number };
    expect(feed.log).toMatch(/^[0-9a-f-]{36}$/);
    expect(feed.changes.map((ch) => [ch.quote_id, ch.kind, ch.anchor?.start_page])).toEqual([[7, "stored", 0], [7, "replaced", 1]]);
    expect(anchorChanges(c, String(feed.last)).body).toEqual({ log: feed.log, changes: [], last: feed.last });
    expect(anchorChanges(c, "-1").status).toBe(400);
  });

  it("refuses an anchor the book doesn't bear out", () => {
    const anchor = matched({ book: "main:1", text: PASSAGE }).anchor;
    expect(storeAnchor(c, o, { quote_id: 8, anchor: { ...anchor, start_offset: 1 } })).toEqual({ status: 409, body: { error: "stale-anchor" } });
    expect(storeAnchor(c, o, { quote_id: 8, anchor: { ...anchor, sha256: "an-older-file" } })).toEqual({ status: 409, body: { error: "stale-anchor" } });
    expect(storeAnchor(c, o, { quote_id: 8, anchor: { ...anchor, end_offset: 10_000 } })).toEqual({ status: 409, body: { error: "stale-anchor" } });
    expect(storeAnchor(c, o, { quote_id: 8, anchor: { ...anchor, calibre_uuid: "uuid-99" } })).toEqual({ status: 404, body: { error: "no-book" } });
    for (const body of [{ quote_id: 8 }, { quote_id: 0, anchor }, { quote_id: "8", anchor }, { quote_id: 8, anchor: { ...anchor, start_page: -1 } }]) {
      expect(storeAnchor(c, o, body).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("never anchors a quote in a book with an excluded tag", () => {
    const anchor = matched({ book: "main:3", text: "The first copy" }).anchor;
    c.db.prepare(`UPDATE books SET tags = '["private"]' WHERE id = 'main:3'`).run();
    try {
      expect(storeAnchor(c, o, { quote_id: 10, anchor })).toEqual({ status: 404, body: { error: "no-book" } });
    } finally {
      c.db.prepare("UPDATE books SET tags = '[]' WHERE id = 'main:3'").run();
    }
  });

  it("deletes an anchor once", () => {
    storeAnchor(c, o, { quote_id: 9, anchor: matched({ book: "main:1", text: PASSAGE }).anchor });
    expect(deleteAnchor(c, 9)).toEqual({ status: 204 });
    expect(deleteAnchor(c, 9)).toEqual({ status: 404, body: { error: "no-anchor" } });
    const changes = (anchorChanges(c, "0").body as { changes: { quote_id: number; kind: string; status: string | null }[] }).changes;
    expect(changes.filter((ch) => ch.quote_id === 9).map((ch) => [ch.kind, ch.status])).toEqual([["stored", "verified"], ["deleted", null]]);
  });

  it("follows the book through rescans: moved, lost, and found again", () => {
    const rescan = (sha: string, text: (old: string) => string) => {
      for (const p of c.db.prepare("SELECT page_index, text FROM pages WHERE book_id = 'main:1'").all() as { page_index: number; text: string }[]) {
        c.db.prepare("UPDATE pages SET text = ? WHERE book_id = 'main:1' AND page_index = ?").run(text(p.text), p.page_index);
      }
      c.db.prepare("UPDATE books SET sha256 = ? WHERE id = 'main:1'").run(sha);
      return reanchorAnchors(c.db, c.data);
    };
    const kinds = (since: number) => (anchorChanges(c, String(since)).body as { changes: { kind: string; status: string; anchor: Anchor }[] }).changes;
    const before = (anchorChanges(c, "0").body as { last: number }).last;
    const original = new Map<number, string>();
    for (const p of c.db.prepare("SELECT page_index, text FROM pages WHERE book_id = 'main:1'").all() as { page_index: number; text: string }[]) original.set(p.page_index, p.text);

    expect(rescan("file-2", (t) => `A new opening. ${t}`)).toEqual({ reanchored: 1, orphaned: 0, found: 0 });
    expect(kinds(before)).toMatchObject([{ kind: "reanchored", status: "verified", anchor: { sha256: "file-2", start_page: 1 } }]);
    // An unchanged file moves nothing.
    expect(reanchorAnchors(c.db, c.data)).toEqual({ reanchored: 0, orphaned: 0, found: 0 });

    expect(rescan("file-3", () => "Nothing of the kind.")).toEqual({ reanchored: 0, orphaned: 1, found: 0 });
    let i = 0;
    expect(rescan("file-4", () => original.get(i++)!)).toEqual({ reanchored: 0, orphaned: 0, found: 1 });
    expect(kinds(before).map((ch) => [ch.kind, ch.status])).toEqual([["reanchored", "verified"], ["orphaned", "orphaned"], ["found", "verified"]]);
    // A book that leaves the index and comes back with the same file is searched again.
    c.db.prepare("UPDATE books SET status = 'failed' WHERE id = 'main:1'").run();
    expect(reanchorAnchors(c.db, c.data)).toEqual({ reanchored: 0, orphaned: 1, found: 0 });
    c.db.prepare("UPDATE books SET status = 'indexed' WHERE id = 'main:1'").run();
    expect(reanchorAnchors(c.db, c.data)).toEqual({ reanchored: 0, orphaned: 0, found: 1 });
    // Quote-mcp can store the anchor it's sent now.
    const now = kinds(before).at(-1)!.anchor;
    expect(storeAnchor(c, o, { quote_id: 7, anchor: now }).status).toBe(200);
  });
});
