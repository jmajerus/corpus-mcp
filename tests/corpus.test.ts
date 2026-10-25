import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCatalogue } from "../src/calibre.js";
import { chunkPage } from "../src/chunk.js";
import type { Config } from "../src/config.js";
import { bookBibtex } from "../src/bibtex.js";
import { calibreCitationData, proposeCitekey, proposedCitationKey } from "../src/citekey.js";
import { type DataStore, backupDataStore, openDataStore } from "../src/data.js";
import { type DB, SCHEMA_VERSION, openDatabase } from "../src/db.js";
import { extractBook, sectionPaths } from "../src/extract.js";
import { findPrintedIsbns } from "../src/isbn.js";
import { scanLibraries } from "../src/indexer.js";
import {
  type Corpus, ToolError, citePassage, corpusStatus, getBookOutline, listBooks, pinCitekey, readBook, renderPage, searchCorpus,
  toFtsQuery, validIsbn,
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
let data: DataStore;
let c: Corpus;

function build(): void {
  makeLibrary(root, "main", [
    { id: 1, title: "Networks", authors: ["Ann Author", "Bo Second"], publisher: "Free Press", pubdate: "1986-05-01 00:00:00+00:00", isbn: "978-0-00-000000-2", tags: ["sociology"], files: { pdf, mobi: Buffer.from("ignored") } },
    { id: 2, title: "Echoes", authors: ["Cy Writer"], files: { epub } },
    { id: 3, title: "Cover Only", authors: ["Nobody"] },
    { id: 4, title: "Diary", authors: ["Me"], tags: ["Private"], files: { epub } },
    { id: 5, title: "Weak Ties Revisited", authors: ["Dee One| Eve Two"], sorts: ["Dee One, Eve Two"], pubdate: "2001-01-01 00:00:00+00:00", files: { epub } },
    { id: 6, title: "Strength in Numbers", authors: ["Fay Fixed"], pubdate: "2000-01-01 00:00:00+00:00", citekey: "Fixed2000Strength", files: { epub } },
  ]);
  makeLibrary(root, "library", [{ id: 7, title: "Networks", authors: ["Ann Author", "Bo Second"], files: { pdf } }]);
  makeLibrary(root, "private", [{ id: 1, title: "Secret", authors: ["Me"], files: { epub } }]);
}

beforeEach(() => {
  root = tempDir();
  build();
  config = {
    booksRoot: root, libraries: ["main", "library"], excludeTags: ["private"], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"), host: "127.0.0.1", port: 0,
  };
  db = openDatabase(config.dbPath);
  data = openDataStore(config.dataDbPath);
  c = { db, data, booksRoot: root };
});

afterEach(() => {
  db.close();
  data.close();
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
    expect(first).toMatchObject({ scanned: 6, extracted: 5, noFile: 1, failed: 0, excluded: 1 });
    expect(db.prepare("SELECT COUNT(*) FROM books WHERE id = 'main:4'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT format FROM books WHERE id = 'main:1'").pluck().get()).toBe("pdf");
    expect(db.prepare("SELECT COUNT(*) FROM books WHERE library = 'private'").pluck().get()).toBe(0);
    expect(scanLibraries(config, db)).toMatchObject({ extracted: 0, unchanged: 5 });
  });

  it("re-extracts a changed file and removes deleted books", () => {
    scanLibraries(config, db);
    const echoes = path.join(root, "main", "Cy Writer", "Echoes (2)", "Echoes - Cy Writer.epub");
    fs.writeFileSync(echoes, makeEpub("Echoes", [{ title: "Gamma", paragraphs: ["Entirely new text about polarization."] }]));
    fs.rmSync(path.join(root, "library"), { recursive: true });
    makeLibrary(root, "library", []);
    const second = scanLibraries(config, db);
    expect(second).toMatchObject({ extracted: 1, removed: 1 });
    expect(searchCorpus(c, { query: "polarization" }).results[0].book_id).toBe("main:2");
    expect(searchCorpus(c, { query: "amplifies", book_id: "main:2" }).count).toBe(0);
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
    const { results } = searchCorpus(c, { query: "weak ties" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ page: 3, page_label: "1", section: "Part One › Chapter 1" });
    expect(results[0].snippet).toContain("«Weak»");
    expect(searchCorpus(c, { query: '"echo chamber"' }).results[0]).toMatchObject({ book_id: "main:2", section: "Alpha", page_label: null });
    expect(searchCorpus(c, { query: "clusters", library: "library" }).results.every((r) => r.book_id === "library:7")).toBe(true);
  });

  it("lists books with their duplicate copies", () => {
    const { books } = listBooks(c, { query: "Networks" });
    expect(books.map((b) => b.book_id)).toEqual(["library:7", "main:1"]);
    expect(books[1].same_file_as).toEqual(["library:7"]);
    expect(listBooks(c, { include_unindexed: true, query: "Cover" }).books[0].status).toBe("no_file");
  });

  it("returns an outline with 1-based pages and printed labels", () => {
    const outline = getBookOutline(c, "main:1");
    expect(outline.outline[2]).toEqual({ level: 1, title: "Chapter 1", page: 3, page_label: "1" });
    expect(getBookOutline(c, "main:2").page_kind).toBe("location");
  });

  it("reads a section or a page range and reports where to continue", () => {
    const section = readBook(c, { book_id: "main:1", section: "Chapter 1" });
    expect(section).toContain("--- page 3 (printed 1) · Part One › Chapter 1 ---");
    expect(section).toContain("--- page 4 (printed 2)");
    expect(section).not.toContain("page 5");
    const partial = readBook(c, { book_id: "main:1", start_page: 1, end_page: 5, max_chars: 500 });
    expect(partial).toMatch(/Continue with start_page \d/);
    expect(() => readBook(c, { book_id: "main:1", start_page: 9 })).toThrow(/pages 1–5/);
    const epubText = readBook(c, { book_id: "main:2", start_page: 1 });
    expect(epubText).toContain("--- location 1 · Alpha ---");
    expect(epubText).toMatch(/reading locations, not page numbers/);
    expect(searchCorpus(c, { query: "amplifies", book_id: "main:2" }).results[0].page_kind).toBe("location");
    expect(searchCorpus(c, { query: "weak ties" }).results[0].page_kind).toBe("pdf_page");
  });

  it("cites PDFs with printed page ranges and EPUBs without pages", () => {
    const pdfCite = citePassage(c, { book_id: "main:1", page: 3, end_page: 4 });
    expect(pdfCite.citation).toEqual({ title: "Networks", author: "Ann Author and Bo Second", publisher: "Free Press", year: "1986", pages: "1-2" });
    expect(pdfCite.isbn).toBe("978-0-00-000000-2");
    expect(pdfCite.zotero_filing?.map((f) => f.source)).toEqual(["calibre-metadata", "isbn-lookup"]);
    expect(pdfCite.zotero_filing?.[1].arguments).toEqual({ isbn: "9780000000002" });
    const epubCite = citePassage(c, { book_id: "main:2", page: 1 });
    expect(epubCite.citation).toEqual({ title: "Echoes", author: "Cy Writer" });
    expect(epubCite.locator).toMatchObject({ section: "Alpha" });
    expect(epubCite.warnings.join(" ")).toMatch(/not page numbers/);
    expect(epubCite.zotero_filing).toEqual([]);
    expect(epubCite.warnings.join(" ")).toMatch(/no publication year.*cannot be filed/s);
  });

  it("renders PDF pages and refuses reflowable books", () => {
    const image = renderPage(c, { book_id: "main:1", page: 1, scale: 0.5 });
    expect(Buffer.from(image.png, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(image.width).toBe(306);
    expect(() => renderPage(c, { book_id: "main:2", page: 1 })).toThrow(/no fixed pages/);
  });

  it("reports status, including scans with no text layer", () => {
    config.libraries.push("scans");
    makeLibrary(root, "scans", [{ id: 9, title: "Scanned", authors: ["Hal Scan"], files: { pdf: makePdf({ pages: [[], [], []] }) } }]);
    scanLibraries(config, db);
    const status = corpusStatus(c);
    expect(status.last_scan).not.toBeNull();
    expect(status.failed).toEqual([]);
    expect(status.little_or_no_text.books).toEqual([{ id: "scans:9", title: "Scanned", page_count: 3 }]);
  });
});

describe("citekeys", () => {
  const shared = JSON.parse(fs.readFileSync(new URL("./citekey-cases.json", import.meta.url), "utf8")) as {
    cases: { input: Parameters<typeof proposedCitationKey>[0]; key: string }[];
  };

  it.each(shared.cases)("matches the shared Concept Clusters case $key", ({ input, key }) => {
    expect(proposedCitationKey(input)).toBe(key);
  });

  const metadata = (overrides: Partial<Parameters<typeof proposeCitekey>[0]>) => ({
    calibreId: 1, uuid: "u", title: "The Future of Power", authors: ["Joseph Nye"], authorSorts: ["Nye, Joseph"],
    publisher: "PublicAffairs", year: 2011, language: "eng", isbn: null, citekey: null, tags: [], description: null, ...overrides,
  });

  it("builds keys from Calibre metadata and names what blocks them", () => {
    expect(proposeCitekey(metadata({}))).toEqual({ key: "nye2011future", blockers: [] });
    expect(calibreCitationData(metadata({ authors: ["FAA"], authorSorts: ["FAA"] })).creators).toEqual([{ creatorType: "author", name: "FAA" }]);
    expect(proposeCitekey(metadata({ authors: ["Unknown"], authorSorts: ["Unknown"] })).blockers).toEqual(["unknown_author"]);
    expect(proposeCitekey(metadata({ authors: ["James Gough| Daniel Bryant"], authorSorts: ["James Gough, Daniel Bryant"] })).blockers)
      .toEqual(["merged_authors"]);
    expect(proposeCitekey(metadata({ year: null })).blockers).toEqual(["no_year"]);
  });

  it("writes BibTeX with sort-form persons, braced organizations, and escapes", () => {
    const bib = bookBibtex({
      citekey: "nye2011future", title: "Power & Influence_{2}", authors: ["Joseph Nye", "Apple Inc.", "Unknown"],
      authorSorts: ["Nye, Joseph", "Apple Inc.", "Unknown"], publisher: "PublicAffairs", year: 2011, isbn: "9780306406157", calibreUuid: "abc",
    });
    expect(bib).toBe([
      "@book{nye2011future,",
      "  title = {Power \\& Influence\\_\\{2\\}},",
      "  author = {Nye, Joseph and {Apple Inc.}},",
      "  publisher = {PublicAffairs},",
      "  year = {2011},",
      "  isbn = {9780306406157},",
      "  note = {Calibre UUID: abc},",
      "}",
    ].join("\n"));
  });

  it("leaves an ISBN that fails its check digit out of the entry, and normalizes a valid one", () => {
    const entry = (isbn: string) => bookBibtex({ citekey: "nye2011future", title: "T", authors: [], authorSorts: [], publisher: null, year: 2011, isbn, calibreUuid: null });
    expect(entry("9780306406158")).not.toContain("isbn");
    expect(entry("978-0-306-40615-7")).toContain("isbn = {9780306406157}");
  });

  it("migrates a schema 1 index in place, and a reader accepts a newer schema", () => {
    for (const col of ["author_sorts", "calibre_citekey", "proposed_citekey", "citekey_blockers"]) db.exec(`ALTER TABLE books DROP COLUMN ${col}`);
    db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    db.close();
    db = openDatabase(config.dbPath);
    c.db = db;
    const columns = (db.prepare("PRAGMA table_info(books)").all() as { name: string }[]).map((x) => x.name);
    expect(columns).toEqual(expect.arrayContaining(["author_sorts", "calibre_citekey", "proposed_citekey", "citekey_blockers"]));
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    expect(() => openDatabase(config.dbPath, { readonly: true }).close()).not.toThrow();
  });

  describe("in the index", () => {
    beforeEach(() => {
      scanLibraries(config, db);
    });

    it("stores proposals, blockers, and Calibre's identifier, and resolves citekeys as book ids", () => {
      const books = Object.fromEntries(listBooks(c, { limit: 200 }).books.map((b) => [b.book_id, b]));
      expect(books["main:1"]).toMatchObject({ proposed_citekey: "author1986networks", citekey: null, citekey_blockers: [] });
      expect(books["main:2"].citekey_blockers).toEqual(["no_year"]);
      expect(books["main:5"].citekey_blockers).toEqual(["merged_authors"]);
      expect(books["main:6"]).toMatchObject({ citekey: "fixed2000strength", citekey_source: "calibre" });
      expect(getBookOutline(c, "author1986networks").book_id).toBe("main:1");
      expect(getBookOutline(c, "fixed2000strength").book_id).toBe("main:6");
      expect(() => getBookOutline(c, "nobody2000none")).toThrow(/No book/);
    });

    it("offers BibTeX filing first, then the ISBN lookup, until a key is pinned", () => {
      const before = citePassage(c, { book_id: "main:1", page: 3 });
      const bibtex = (before.zotero_filing![0].arguments as { bibtex: string }).bibtex;
      expect(bibtex).toMatch(/^@book\{author1986networks,/);
      expect(bibtex).toContain("author = {Author, Ann and Second, Bo}");
      expect(bibtex).toContain("note = {Calibre UUID: uuid-1}");
      expect(bibtex).toContain("isbn = {9780000000002}");
      db.prepare("UPDATE books SET isbn = '978-0-00-000000-1' WHERE id = 'main:1'").run();
      const invalid = citePassage(c, { book_id: "main:1" });
      expect(invalid.zotero_filing?.map((f) => f.source)).toEqual(["calibre-metadata"]);
      expect((invalid.zotero_filing![0].arguments as { bibtex: string }).bibtex).not.toContain("isbn");
      expect(invalid.warnings.join(" ")).toMatch(/fails its check digit/);
      db.prepare("UPDATE books SET isbn = '978-0-00-000000-2' WHERE id = 'main:1'").run();

      expect(pinCitekey(c, { book_id: "main:1", citekey: "author1986networksa" }, "me@example.com")).toMatchObject({ status: "pinned" });
      const after = citePassage(c, { book_id: "author1986networksa", page: 3 });
      expect(after).toMatchObject({ citekey: "author1986networksa", citekey_source: "pinned" });
      expect(after).not.toHaveProperty("zotero_filing");
      expect(searchCorpus(c, { query: "weak ties" }).results[0].citekey).toBe("author1986networksa");
      expect(listBooks(c, { query: "networksa" }).books.map((b) => b.book_id)).toEqual(["main:1"]);
    });

    it("pins only well-formed, unique keys and changes a pin only on request", () => {
      expect(() => pinCitekey(c, { book_id: "main:1", citekey: "Not A Key" })).toThrow(/not a citekey/);
      pinCitekey(c, { book_id: "main:1", citekey: "author1986networks" });
      expect(pinCitekey(c, { book_id: "main:1", citekey: "author1986networks" }).status).toBe("unchanged");
      expect(() => pinCitekey(c, { book_id: "main:5", citekey: "author1986networks" })).toThrow(/already pinned to "Networks"/);
      expect(() => pinCitekey(c, { book_id: "main:1", citekey: "author1986other" })).toThrow(/replace: true/);
      const replaced = pinCitekey(c, { book_id: "main:1", citekey: "author1986other", replace: true });
      expect(replaced).toMatchObject({ status: "replaced", previous: "author1986networks" });
      expect(replaced.warnings.join(" ")).toMatch(/proposed citekey was "author1986networks"/);
      expect(pinCitekey(c, { book_id: "main:6", citekey: "fay2000strength" }).warnings.join(" ")).toMatch(/overrides this pin/);
    });

    it("reports citekey readiness", () => {
      pinCitekey(c, { book_id: "main:1", citekey: "author1986networks" });
      const { citekeys } = corpusStatus(c);
      expect(citekeys).toMatchObject({ pinned: 1, calibre_identifier: 1, ready_to_file: 0 });
      expect(citekeys.blocked).toEqual({ unknown_author: 0, merged_authors: 1, no_year: 2, malformed: 0 });
      expect(citekeys.blocked_books.map((b) => b.book_id).sort()).toEqual(["library:7", "main:2", "main:5"]);
    });
  });

  it("backs up data.db and keeps the newest copies", async () => {
    fs.mkdirSync(config.backupDir, { recursive: true });
    for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) fs.writeFileSync(path.join(config.backupDir, `data-${day}.db`), "");
    const target = await backupDataStore(data, config.backupDir, 2);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(config.backupDir).sort()).toEqual([path.basename(target), "data-2026-01-03.db"].sort());
  });
});

describe("printed ISBNs", () => {
  const page = (page_index: number, text: string) => ({ page_index, label: null, text });

  it("finds every valid labelled ISBN once, with the binding printed beside it", () => {
    const found = findPrintedIsbns([
      page(0, "Title page"),
      page(3, [
        "Copyright © 2019 by the author. Printed on acid-free paper.",
        "ISBN 978-0-306-40615-7 (hardcover) ISBN 978-1-4028-9462-6 (ebk.)",
        "Paperback ISBN: 0-8044-2957-X",
        "Library of Congress Control Number 2019123456 · Call 555-0123-4567",
        "ISBN-13 978-0-306-40615-7 repeated",
      ].join("\n")),
    ]);
    expect(found.map((f) => [f.isbn, f.format, f.page])).toEqual([
      ["9780306406157", "hardcover", 4],
      ["9781402894626", "ebook", 4],
      ["080442957X", "paperback", 4],
    ]);
    expect(found[0].context).toContain("978-0-306-40615-7 (hardcover)");
  });

  it("reads a label printed before its ISBN, as on a list of editions", () => {
    const found = findPrintedIsbns([page(10, "Hardcover print edition ISBN 978-1-57675-334-7 Paperback print edition ISBN 978-1-57675-584-6 "
      + "PDF e-book ISBN 978-1-57675-606-8 Amazon Kindle e-book ISBN 978-1-57675-957-8")]);
    // 606-8 is printed with a wrong check digit, so it is left out.
    expect(found.map((f) => [f.isbn, f.format])).toEqual([
      ["9781576753347", "hardcover"], ["9781576755846", "paperback"], ["9781576759578", "ebook"],
    ]);
  });

  it("marks ISBNs in the last pages, which are often adverts for other books", () => {
    const found = findPrintedIsbns([page(2, "ISBN 978-0-306-40615-7"), page(158, "Also available: ISBN 978-1-4028-9462-6")], 160);
    expect(found.map((f) => f.position)).toEqual(["front", "back"]);
  });

  it("separates an ISBN from a number printed right after it", () => {
    expect(findPrintedIsbns([page(1, "ISBN 0-306-40615-2 2019")]).map((f) => f.isbn)).toEqual(["0306406152"]);
    expect(findPrintedIsbns([page(1, "ISBN-13 978-0-306-40615-7")]).map((f) => f.isbn)).toEqual(["9780306406157"]);
  });

  it("ignores unlabelled 10-digit runs that happen to pass the checksum", () => {
    expect(findPrintedIsbns([page(1, "Order number 0306406152 today")])).toEqual([]);
  });

  it("offers printed ISBNs as candidates when Calibre has none, never as a filing", () => {
    config.libraries.push("extra");
    makeLibrary(root, "extra", [{ id: 8, title: "Printed", authors: ["Gil Print"], pubdate: "2019-01-01 00:00:00+00:00",
      files: { pdf: makePdf({ pages: [["Printed"], ["ISBN 978-0-306-40615-7 (paperback)", "eISBN 978-1-4028-9462-6"], ["Body text"]] }) } }]);
    scanLibraries(config, db);
    const cite = citePassage(c, { book_id: "extra:8" });
    expect(cite.isbn_candidates?.map((x) => [x.isbn, x.format])).toEqual([["9780306406157", "paperback"], ["9781402894626", null]]);
    expect(cite.zotero_filing?.map((f) => f.source)).toEqual(["calibre-metadata"]);
    expect(corpusStatus(c).printed_isbns.books.map((b) => b.book_id)).toContain("extra:8");
  });
});
