import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCatalogue } from "../src/calibre.js";
import { chunkPage } from "../src/chunk.js";
import type { Config } from "../src/config.js";
import { type DB, openDatabase } from "../src/db.js";
import { extractBook, sectionPaths } from "../src/extract.js";
import { scanLibraries } from "../src/indexer.js";
import {
  ToolError, citePassage, corpusStatus, getBookOutline, listBooks, readBook, renderPage, searchCorpus, toFtsQuery, validIsbn,
} from "../src/tools.js";
import { makeEpub, makeLibrary, makePdf, tempDir } from "./fixtures.js";

const filler = Array.from({ length: 10 }, (_, i) => `Filler line ${i} about social structure and its measurement.`);

const pdf = makePdf({
  pages: [
    ["Preface on method and sources"],
    ["Acknowledgements to many colleagues"],
    ["Weak ties carry novel information between clusters", ...filler],
    ["Strong ties sit inside dense clusters of friends", ...filler],
    ["Structural holes separate otherwise connected groups"],
  ],
  footer: (i) => `folio ${i + 1}`,
  labels: [[0, "r", 1], [2, "D", 1]],
  outline: [
    { title: "Preface", page: 1 },
    { title: "Part One", page: 3, children: [{ title: "Chapter 1", page: 3 }, { title: "Chapter 2", page: 5 }] },
  ],
});

const epub = makeEpub("Echoes", [
  { title: "Alpha", paragraphs: ["The echo chamber amplifies familiar claims."] },
  { title: "Beta", paragraphs: ["Filter bubbles differ from echo chambers in cause."] },
]);

let root: string;
let config: Config;
let db: DB;

function build(): void {
  makeLibrary(root, "main", [
    { id: 1, title: "Networks", authors: ["Ann Author", "Bo Second"], publisher: "Free Press", pubdate: "1986-05-01 00:00:00+00:00", isbn: "978-0-00-000000-2", tags: ["sociology"], files: { pdf, mobi: Buffer.from("ignored") } },
    { id: 2, title: "Echoes", authors: ["Cy Writer"], files: { epub } },
    { id: 3, title: "Cover Only", authors: ["Nobody"] },
    { id: 4, title: "Diary", authors: ["Me"], tags: ["Private"], files: { epub } },
  ]);
  makeLibrary(root, "library", [{ id: 7, title: "Networks", authors: ["Ann Author", "Bo Second"], files: { pdf } }]);
  makeLibrary(root, "private", [{ id: 1, title: "Secret", authors: ["Me"], files: { epub } }]);
}

beforeEach(() => {
  root = tempDir();
  build();
  config = { booksRoot: root, libraries: ["main", "library"], excludeTags: ["private"], dbPath: path.join(root, "corpus.db"), host: "127.0.0.1", port: 0 };
  db = openDatabase(config.dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("calibre catalogue", () => {
  it("reads metadata and format files from metadata.db", () => {
    const [networks, echoes] = readCatalogue(path.join(root, "main"));
    expect(networks.metadata).toMatchObject({
      calibreId: 1, title: "Networks", authors: ["Ann Author", "Bo Second"], publisher: "Free Press",
      year: 1986, language: "eng", isbn: "978-0-00-000000-2", tags: ["sociology"],
    });
    expect(Object.keys(networks.files).sort()).toEqual(["mobi", "pdf"]);
    expect(echoes.metadata.year).toBeNull(); // Calibre's 0101 "undefined" date
  });
});

describe("extraction", () => {
  it("keeps printed page labels and outline pages for a PDF, and drops folios", () => {
    const book = extractBook(pdf, "pdf");
    expect(book.reflowable).toBe(false);
    expect(book.pages.map((p) => p.label)).toEqual(["i", "ii", "1", "2", "3"]);
    expect(book.pages[2].paragraphs).toEqual(["Weak ties carry novel information between clusters", ...filler]);
    expect(book.outline.map((e) => [e.path, e.startPage])).toEqual([
      ["Preface", 0], ["Part One", 2], ["Part One › Chapter 1", 2], ["Part One › Chapter 2", 4],
    ]);
    expect(sectionPaths(book.outline, 5)).toEqual(["Preface", "Preface", "Part One › Chapter 1", "Part One › Chapter 1", "Part One › Chapter 2"]);
  });

  it("resolves EPUB outline links to locations and has no page labels", () => {
    const book = extractBook(epub, "epub");
    expect(book.reflowable).toBe(true);
    expect(book.outline.map((e) => [e.title, e.startPage])).toEqual([["Alpha", 0], ["Beta", 1]]);
    expect(book.pages.every((p) => p.label === null)).toBe(true);
  });
});

describe("chunking", () => {
  it("groups short paragraphs and splits overlong ones", () => {
    const short = Array.from({ length: 30 }, (_, i) => `para ${i} ` + "word ".repeat(18));
    const passages = chunkPage(short);
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((p) => p.split(/\s+/).length <= 320)).toBe(true);
    expect(chunkPage(["word ".repeat(700)])).toHaveLength(4);
  });
});

describe("indexer", () => {
  it("indexes allowlisted libraries, prefers PDF, and skips unchanged files", () => {
    const first = scanLibraries(config, db);
    expect(first).toMatchObject({ scanned: 4, extracted: 3, noFile: 1, failed: 0, excluded: 1 });
    expect(db.prepare("SELECT COUNT(*) FROM books WHERE id = 'main:4'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT format FROM books WHERE id = 'main:1'").pluck().get()).toBe("pdf");
    expect(db.prepare("SELECT COUNT(*) FROM books WHERE library = 'private'").pluck().get()).toBe(0);
    expect(scanLibraries(config, db)).toMatchObject({ extracted: 0, unchanged: 3 });
  });

  it("re-extracts a changed file and removes deleted books", () => {
    scanLibraries(config, db);
    const echoes = path.join(root, "main", "Cy Writer", "Echoes (2)", "Echoes - Cy Writer.epub");
    fs.writeFileSync(echoes, makeEpub("Echoes", [{ title: "Gamma", paragraphs: ["Entirely new text about polarization."] }]));
    fs.rmSync(path.join(root, "library"), { recursive: true });
    makeLibrary(root, "library", []);
    const second = scanLibraries(config, db);
    expect(second).toMatchObject({ extracted: 1, removed: 1 });
    expect(searchCorpus(db, { query: "polarization" }).results[0].book_id).toBe("main:2");
    expect(searchCorpus(db, { query: "amplifies" }).count).toBe(0);
  });

  it("keeps a library's rows when its metadata.db cannot be read", () => {
    scanLibraries(config, db);
    fs.writeFileSync(path.join(root, "library", "metadata.db"), "partially synced");
    const summary = scanLibraries(config, db);
    expect(summary.unreadableLibraries).toEqual(["library"]);
    expect(summary.removed).toBe(0);
    expect(db.prepare("SELECT status FROM books WHERE id = 'library:7'").pluck().get()).toBe("indexed");
  });
});

describe("tools", () => {
  beforeEach(() => {
    scanLibraries(config, db);
  });

  it("validates ISBN check digits", () => {
    expect(validIsbn("ISBN 978-0-306-40615-7")).toBe("9780306406157");
    expect(validIsbn("0-306-40615-2")).toBe("0306406152");
    expect(validIsbn("080442957X")).toBe("080442957X");
    expect(validIsbn("9780306406158")).toBeNull();
    expect(validIsbn("not an isbn")).toBeNull();
  });

  it("escapes plain queries for FTS5", () => {
    expect(toFtsQuery('Arendt\'s "banality of evil" polar*')).toBe('"Arendt\'s" "banality of evil" "polar"*');
    expect(() => toFtsQuery("()")).toThrow(ToolError);
  });

  it("searches with locators and collapses identical files across libraries", () => {
    const { results } = searchCorpus(db, { query: "weak ties" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ page: 3, page_label: "1", section: "Part One › Chapter 1" });
    expect(results[0].snippet).toContain("«Weak»");
    expect(searchCorpus(db, { query: '"echo chamber"' }).results[0]).toMatchObject({ book_id: "main:2", section: "Alpha", page_label: null });
    expect(searchCorpus(db, { query: "clusters", library: "library" }).results.every((r) => r.book_id === "library:7")).toBe(true);
  });

  it("lists books with their duplicate copies", () => {
    const { books } = listBooks(db, { query: "Networks" });
    expect(books.map((b) => b.book_id)).toEqual(["library:7", "main:1"]);
    expect(books[1].same_file_as).toEqual(["library:7"]);
    expect(listBooks(db, { include_unindexed: true, query: "Cover" }).books[0].status).toBe("no_file");
  });

  it("returns an outline with 1-based pages and printed labels", () => {
    const outline = getBookOutline(db, "main:1");
    expect(outline.outline[2]).toEqual({ level: 1, title: "Chapter 1", page: 3, page_label: "1" });
    expect(getBookOutline(db, "main:2").page_kind).toBe("location");
  });

  it("reads a section or a page range and reports where to continue", () => {
    const section = readBook(db, { book_id: "main:1", section: "Chapter 1" });
    expect(section).toContain("--- page 3 (printed 1) · Part One › Chapter 1 ---");
    expect(section).toContain("--- page 4 (printed 2)");
    expect(section).not.toContain("page 5");
    const partial = readBook(db, { book_id: "main:1", start_page: 1, end_page: 5, max_chars: 500 });
    expect(partial).toMatch(/Continue with start_page \d/);
    expect(() => readBook(db, { book_id: "main:1", start_page: 9 })).toThrow(/pages 1–5/);
  });

  it("cites PDFs with printed page ranges and EPUBs without pages", () => {
    const pdfCite = citePassage(db, { book_id: "main:1", page: 3, end_page: 4 });
    expect(pdfCite.citation).toEqual({ title: "Networks", author: "Ann Author and Bo Second", publisher: "Free Press", year: "1986", pages: "1-2" });
    expect(pdfCite.isbn).toBe("978-0-00-000000-2");
    expect(pdfCite.zotero_filing).toEqual({ tool: "file_zotero_reference", arguments: { isbn: "9780000000002" } });
    const epubCite = citePassage(db, { book_id: "main:2", page: 1 });
    expect(epubCite.citation).toEqual({ title: "Echoes", author: "Cy Writer" });
    expect(epubCite.locator).toMatchObject({ section: "Alpha" });
    expect(epubCite.warnings.join(" ")).toMatch(/not page numbers/);
    expect(epubCite.zotero_filing).toBeUndefined();
    expect(epubCite.warnings.join(" ")).toMatch(/no ISBN/);
  });

  it("renders PDF pages and refuses reflowable books", () => {
    const image = renderPage(db, root, { book_id: "main:1", page: 1, scale: 0.5 });
    expect(Buffer.from(image.png, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(image.width).toBe(306);
    expect(() => renderPage(db, root, { book_id: "main:2", page: 1 })).toThrow(/no fixed pages/);
  });

  it("reports status", () => {
    const status = corpusStatus(db);
    expect(status.last_scan).not.toBeNull();
    expect(status.failed).toEqual([]);
  });
});
