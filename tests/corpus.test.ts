import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCatalogue } from "../src/calibre.js";
import { chunkPage } from "../src/chunk.js";
import type { Config } from "../src/config.js";
import { bookBibtex } from "../src/bibtex.js";
import { type CslItem, type PresetName, proposeCitekey as ruleKey, citekeyWellFormed } from "@jmajerus/citekey";
import { calibreCsl, proposeCitekey } from "../src/citekey.js";
import { type Change, type DataStore, backupDataStore, notYetLogged, openDataStore, pinnedByUuid, queryChanges, recordChanges } from "../src/data.js";
import { type DB, SCHEMA_VERSION, openDatabase } from "../src/db.js";
import { extractBook, sectionPaths } from "../src/extract.js";
import { findPrintedIsbns } from "../src/isbn.js";
import { findPrintedYears, printedYear } from "../src/years.js";
import { adminBooks, adminCategories } from "../src/adminQueries.js";
import { citeQuote, deleteQuote, locate, normalizeQuote, quotesOnPages, reanchorQuotes, reflow, saveQuote, searchQuotes, updateQuote } from "../src/quotes.js";
import { listProposals, normalizeProposalTags, proposeTags, reviewProposal, setBookCategories, tagPlan, taggingWorklist, vocabularyReport } from "../src/tagging.js";
import { type ZoteroConfig, linkZotero, syncZotero, zoteroCiteInfo, zoteroMatch, zoteroReport } from "../src/zotero.js";
import { Vocabulary, type VocabularyFile, VocabularySource, vocabularyProblems } from "../src/vocabulary.js";
import { scanLibraries } from "../src/indexer.js";
import {
  type Corpus, ToolError, authorState, citePassage, corpusStatus, getBook, getBookOutline, titlePageScan, listBooks, listShelves, listTags, pinCitekey, readBook, renderPage, searchCorpus,
  tagCleanupPlan, toFtsQuery, validIsbn,
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

/** A small vocabulary: grouping terms, a comma in a label, and a top-level term. */
const vocabularyFile = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "vocabulary.json"), "utf8")) as VocabularyFile;

function build(): void {
  makeLibrary(root, "main", [
    { id: 1, title: "Networks", authors: ["Ann Author", "Bo Second"], publisher: "Free Press", pubdate: "1986-05-01 00:00:00+00:00", isbn: "978-0-00-000000-2", tags: ["sociology"], files: { pdf, mobi: Buffer.from("ignored") } },
    { id: 2, title: "Echoes", authors: ["Cy Writer"], tags: ["Social Science.Media Studies", "MEAP V08"], files: { epub } },
    { id: 3, title: "Cover Only", authors: ["Nobody"] },
    { id: 4, title: "Diary", authors: ["Me"], tags: ["Private"], files: { epub } },
    { id: 5, title: "Weak Ties Revisited", authors: ["Dee One| Eve Two"], sorts: ["Dee One, Eve Two"], pubdate: "2001-01-01 00:00:00+00:00", tags: ["social-sciences.psychology.social-psychology"], files: { epub } },
    { id: 6, title: "Strength in Numbers", authors: ["Fay Fixed"], pubdate: "2000-01-01 00:00:00+00:00", citekey: "Fixed2000Strength", tags: ["Social Science.Sociology"], files: { epub } },
  ]);
  makeLibrary(root, "library", [{ id: 7, title: "Networks", authors: ["Ann Author", "Bo Second"], files: { pdf } }]);
  makeLibrary(root, "private", [{ id: 1, title: "Secret", authors: ["Me"], files: { epub } }]);
}

beforeEach(() => {
  root = tempDir();
  build();
  config = {
    booksRoot: root, libraries: ["main", "library"], excludeTags: ["private"], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
    citekeyPreset: "author-year-word", vocabularyPath: path.join(root, "vocabulary.json"),
  };
  db = openDatabase(config.dbPath);
  data = openDataStore(config.dataDbPath);
  c = { db, data, booksRoot: root, vocabulary: new Vocabulary(vocabularyFile) };
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

  it("cites as a CSL item with a page locator for PDFs and none for EPUBs", () => {
    const pdfCite = citePassage(c, { book_id: "main:1", page: 3, end_page: 4 });
    expect(pdfCite.csl).toEqual({
      id: "author1986networks", "citation-key": "author1986networks", type: "book", title: "Networks",
      author: [{ family: "Author", given: "Ann" }, { family: "Second", given: "Bo" }],
      publisher: "Free Press", issued: { "date-parts": [[1986]] }, ISBN: "9780000000002",
    });
    expect(pdfCite.locator).toEqual({ label: "page", locator: "1-2" });
    expect(pdfCite.position).toEqual({ page: 3, end_page: 4, page_kind: "page", section: "Part One › Chapter 1", page_label: "1", end_page_label: "2" });
    expect(pdfCite).toMatchObject({ isbn: "9780000000002", isbn_candidates: [] });
    expect(pdfCite.bibtex).toMatch(/^@book\{author1986networks,/);
    // The legacy fields, for one release.
    expect(pdfCite.citation).toEqual({ title: "Networks", author: "Ann Author and Bo Second", publisher: "Free Press", year: "1986", pages: "1-2" });
    expect(pdfCite.zotero_filing?.map((f) => f.source)).toEqual(["calibre-metadata", "isbn-lookup"]);
    const epubCite = citePassage(c, { book_id: "main:2", page: 1 });
    expect(epubCite.csl).toEqual({ id: "calibre:uuid-2", type: "book", title: "Echoes", author: [{ family: "Writer", given: "Cy" }] });
    expect(epubCite.locator).toBeNull();
    expect(epubCite.position).toMatchObject({ page_kind: "location", section: "Alpha" });
    expect(epubCite.warnings.join(" ")).toMatch(/not page numbers/);
    expect(epubCite).toMatchObject({ bibtex: null, isbn: null });
    expect(epubCite.warnings.join(" ")).toMatch(/no publication year.*no BibTeX entry or valid ISBN/s);
    expect(JSON.stringify(citePassage(c, { book_id: "main:1" }).warnings)).not.toMatch(/zotero|file_zotero_reference/i);
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
  const shared = JSON.parse(fs.readFileSync(new URL("../packages/citekey/cases.json", import.meta.url), "utf8")) as {
    cases: { preset: PresetName; input: CslItem; key: string }[];
  };

  it.each(shared.cases)("matches the package case $key ($preset)", ({ preset, input, key }) => {
    expect(ruleKey(input, preset)).toBe(key);
    expect(citekeyWellFormed(key, input, preset)).toBe(true);
    expect(citekeyWellFormed(`${key}b`, input, preset)).toBe(true);
  });

  it("takes options over the default preset, and rejects an unknown preset", () => {
    const nye = shared.cases[0].input;
    expect(ruleKey(nye, { titleWords: 2, separator: "_" })).toBe("nye_2011_futurepower");
    expect(citekeyWellFormed("nye_2011_futurepower", nye, { titleWords: 2, separator: "_" })).toBe(true);
    expect(citekeyWellFormed("nyeFuturePower2011", nye)).toBe(false);
    expect(() => ruleKey(nye, "nope" as PresetName)).toThrow(/Unknown citekey preset/);
  });

  const metadata = (overrides: Partial<Parameters<typeof proposeCitekey>[0]>) => ({
    calibreId: 1, uuid: "u", title: "The Future of Power", authors: ["Joseph Nye"], authorSorts: ["Nye, Joseph"],
    publisher: "PublicAffairs", year: 2011, language: "eng", isbn: null, citekey: null, tags: [], description: null, ...overrides,
  });

  it("builds keys from Calibre metadata and names what blocks them", () => {
    expect(proposeCitekey(metadata({}))).toEqual({ key: "nye2011future", blockers: [] });
    expect(calibreCsl(metadata({ authors: ["FAA"], authorSorts: ["FAA"] })).author).toEqual([{ literal: "FAA" }]);
    expect(proposeCitekey(metadata({}), "bbt-default").key).toBe("nyeFuturePower2011");
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
      const bibtex = before.bibtex!;
      expect(bibtex).toMatch(/^@book\{author1986networks,/);
      expect(bibtex).toContain("author = {Author, Ann and Second, Bo}");
      expect(bibtex).toContain("note = {Calibre UUID: uuid-1}");
      expect(bibtex).toContain("isbn = {9780000000002}");
      db.prepare("UPDATE books SET isbn = '978-0-00-000000-1' WHERE id = 'main:1'").run();
      const invalid = citePassage(c, { book_id: "main:1" });
      expect(invalid).toMatchObject({ isbn: null });
      expect(invalid.csl).not.toHaveProperty("ISBN");
      expect(invalid.bibtex).not.toContain("isbn");
      expect(invalid.warnings.join(" ")).toMatch(/fails its check digit/);
      db.prepare("UPDATE books SET isbn = '978-0-00-000000-2' WHERE id = 'main:1'").run();

      expect(pinCitekey(c, { book_id: "main:1", citekey: "author1986networksa" }, "me@example.com")).toMatchObject({ status: "pinned" });
      const after = citePassage(c, { book_id: "author1986networksa", page: 3 });
      expect(after).toMatchObject({ citekey: "author1986networksa", citekey_source: "pinned" });
      expect(after).not.toHaveProperty("zotero_filing");
      expect(after.csl).toMatchObject({ id: "author1986networksa", "citation-key": "author1986networksa" });
      expect(searchCorpus(c, { query: "weak ties" }).results[0].citekey).toBe("author1986networksa");
      expect(listBooks(c, { query: "networksa" }).books.map((b) => b.book_id)).toEqual(["main:1"]);
    });

    it("pins only BibTeX-safe, unique keys and changes a pin only on request", () => {
      expect(() => pinCitekey(c, { book_id: "main:1", citekey: "Not A Key" })).toThrow(/not a BibTeX key/);
      pinCitekey(c, { book_id: "main:1", citekey: "author1986networks" });
      expect(pinCitekey(c, { book_id: "main:1", citekey: "author1986networks" }).status).toBe("unchanged");
      expect(() => pinCitekey(c, { book_id: "main:5", citekey: "author1986networks" })).toThrow(/already pinned to "Networks"/);
      expect(() => pinCitekey(c, { book_id: "main:1", citekey: "author1986other" })).toThrow(/replace: true/);
      const replaced = pinCitekey(c, { book_id: "main:1", citekey: "author1986other", replace: true });
      expect(replaced).toMatchObject({ status: "replaced", previous: "author1986networks" });
      expect(replaced.warnings.join(" ")).toMatch(/proposed citekey was "author1986networks"/);
      expect(pinCitekey(c, { book_id: "main:6", citekey: "fay2000strength" }).warnings.join(" ")).toMatch(/overrides this pin/);
      // Another project's key: kept as given, found without regard to case, with a warning.
      const bbt = pinCitekey(c, { book_id: "main:2", citekey: "writerEchoes" });
      expect(bbt).toMatchObject({ status: "pinned", citekey: "writerEchoes" });
      expect(bbt.warnings.join(" ")).toMatch(/does not follow this server's citekey rule/);
      expect(getBookOutline(c, "writerechoes").book_id).toBe("main:2");
      expect(citePassage(c, { book_id: "main:2" }).csl.id).toBe("writerEchoes");
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
    expect(cite).toMatchObject({ isbn: null, bibtex: expect.stringMatching(/^@book/) });
    expect(corpusStatus(c).printed_isbns.books.map((b) => b.book_id)).toContain("extra:8");
  });
});

describe("printed years", () => {
  const page = (page_index: number, text: string) => ({ page_index, label: null, text });
  const years = (text: string) => findPrintedYears([page(3, text)]).map((y) => [y.year, y.kind]);
  const cited = (text: string, pages?: number) => printedYear(findPrintedYears([page(3, text)], pages))?.year ?? null;

  it("reads the copyright lines publishers print", () => {
    // From books in the library that Calibre has no year for.
    expect(cited("Copyright 2016 by Kelly Oliver\n\nAll rights reserved.")).toBe(2016);
    expect(cited("© 2025 John Majerus All rights reserved.")).toBe(2025);
    expect(cited("ISBN 978-1-4842-7204-6 e-ISBN 978-1-4842-7205-3 https://doi.org/10.1007/978-1-4842-7205-3\n\n© Kit Eason 2022")).toBe(2022);
    expect(cited("Copyright © 2020, The Pragmatic Bookshelf.")).toBe(2020);
    expect(cited("MEAP Edition\n\nCopyright 2024 Manning Publications")).toBe(2024);
  });

  it("gives the year of the edition in hand", () => {
    expect(cited("Copyright © 1949 George Orwell\nIntroduction copyright © 2003 by Thomas Pynchon")).toBe(2003);
    expect(cited("First published 1998\nThis edition published 2005\nReprinted 2011, 2015")).toBe(2005);
    expect(cited("First published in 1962 by Harper & Row")).toBe(1962);
    expect(cited("Copyright © 1999, 2004, 2010 by the author")).toBe(2010);
    expect(years("First published 1998\nReprinted 2011, 2015")).toEqual([[1998, "first_published"], [2011, "reprint"], [2015, "reprint"]]);
  });

  it("ignores numbers that aren't publication years", () => {
    expect(years("ISBN 978-1-2019-5555-1\nDOI 10.1007/2016.1234\nCall 1-800-555-2019")).toEqual([]);
    // A year with no marker before it is a date in the text.
    expect(years("In 1984 the company moved to Ohio.")).toEqual([]);
    expect(years(`Copyright © ${new Date().getFullYear() + 5} in the future`)).toEqual([]);
  });

  it("reads the edition marker that encloses a first-published one", () => {
    expect(cited("Copyright © 1984\nThis edition first published 2005")).toBe(2005);
    expect(years("This edition first published 2005")).toEqual([[2005, "edition"]]);
  });

  it("reads both ends of a copyright range", () => {
    expect(cited("Copyright © 2016-2022 by the author")).toBe(2022);
    expect(cited("© 2016-22 by the author")).toBe(2022);
    expect(cited("Copyright © 2016–2022 by the author")).toBe(2022);
  });

  it("never reads a year inside an ISBN printed with spaces", () => {
    expect(cited("Copyright © 2016 by the author. ISBN 978 1 2019 5555 9")).toBe(2016);
  });

  it("reads only the copyright page and what comes before it, not the chapters after", () => {
    const found = findPrintedYears([page(1, "First published 1998"), page(2, "Copyright © 2000 by the author"), page(10, "// Copyright 2006 Example Corp.")], 300);
    expect(found.map((y) => y.year)).toEqual([1998, 2000, 2006]);
    expect(printedYear(found)?.year).toBe(2000);
  });

  it("prefers the front matter to the last pages", () => {
    const found = findPrintedYears([page(2, "Copyright © 2012"), page(198, "© 2019 Other Press: more books")], 200);
    expect(printedYear(found)?.year).toBe(2012);
    expect(printedYear(findPrintedYears([page(198, "© 2019 the author")], 200))?.year).toBe(2019);
  });

  it("cites and proposes a citekey with the printed year when Calibre has none", () => {
    config.libraries.push("years");
    makeLibrary(root, "years", [{ id: 1, title: "Carceral Humanitarianism", authors: ["Kelly Oliver"],
      files: { pdf: makePdf({ pages: [["Carceral Humanitarianism"], ["Copyright 2016 by Kelly Oliver", "All rights reserved."], ["Body text"]] }) } }]);
    scanLibraries(config, db);
    const book = getBook(c, "years:1");
    expect(book).toMatchObject({ year: null, printed_year: 2016 });
    expect(JSON.parse(book.citekey_blockers)).toEqual([]);
    expect(book.proposed_citekey).toMatch(/2016/);
    const cite = citePassage(c, { book_id: "years:1" });
    expect(cite).toMatchObject({ year_source: "printed", year_evidence: { page: 2 }, csl: { issued: { "date-parts": [[2016]] } } });
    expect(cite.bibtex).toMatch(/year\s*=\s*\{?2016/);
    expect(cite.warnings.join(" ")).toMatch(/Calibre has no publication year; 2016 is from the book's own text/);
    const status = corpusStatus(c);
    expect(status.printed_years.books.map((b) => [b.book_id, b.year])).toContainEqual(["years:1", 2016]);
    expect(status.citekeys.ready_with_printed_year).toBeGreaterThanOrEqual(1);
    // A rescan rewrites the proposal from Calibre's metadata, then from the printed year again.
    scanLibraries(config, db);
    expect(getBook(c, "years:1").proposed_citekey).toMatch(/2016/);
    // The admin book list filters and counts by where the year comes from.
    const list = adminBooks(c, { year: "printed" });
    expect(list.rows.map((r) => r.book_id)).toContain("years:1");
    expect(list.rows.every((r) => r.year_state === "printed")).toBe(true);
    expect(list.facets.year.printed).toBeGreaterThanOrEqual(1);
  });
});

describe("title pages", () => {
  it("offers the authors and title a book prints when Calibre has none, as candidates only", () => {
    config.libraries.push("packt");
    makeLibrary(root, "packt", [{ id: 1, title: "awscloudprojects", authors: ["Unknown"], pubdate: "2024-01-01 00:00:00+00:00",
      files: { pdf: makePdf({ pages: [
        [""],
        ["AWS Cloud Projects", "Strengthen your AWS skills through practical projects", "Ivo Pinto", "Pedro Santos"],
        ["Copyright © 2024 Packt Publishing", "Technical Editor: Rajat Sharma"],
        ["Contributors", "About the authors", "Ivo Pinto, CISSP, is a principal solutions architect.", "Pedro Santos is a senior solutions architect.", "About the reviewers", "Jane Reviewer is a cloud engineer."],
        ["Chapter 1"],
      ] }) } }]);
    scanLibraries(config, db);
    const book = getBook(c, "packt:1");
    expect(authorState(book)).toBe("printed");
    expect(titlePageScan(book)).toMatchObject({ authors: [{ name: "Ivo Pinto" }, { name: "Pedro Santos" }], title: { title: "AWS Cloud Projects" } });
    const report = corpusStatus(c).title_pages;
    expect(report.books.find((b) => b.book_id === "packt:1")).toMatchObject({ authors: [{ name: "Ivo Pinto" }, { name: "Pedro Santos" }], printed_title: "AWS Cloud Projects" });
    expect(report.unknown_author_found).toBeGreaterThanOrEqual(1);
    expect(adminBooks(c, { author: "printed" }).rows.map((r) => r.book_id)).toContain("packt:1");
    // Never in a citation: the citekey stays blocked by the missing author.
    expect(JSON.parse(book.citekey_blockers)).toContain("unknown_author");
    expect(citePassage(c, { book_id: "packt:1" }).csl.author).toBeUndefined();
  });
});

describe("shelves", () => {
  const writeExport = (shelves: { id: number; name: string; books: number[] }[]) =>
    fs.writeFileSync(config.shelvesFile, JSON.stringify({
      exported_at: "2026-10-25T00:00:00Z",
      shelves: shelves.map((x) => ({ id: x.id, name: x.name, books: x.books.map((book_id, order) => ({ book_id, order })) })),
    }));

  beforeEach(() => {
    writeExport([{ id: 1, name: "Misinformation", books: [2, 1] }, { id: 5, name: "Main", books: [1, 99] }]);
  });

  it("loads Calibre-Web's shelves into a table joined to books", () => {
    expect(scanLibraries(config, db).shelves).toBe(2);
    expect(listShelves(c)).toEqual({
      exported_at: "2026-10-25T00:00:00Z",
      shelves: [{ name: "Main", books: 2, indexed_books: 1 }, { name: "Misinformation", books: 2, indexed_books: 2 }],
    });
    expect(listBooks(c, { query: "Networks" }).books.find((b) => b.book_id === "main:1")?.shelves).toEqual(["Main", "Misinformation"]);
    expect(getBookOutline(c, "main:2").shelves).toEqual(["Misinformation"]);
  });

  it("filters search and listings by shelf name", () => {
    scanLibraries(config, db);
    // Listed by title: Echoes (main:2), then Networks (main:1).
    expect(listBooks(c, { shelf: "misinformation" }).books.map((b) => b.book_id)).toEqual(["main:2", "main:1"]);
    const hits = searchCorpus(c, { query: "clusters", shelf: "Main" }).results;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((r) => r.book_id === "main:1")).toBe(true);
    expect(() => searchCorpus(c, { query: "clusters", shelf: "Nope" })).toThrow(/No shelf "Nope". Shelves: Main, Misinformation/);
  });

  it("keeps the previous shelves when the export is missing or malformed", () => {
    scanLibraries(config, db);
    fs.writeFileSync(config.shelvesFile, "{ not json");
    expect(scanLibraries(config, db).shelves).toMatch(/^unreadable export/);
    fs.rmSync(config.shelvesFile);
    expect(scanLibraries(config, db).shelves).toBe("no export");
    expect(listShelves(c).shelves).toHaveLength(2);
    writeExport([{ id: 1, name: "Misinformation", books: [2] }]);
    scanLibraries(config, db);
    expect(listBooks(c, { query: "Networks" }).books.find((b) => b.book_id === "main:1")?.shelves).toEqual([]);
  });

  it("exports only public shelves from app.db and allows nothing but rsync and the export", () => {
    const appDb = path.join(root, "app.db");
    const app = new Database(appDb);
    app.exec(`
      CREATE TABLE shelf (id INTEGER PRIMARY KEY, name TEXT, is_public INTEGER);
      CREATE TABLE book_shelf_link (id INTEGER PRIMARY KEY, book_id INTEGER, "order" INTEGER, shelf INTEGER);
      INSERT INTO shelf VALUES (1, 'Misinformation', 1), (2, 'Diary', 0);
      INSERT INTO book_shelf_link (book_id, "order", shelf) VALUES (53, 1, 1), (7, 2, 1), (99, 1, 2);`);
    app.close();
    const script = fs.readFileSync(new URL("../deploy/corpus-source.sh", import.meta.url), "utf8").replace(/^APP_DB=.*$/m, `APP_DB="${appDb}"`);
    const run = (command: string) => spawnSync("sh", ["-c", script], { env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, encoding: "utf8" });
    const exported = JSON.parse(run("shelves").stdout);
    expect(exported.shelves).toEqual([{ id: 1, name: "Misinformation", books: [{ book_id: 53, order: 1 }, { book_id: 7, order: 2 }] }]);
    const refused = run("cat /etc/passwd");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/only read-only rsync, 'shelves', and the tags-\/convert- commands are allowed/);
    expect(run("tags-apply; id").status).toBe(1);
  });

  it("runs the admin's named Calibre commands through their scripts, with the plan on stdin", () => {
    const tools = path.join(root, "tools");
    fs.mkdirSync(tools);
    // Stand-ins that report how they were called.
    fs.writeFileSync(path.join(tools, "calibre-tags.sh"), 'echo "tags $* plan=$(printf %s "$TAG_PLAN" | base64 -d)"\n');
    fs.writeFileSync(path.join(tools, "calibre-convert.sh"), 'echo "convert $*"\n');
    const script = fs.readFileSync(new URL("../deploy/corpus-source.sh", import.meta.url), "utf8")
      .replace(/^TOOLS_DIR=.*$/m, `TOOLS_DIR="${tools}"`).replace(/^LIBRARY=.*$/m, 'LIBRARY="/lib/main"');
    const run = (command: string, input = "") =>
      spawnSync("sh", ["-c", script], { env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, input, encoding: "utf8" }).stdout.trim();
    expect(run("tags-preview", '{"books":[]}')).toBe('tags /lib/main plan={"books":[]}');
    expect(run("tags-apply", '{"books":[1]}')).toBe('tags --apply /lib/main plan={"books":[1]}');
    expect(run("convert-preview")).toBe("convert /lib/main");
    expect(run("convert-apply")).toBe("convert --apply /lib/main");
  });
});

describe("tags", () => {
  beforeEach(() => {
    scanLibraries(config, db);
  });

  it("lists tags as a tree, counting books at or below each tag", () => {
    const { tags } = listTags(c);
    const social = tags.find((t) => t.name === "Social Science")!;
    expect(social).toMatchObject({ tag: "Social Science", books: 2 });
    expect(social.children.map((t) => [t.tag, t.books])).toEqual([["Social Science.Media Studies", 1], ["Social Science.Sociology", 1]]);
    expect(listTags(c, { under: "social science.sociology" }).tags.map((t) => t.tag)).toEqual(["Social Science.Sociology"]);
    expect(listTags(c, { min_books: 2 }).tags.map((t) => t.name)).toEqual(["Social Science"]);
    const vocab = listTags(c, { under: "Social Sciences" }).tags[0];
    expect(vocab).toMatchObject({ tag: "social-sciences", label: "Social Sciences", books: 1 });
    expect(vocab.children[0]).toMatchObject({ tag: "social-sciences.psychology", label: "Social Sciences › Psychology" });
    expect(() => listTags(c, { under: "Nope" })).toThrow(/No tag "Nope"/);
  });

  it("filters by a tag and everything below it, case-insensitively", () => {
    expect(listBooks(c, { tag: "social science" }).books.map((b) => b.book_id)).toEqual(["main:2", "main:6"]);
    expect(listBooks(c, { tag: "Social Science.Sociology" }).books.map((b) => b.book_id)).toEqual(["main:6"]);
    // A tag can start at any level, so the domain need not be named.
    // main:1 carries a plain "sociology" tag, main:6 "Social Science.Sociology".
    expect(listBooks(c, { tag: "sociology" }).books.map((b) => b.book_id)).toEqual(["main:1", "main:6"]);
    expect(listBooks(c, { tag: "Media Studies" }).books.map((b) => b.book_id)).toEqual(["main:2"]);
    // Vocabulary titles are translated to slugs, at any level.
    expect(listBooks(c, { tag: "Psychology" }).books.map((b) => b.book_id)).toEqual(["main:5"]);
    expect(listBooks(c, { tag: "Social Sciences › Psychology › Social Psychology" }).books.map((b) => b.book_id)).toEqual(["main:5"]);
    expect(listBooks(c, { tag: "social-sciences" }).books.map((b) => b.book_id)).toEqual(["main:5"]);
    expect(searchCorpus(c, { query: "amplifies", tag: "Social Science.Media Studies" }).results.every((r) => r.book_id === "main:2")).toBe(true);
    expect(() => listBooks(c, { tag: "Social" })).toThrow(/No book is tagged "Social". Similar tags: Social Science.Media Studies, Social Science.Sociology/);
    expect(listBooks(c, { query: "Echoes" }).books[0].tags).toEqual(["MEAP V08", "Social Science.Media Studies"]);
  });

  it("flags tags that are not subjects", () => {
    const { tags } = corpusStatus(c);
    expect(tags).toMatchObject({ distinct: 5, hierarchical: 3 });
    expect(tags.suspect).toEqual([{ tag: "MEAP V08", books: 1, reason: "status or format, not a subject" }]);
  });
});

describe("tag vocabulary and proposals", () => {
  it("builds tags from term ids with title-path labels, and finds tags by id or title", () => {
    expect(c.vocabulary.tags.map((t) => t.tag)).toEqual([
      "interdisciplinary-studies.science-technology-society",
      "interdisciplinary-studies.science-technology-society.technology-work-control",
      "social-sciences.psychology",
      "social-sciences.psychology.social-psychology",
      "social-sciences.sociology",
      "social-sciences.sociology.social-change",
      "trivia",
    ]);
    const v = c.vocabulary;
    expect(v.find("Social-Sciences.Sociology.Social-Change")).toEqual({
      tag: "social-sciences.sociology.social-change", label: "Social Sciences › Sociology › Social Change",
      name: "Social Change", parent: "social-sciences.sociology", assignable: true,
    });
    // Grouping terms label paths but are not tags.
    expect(v.find("social-sciences")).toBeUndefined();
    expect(v.has("social-sciences")).toBe(false);
    // Titles with their commas, without them (the earlier tag form), and with " › " all resolve.
    for (const title of ["Interdisciplinary Studies › Science, Technology & Society › Technology, Work & Control",
      "Interdisciplinary Studies.Science Technology & Society.Technology Work & Control"]) {
      expect(v.find(title)?.tag).toBe("interdisciplinary-studies.science-technology-society.technology-work-control");
    }
    expect(v.toSlugPath("Science, Technology & Society")).toBe("science-technology-society");
    expect(v.toSlugPath("misinformation")).toBe("misinformation");
    expect(v.labelFor("interdisciplinary-studies")).toBe("Interdisciplinary Studies");
  });

  it("rewrites stored proposal tags into slug form, once", () => {
    data.prepare(`INSERT INTO tag_proposals (calibre_uuid, book_id, title, tags, rationale, status, approved_tags, proposed_at)
      VALUES ('u', 'main:1', 'Networks', ?, 'r', 'approved', ?, '2026-10-25')`)
      .run(JSON.stringify(["Social Sciences.Sociology", "social-sciences.sociology", "Gone.Tag"]), JSON.stringify(["Trivia"]));
    expect(normalizeProposalTags(c)).toBe(1);
    expect(data.prepare("SELECT tags, approved_tags FROM tag_proposals").get()).toEqual({
      tags: JSON.stringify(["social-sciences.sociology", "Gone.Tag"]), approved_tags: JSON.stringify(["trivia"]),
    });
    expect(normalizeProposalTags(c)).toBe(0);
  });

  describe("in the index", () => {
    beforeEach(() => {
      scanLibraries(config, db);
    });

    it("offers untagged books with context, and drops them once proposed", () => {
      const first = taggingWorklist(c, { limit: 2 });
      expect(first.books.map((b) => b.book_id)).toEqual(["library:7", "main:1"]);
      expect(first.books[1]).toMatchObject({ title: "Networks", chapters: ["Preface", "Part One"], tags: ["sociology"] });
      // main:5 already carries a vocabulary tag, so it is left out by default.
      expect(taggingWorklist(c, { limit: 25 }).books.map((b) => b.book_id)).not.toContain("main:5");
      expect(taggingWorklist(c, { limit: 25, include_tagged: true }).books.map((b) => b.book_id)).toContain("main:5");
      proposeTags(c, { book_id: "main:1", tags: ["social sciences.sociology"], rationale: "About social networks." });
      expect(taggingWorklist(c, { limit: 25 }).books.map((b) => b.book_id)).not.toContain("main:1");
    });

    it("accepts only vocabulary tags, canonicalized, and never overwrites a reviewed proposal", () => {
      expect(() => proposeTags(c, { book_id: "main:1", tags: ["Networks"], rationale: "x" })).toThrow(/Not in the vocabulary: "Networks"/);
      expect(proposeTags(c, { book_id: "main:1", tags: ["social sciences.sociology", "Social Sciences.Sociology"], rationale: "x" }))
        .toMatchObject({ status: "proposed", tags: ["social-sciences.sociology"] });
      expect(proposeTags(c, { book_id: "main:1", tags: ["Social Sciences.Sociology.Social Change"], rationale: "y" }).status).toBe("replaced");
      const uuid = "uuid-1";
      reviewProposal(c, uuid, { action: "reject" });
      expect(() => proposeTags(c, { book_id: "main:1", tags: ["Trivia"], rationale: "z" })).toThrow(/already has a rejected proposal/);
    });

    it("approves with edits, then plans only the tags Calibre lacks", () => {
      proposeTags(c, { book_id: "main:1", tags: ["Social Sciences.Sociology"], rationale: "About social networks." });
      const pending = listProposals(c).proposals[0];
      expect(pending).toMatchObject({ book_id: "main:1", status: "pending", calibre_tags: ["sociology"], in_calibre: false });
      expect(() => reviewProposal(c, "uuid-1", { action: "approve", tags: ["Made Up"] })).toThrow(/Not in the vocabulary/);
      reviewProposal(c, "uuid-1", { action: "approve", tags: ["social-sciences.sociology", "Social Sciences › Psychology › Social Psychology"] }, "me@example.com");
      expect(listProposals(c, { status: "approved" }).proposals[0]).toMatchObject({
        approved_tags: ["social-sciences.sociology", "social-sciences.psychology.social-psychology"], reviewed_by: "me@example.com",
      });
      expect(tagPlan(c, "main").books).toEqual([{
        calibre_id: 1, uuid: "uuid-1", title: "Networks", add: ["social-sciences.sociology", "social-sciences.psychology.social-psychology"],
      }]);
      expect(reviewProposal(c, "uuid-1", { action: "reopen" }).status).toBe("pending");
      expect(tagPlan(c, "main").books).toEqual([]);
    });

    it("replaces a retired term with its single replacement, and leaves splits for review", () => {
      c.vocabulary = new Vocabulary({ ...vocabularyFile, retired: [
        { id: "social-sciences.psychology.old-social", replacedBy: ["social-sciences.psychology.social-psychology"] },
        { id: "social-sciences.split-me", replacedBy: ["social-sciences.sociology", "social-sciences.psychology"] },
      ] });
      const setTags = db.prepare("UPDATE books SET tags = ? WHERE id = ?");
      setTags.run(JSON.stringify(["social-sciences.psychology.old-social", "MEAP V08"]), "main:2");
      setTags.run(JSON.stringify(["social-sciences.split-me", "social-sciences.media-studies"]), "main:6");
      setTags.run(JSON.stringify(["social-sciences.psychology"]), "library:7");
      expect(c.vocabulary.find("social-sciences.psychology.old-social")?.tag).toBe("social-sciences.psychology.social-psychology");
      expect(c.vocabulary.find("social-sciences.split-me")).toBeUndefined();
      // Automatic: free tags stay, the retired term is swapped.
      expect(tagPlan(c, "main").books).toEqual([{
        calibre_id: 2, uuid: "uuid-2", title: "Echoes", add: ["social-sciences.psychology.social-psychology"], remove: ["social-sciences.psychology.old-social"],
      }]);
      // An approved set still naming the retired term is rewritten, and its plan removes the old tag too.
      data.prepare(`INSERT INTO tag_proposals (calibre_uuid, book_id, title, tags, rationale, status, approved_tags, proposed_at)
        VALUES ('uuid-2', 'main:2', 'Echoes', ?, 'r', 'approved', ?, '2026-10-25')`).run(JSON.stringify(["social-sciences.psychology.old-social"]), JSON.stringify(["social-sciences.psychology.old-social", "trivia"]));
      expect(normalizeProposalTags(c)).toBe(1);
      expect(tagPlan(c, "main").books).toEqual([{
        calibre_id: 2, uuid: "uuid-2", title: "Echoes", add: ["social-sciences.psychology.social-psychology", "trivia"], remove: ["social-sciences.psychology.old-social"],
      }]);

      const report = vocabularyReport(c);
      expect(report.vocabulary).toMatchObject({ version: "test-1", assignable: 7, terms: 9 });
      expect(report.retired_in_use.map((r) => [r.tag, r.action, r.books.map((b) => b.book_id)])).toEqual([
        ["social-sciences.psychology.old-social", "automatic", ["main:2"]],
        ["social-sciences.split-me", "review", ["main:6"]],
      ]);
      expect(report.unknown_terms.map((u) => u.tag)).toEqual(["social-sciences.media-studies"]);
      expect(report.tagged_only_broadly).toEqual([{ tag: "social-sciences.psychology", label: "Social Sciences › Psychology", narrower: 1, books: [{ book_id: "library:7", title: "Networks" }] }]);
    });

    it("plans nothing without a vocabulary", () => {
      c.vocabulary = Vocabulary.empty();
      expect(() => tagPlan(c, "main")).toThrow(/No vocabulary/);
    });
  });

  it("rejects an invalid vocabulary with every problem named", () => {
    expect(vocabularyProblems({ format: "other", terms: [
      { id: "a", label: "A" }, { id: "a", label: "Again" }, { id: "a.B_c", label: "Bad", parent: "a" }, { id: "x.y", label: "Orphan", parent: "x" },
      { id: "a.dot", label: "Dr. Who", parent: "a" }, { id: "a.wrong", label: "Wrong", parent: "b" },
    ], retired: [{ id: "a", replacedBy: ["nowhere"] }] })).toEqual([
      'format is "other", expected "corpus-vocabulary/1"',
      'duplicate id "a"',
      '"a.B_c": the last segment must be lowercase letters, digits, and single hyphens',
      '"x.y": parent "x" is not a term',
      '"a.dot": the label "Dr. Who" contains "." or "›"',
      '"a.wrong": parent is "b", but the id says "a"',
      'retired "a" is still a term',
      'retired "a": replacement "nowhere" is not a term',
    ]);
  });

  it("reloads the vocabulary file when it changes, keeping the last good one", () => {
    const file = path.join(root, "vocabulary.json");
    const seen: number[] = [];
    const source = new VocabularySource(file, (v) => seen.push(v.tags.length), 0);
    expect(source.current().tags).toEqual([]);
    expect(source.error).toMatch(/No vocabulary file/);
    fs.writeFileSync(file, JSON.stringify(vocabularyFile));
    expect(source.current().tags).toHaveLength(7);
    expect(source.error).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...vocabularyFile, terms: [...vocabularyFile.terms, { id: "nope.x", label: "X", parent: "nope" }] }));
    expect(source.current().tags).toHaveLength(7);
    expect(source.error).toMatch(/parent "nope" is not a term/);
    expect(seen).toEqual([0, 7]);
  });

  it("lists the merged tags calibre-tags.sh would write, and skips a book whose id moved", () => {
    const plan = { books: [
      { calibre_id: 1, uuid: "uuid-1", title: "Networks", add: ["social-sciences.sociology"] },
      { calibre_id: 2, uuid: "someone-else", title: "Echoes", add: ["trivia"] },
    ] };
    const result = spawnSync("bash", [new URL("../tools/calibre-tags.sh", import.meta.url).pathname, path.join(root, "main")], {
      env: { ...process.env, TAG_PLAN: Buffer.from(JSON.stringify(plan)).toString("base64") }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 book(s)");
    expect(result.stdout).toMatch(/1\s+Networks\n\s+\+ social-sciences\.sociology/);
    // The structured line /admin turns into its change table.
    const item = JSON.parse(result.stdout.split("\n").find((l) => l.startsWith("@@change "))!.slice("@@change ".length));
    expect(item).toEqual({ calibre_id: 1, uuid: "uuid-1", title: "Networks", added: ["social-sciences.sociology"], removed: [] });
    expect(result.stderr).toMatch(/skip 2 Echoes: that Calibre id no longer belongs to this book/);
  });
});

describe("tag cleanup", () => {
  beforeEach(() => {
    scanLibraries(config, db);
  });

  it("plans removal of suspect tags and named extras, never vocabulary tags", () => {
    expect(tagCleanupPlan(c, "main").books).toEqual([{ calibre_id: 2, uuid: "uuid-2", title: "Echoes", remove: ["MEAP V08"] }]);
    expect(tagCleanupPlan(c, "main", ["sociology"]).books.map((b) => [b.calibre_id, b.remove])).toEqual([
      [1, ["sociology"]], [2, ["MEAP V08"]],
    ]);
  });

  it("keeps one-word subjects that only appear inside a publisher name, and subject headings", () => {
    config.libraries.push("maps");
    makeLibrary(root, "maps", [{
      id: 3, title: "Boating Guide", authors: ["Dee Enar"], publisher: "Minnesota Department of Natural Resources",
      tags: ["Minnesota", "Department of Natural Resources", "Lakes -- Minnesota -- Guidebooks and boating regulations", "Sample Book"],
      files: { epub },
    }]);
    scanLibraries(config, db);
    expect(tagCleanupPlan(c, "maps").books[0].remove).toEqual(["Department of Natural Resources", "Sample Book"]);
  });

  it("writes an empty tag list when a book loses all its tags, never the change summary", () => {
    // A stand-in calibredb that records the tags it is asked to set.
    const bin = path.join(root, "bin");
    const log = path.join(root, "calibredb.log");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "calibredb"), `#!/bin/sh\nfor a in "$@"; do case "$a" in tags:*) printf '%s\\n' "$a" >> "${log}";; esac; done\n`, { mode: 0o755 });
    const plan = { books: [
      { calibre_id: 2, uuid: "uuid-2", title: "Echoes", remove: ["MEAP V08", "Social Science.Media Studies"] },
      { calibre_id: 1, uuid: "uuid-1", title: "Networks", add: ["trivia"] },
    ] };
    const result = spawnSync("bash", [new URL("../tools/calibre-tags.sh", import.meta.url).pathname, "--apply", path.join(root, "main")], {
      env: { ...process.env, CALIBRE_BIN: bin, TAG_PLAN: Buffer.from(JSON.stringify(plan)).toString("base64") }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["tags:", "tags:sociology,trivia"]);
  });

  it("removes tags with calibre-tags.sh, keeping the rest", () => {
    const plan = { books: [{ calibre_id: 2, uuid: "uuid-2", title: "Echoes", remove: ["meap v08"], add: ["trivia"] }] };
    const result = spawnSync("bash", [new URL("../tools/calibre-tags.sh", import.meta.url).pathname, path.join(root, "main")], {
      env: { ...process.env, TAG_PLAN: Buffer.from(JSON.stringify(plan)).toString("base64") }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/2\s+Echoes\n\s+\+ trivia \| - MEAP V08/);
  });
});

describe("change log", () => {
  /** Edits the fixture library's metadata.db the way Calibre or Calibre-Web would. */
  const calibre = (sql: string, ...params: unknown[]) => {
    const db2 = new Database(path.join(root, "main", "metadata.db"));
    db2.prepare(sql).run(...params);
    db2.close();
  };

  it("records what a scan sees change in Calibre: new books, tag edits, removed books", () => {
    const seen: Change[][] = [];
    scanLibraries(config, db, { record: (c) => seen.push(c) });
    expect(seen[0].filter((c) => c.kind === "book_added").map((c) => [c.book_id, c.detail])).toContainEqual(["main:1", "pdf"]);

    calibre("INSERT INTO tags (id, name) VALUES (900, 'new-subject')");
    calibre("INSERT INTO books_tags_link (book, tag) VALUES (1, 900)");
    calibre("DELETE FROM books_tags_link WHERE book = 1 AND tag = (SELECT id FROM tags WHERE name = 'sociology')");
    calibre("DELETE FROM books WHERE id = 6");
    scanLibraries(config, db, { record: (c) => seen.push(c) });
    expect(seen[1].map((c) => [c.kind, c.book_id, c.detail, c.source])).toEqual([
      ["tag_added", "main:1", "new-subject", "calibre"],
      ["tag_removed", "main:1", "sociology", "calibre"],
      ["book_removed", "main:6", null, "calibre"],
    ]);
    scanLibraries(config, db, { record: (c) => seen.push(c) });
    expect(seen[2]).toEqual([]);
  });

  it("logs a failing extraction once, not on every retry", () => {
    config.libraries.push("broken");
    makeLibrary(root, "broken", [{ id: 1, title: "Damaged", authors: ["Dee Mage"], files: { epub: Buffer.from("not a zip") } }]);
    const seen: Change[] = [];
    scanLibraries(config, db, { record: (c) => seen.push(...c) });
    scanLibraries(config, db, { record: (c) => seen.push(...c) });
    // A new book that fails is logged as the failure, once, though every scan retries it.
    expect(seen.filter((c) => c.book_id === "broken:1").map((c) => c.kind)).toEqual(["extraction_failed"]);
  });

  it("skips what an admin job already logged when the follow-up refresh sees it", () => {
    recordChanges(data, [
      { kind: "tag_added", source: "admin-job", job_id: 7, book_id: "main:1", detail: "trivia" },
      { kind: "format_added", source: "admin-job", job_id: 8, book_id: "main:2", detail: "mobi → epub" },
    ]);
    const kept = notYetLogged(data, [
      { kind: "tag_added", source: "calibre", book_id: "main:1", detail: "trivia" },
      { kind: "tag_added", source: "calibre", book_id: "main:1", detail: "something-else" },
      { kind: "book_reextracted", source: "calibre", book_id: "main:2", detail: "mobi → epub" },
      { kind: "book_reextracted", source: "calibre", book_id: "main:3", detail: "file changed" },
    ]);
    expect(kept.map((c) => [c.book_id, c.detail])).toEqual([["main:1", "something-else"], ["main:3", "file changed"]]);
  });

  it("filters the log, counting kinds across the other filters", () => {
    recordChanges(data, [
      { kind: "tag_added", source: "admin-job", job_id: 1, book_id: "main:1", title: "Networks", detail: "social-sciences.sociology", actor: "me@example.com", at: "2026-10-20T10:00:00Z" },
      { kind: "tag_removed", source: "admin-job", job_id: 1, book_id: "main:1", title: "Networks", detail: "MEAP V08", actor: "me@example.com", at: "2026-10-20T10:00:01Z" },
      { kind: "book_added", source: "calibre", book_id: "main:2", title: "Echoes", detail: "epub", at: "2026-10-22T09:00:00Z" },
    ]);
    const all = queryChanges(data, {});
    expect(all).toMatchObject({ total: 3, by_kind: { tag_added: 1, tag_removed: 1, book_added: 1 }, actors: ["me@example.com"] });
    expect(all.by_day).toEqual([{ day: "2026-10-20", n: 2 }, { day: "2026-10-22", n: 1 }]);
    expect(all.rows.map((r) => (r as { detail: string }).detail)).toEqual(["epub", "MEAP V08", "social-sciences.sociology"]);
    const tagsOnly = queryChanges(data, { kinds: ["tag_added"] });
    expect(tagsOnly.total).toBe(1);
    expect(tagsOnly.by_kind).toEqual({ tag_added: 1, tag_removed: 1, book_added: 1 });
    expect(queryChanges(data, { job: 1 }).total).toBe(2);
    expect(queryChanges(data, { sources: ["calibre"] }).total).toBe(1);
    expect(queryChanges(data, { tag: "sociology" }).total).toBe(1);
    expect(queryChanges(data, { q: "echo" }).total).toBe(1);
    expect(queryChanges(data, { since: "2026-10-21T00:00:00Z" }).total).toBe(1);
    expect(queryChanges(data, { actor: "ME@" }).total).toBe(2);
  });

  it("records proposals, reviews, and pins", () => {
    scanLibraries(config, db);
    proposeTags(c, { book_id: "main:1", tags: ["social-sciences.sociology"], rationale: "r" }, "agent@example.com");
    reviewProposal(c, "uuid-1", { action: "approve", tags: ["social-sciences.sociology", "trivia"] }, "me@example.com");
    pinCitekey(c, { book_id: "main:1", citekey: "author1986networks" }, "agent@example.com");
    expect(queryChanges(data, {}).rows.map((r) => { const x = r as Change; return [x.kind, x.detail, x.source, x.actor]; }).reverse()).toEqual([
      ["tag_proposed", "social-sciences.sociology", "agent", "agent@example.com"],
      ["proposal_approved", "social-sciences.sociology", "review", "me@example.com"],
      ["proposal_approved", "trivia", "review", "me@example.com"],
      ["citekey_pinned", "author1986networks", "agent", "agent@example.com"],
    ]);
  });
});

describe("category sets", () => {
  beforeEach(() => {
    scanLibraries(config, db);
  });

  it("plans additions and removals so Calibre matches an approved set, never touching other tags", () => {
    // main:5 carries social-sciences.psychology.social-psychology in Calibre.
    setBookCategories(c, { book_id: "main:5", tags: ["Trivia"] }, "me@example.com");
    expect(tagPlan(c, "main").books).toEqual([
      { calibre_id: 5, uuid: "uuid-5", title: "Weak Ties Revisited", add: ["trivia"], remove: ["social-sciences.psychology.social-psychology"] },
    ]);
    // main:2's free-form tags are not vocabulary, so an empty set changes nothing there.
    setBookCategories(c, { book_id: "main:2", tags: [] }, "me@example.com");
    expect(tagPlan(c, "main", ["main:2"]).books).toEqual([]);
    expect(tagPlan(c, "main", ["main:5"]).books).toHaveLength(1);
    expect(() => setBookCategories(c, { book_id: "main:5", tags: ["Made Up"] }, "me")).toThrow(/Not in the vocabulary/);
  });

  it("derives each book's states for the admin list", () => {
    setBookCategories(c, { book_id: "main:5", tags: ["Trivia"] }, "me@example.com");
    proposeTags(c, { book_id: "main:1", tags: ["trivia"], rationale: "r" });
    const list = adminBooks(c, {});
    const state = Object.fromEntries(list.rows.map((r) => [r.book_id, [r.category_state, r.citekey_state, r.isbn_state, r.problems]]));
    expect(state["main:1"]).toEqual(["pending", "ready", "valid", []]);
    expect(state["main:5"]).toEqual(["not_applied", "blocked", "none", []]);
    expect(state["main:6"]).toEqual(["uncategorized", "calibre", "none", []]);
    expect(list.facets.category).toMatchObject({ pending: 1, not_applied: 1 });
    expect(adminBooks(c, { citekey: "blocked" }).rows.map((r) => r.book_id).sort()).toEqual(["library:7", "main:2", "main:3", "main:5"]);
    expect(adminBooks(c, { tag: "psychology" }).rows.map((r) => r.book_id)).toEqual(["main:5"]);
    expect(adminBooks(c, { q: "fixed2000strength" }).rows.map((r) => r.book_id)).toEqual(["main:6"]);
  });

  it("counts books per vocabulary tag, including each subtree", () => {
    const cats = adminCategories(c);
    const social = cats.tree.find((n) => n.tag === "social-sciences")!;
    expect(social).toMatchObject({ total: 1, books: 0 });
    expect(social.children.find((n) => n.tag === "social-sciences.psychology")).toMatchObject({ total: 1 });
    expect(cats.free.map((t) => t.tag)).toContain("meap v08");
  });
});

describe("quotes", () => {
  beforeEach(() => {
    scanLibraries(config, db);
  });

  it("matches loosely across quote marks, dashes, spacing, case, and page breaks", () => {
    expect(normalizeQuote("  \u201CSmart\u201D \u2014 quotes\u2019  here ")).toBe('"Smart" - quotes\' here');
    const pages = [
      { page_index: 0, label: null, section_path: null, text: "First page ends with a\nbroken sentence" },
      { page_index: 1, label: null, section_path: null, text: "that continues here. Then more." },
    ];
    expect(locate(pages, "a broken  sentence that CONTINUES here")).toMatchObject({
      start_page: 0, start_offset: 21, end_page: 1, end_offset: 19, text: "a\nbroken sentence\nthat continues here",
    });
    expect(locate(pages, "not in the text")).toBeNull();
  });

  it("reflows line-per-block text as prose, keeping paragraph breaks", () => {
    // Conrad's Chance in the Delphi EPUB: every printed line is a block, and a page break is a single newline.
    expect(reflow("curiosity. Curiosity about\n\ndaily facts, the most respectable\n\nfaculty of an incurious\nmind. It would be like a chamber"))
      .toBe("curiosity. Curiosity about daily facts, the most respectable faculty of an incurious mind. It would be like a chamber");
    expect(reflow("locked up.\n\nBut in this case")).toBe("locked up.\n\nBut in this case");
    expect(reflow("He said, “Wait.”\nThen left. Mr.  \n\n and so on")).toBe("He said, “Wait.”\n\nThen left. Mr. and so on");
  });

  it("saves the book's exact wording, found from the given page or anywhere", () => {
    const saved = saveQuote(c, { book_id: "main:1", page: 3, text: "weak ties carry  novel information", note: "Granovetter's point", labels: ["project:weak-ties", " "] }, "me@example.com", "admin");
    expect(saved).toMatchObject({ saved: true, exact: false, quote: {
      text: "Weak ties carry novel information", page: 3, page_label: "1", locator: "p. 1", section: "Part One › Chapter 1",
      labels: ["project:weak-ties"], status: "verified", source: "admin",
    } });
    // Wrong page: found anyway through the full-text index.
    expect(saveQuote(c, { book_id: "main:1", page: 1, text: "Structural holes separate" }, undefined, "agent")).toMatchObject({ saved: true, quote: { page: 5 } });
    // Crossing a page break.
    expect(saveQuote(c, { book_id: "main:1", page: 3, text: "its measurement. Strong ties sit" }, undefined, "agent").quote).toMatchObject({ page: 3, end_page: 4 });
    expect(saveQuote(c, { book_id: "main:1", text: "Weak ties carry novel information" }, undefined, "agent")).toMatchObject({ saved: false, reason: expect.stringMatching(/already saved as quote/) });
    const missing = saveQuote(c, { book_id: "main:1", page: 3, text: "strong ties carry novel information" }, undefined, "agent");
    expect(missing).toMatchObject({ saved: false, reason: expect.stringMatching(/not found/) });
    expect((missing as { closest: unknown[] }).closest.length).toBeGreaterThan(0);
    expect(() => saveQuote(c, { book_id: "main:1", text: "x".repeat(2001) }, undefined, "agent")).toThrow(/limited to 2000/);
  });

  it("searches, edits, deletes, and cites quotes, logging each change", () => {
    const a = saveQuote(c, { book_id: "main:1", page: 3, text: "Weak ties carry novel information", labels: ["Granovetter"] }, "me", "admin");
    saveQuote(c, { book_id: "main:2", page: 1, text: "The echo chamber amplifies familiar claims." }, "agent@x", "agent");
    const id = (a as { quote: { id: number } }).quote.id;
    expect(searchQuotes(c, {}).total).toBe(2);
    expect(searchQuotes(c, { q: "novel" }).quotes.map((q) => q.id)).toEqual([id]);
    expect(searchQuotes(c, { label: "granovetter" }).total).toBe(1);
    expect(searchQuotes(c, { book: "main:2" }).total).toBe(1);
    expect(searchQuotes(c, { author: "cy writer" }).total).toBe(1);
    expect(quotesOnPages(c, getBookRow("main:1"), 0, 4)).toEqual([{ id, start_page: 3, start_offset: 0, end_page: 3, end_offset: 33, note: null }]);

    expect(updateQuote(c, { id, note: "Strength of weak ties", labels: [] }, "me", "admin")).toMatchObject({ note: "Strength of weak ties", labels: [] });
    expect(citeQuote(c, id)).toMatchObject({ quote: "Weak ties carry novel information", quote_locator: "p. 1", locator: { label: "page", locator: "1" }, csl: { title: "Networks" } });
    deleteQuote(c, id, "me", "admin");
    expect(searchQuotes(c, {}).total).toBe(1);
    expect(queryChanges(data, { kinds: ["quote_saved", "quote_edited", "quote_deleted"] }).rows.map((r) => (r as Change).kind)).toEqual(["quote_deleted", "quote_edited", "quote_saved", "quote_saved"]);
  });

  it("files quotes under their book's categories, followed live, with tags for anything finer", () => {
    // main:5 is filed under social-sciences.psychology.social-psychology in Calibre.
    const saved = saveQuote(c, { book_id: "main:5", page: 1, text: "The echo chamber amplifies", labels: ["Parable", " overwork "] }, "me", "admin") as { quote: { id: number } };
    const id = saved.quote.id;
    expect(searchQuotes(c, { book: "main:5" }).quotes[0]).toMatchObject({
      book_categories: [{ tag: "social-sciences.psychology.social-psychology" }], labels: ["Parable", "overwork"],
    });
    expect(searchQuotes(c, { category: "Psychology" }).quotes.map((q) => q.id)).toEqual([id]);
    expect(searchQuotes(c, { category: "social-sciences" }).total).toBe(1);
    // Re-categorizing the book moves the quote with it.
    db.prepare("UPDATE books SET tags = ? WHERE id = 'main:5'").run(JSON.stringify(["trivia"]));
    expect(searchQuotes(c, { category: "Trivia" }).quotes.map((q) => q.id)).toEqual([id]);
    expect(searchQuotes(c, { category: "Psychology" }).total).toBe(0);
    // A second quote reuses the existing spelling, and duplicates collapse.
    const b = saveQuote(c, { book_id: "main:5", page: 1, text: "familiar claims", labels: ["parable", "PARABLE", "compassion"] }, "me", "admin") as { quote: { labels: string[] } };
    expect(b.quote.labels).toEqual(["Parable", "compassion"]);
    expect(searchQuotes(c, {}).tags).toEqual([{ tag: "Parable", n: 2 }, { tag: "compassion", n: 1 }, { tag: "overwork", n: 1 }]);
    expect(searchQuotes(c, { label: "parable" }).total).toBe(2);
  });

  it("re-anchors quotes when their book's file changes, and orphans those that are gone", () => {
    const echo = saveQuote(c, { book_id: "main:2", page: 1, text: "echo chamber amplifies" }, undefined, "agent") as { quote: { id: number } };
    const beta = saveQuote(c, { book_id: "main:2", page: 2, text: "Filter bubbles differ" }, undefined, "agent") as { quote: { id: number } };
    const file = path.join(root, "main", "Cy Writer", "Echoes (2)", "Echoes - Cy Writer.epub");
    fs.writeFileSync(file, makeEpub("Echoes", [{ title: "New opening", paragraphs: ["A preface first."] }, { title: "Alpha", paragraphs: ["The echo chamber amplifies familiar claims."] }]));
    scanLibraries(config, db);
    expect(reanchorQuotes(db, data)).toEqual({ reanchored: 1, orphaned: 1 });
    expect(searchQuotes(c, { book: "main:2" }).quotes.map((q) => [q.id, q.status, q.page]).sort()).toEqual([[echo.quote.id, "verified", 2], [beta.quote.id, "orphaned", 2]].sort());
    expect(reanchorQuotes(db, data)).toEqual({ reanchored: 0, orphaned: 0 });
  });
});

function getBookRow(id: string) {
  return db.prepare("SELECT * FROM books WHERE id = ?").get(id) as Parameters<typeof quotesOnPages>[1];
}

describe("zotero mirror", () => {
  // A stand-in Zotero Web API: items with versions, a deletion log, pages of two, and one 429 first.
  interface Item { key: string; version: number; data: Record<string, unknown> }
  let api: http.Server;
  let items: Map<string, Item>;
  let deleted: { key: string; version: number }[];
  let libraryVersion: number;
  let requests: string[];
  let throttle: number;
  let zconfig: ZoteroConfig;
  const put = (key: string, data: Record<string, unknown>) => {
    libraryVersion++;
    items.set(key, { key, version: libraryVersion, data: { key, itemType: "book", ...data } });
  };

  beforeEach(async () => {
    scanLibraries(config, db);
    items = new Map(); deleted = []; libraryVersion = 0; requests = []; throttle = 1;
    put("AAAA1111", { title: "Networks", date: "1986", creators: [{ creatorType: "author", lastName: "Author", firstName: "Ann" }], extra: "Calibre UUID: uuid-1", citationKey: "author1986networks" });
    put("BBBB2222", { title: "Strength in Numbers", date: "2000", creators: [{ creatorType: "author", lastName: "Fixed", firstName: "Fay" }], extra: "Citation Key: fixed2000strengtha\nCalibre UUID: uuid-6" });
    put("CCCC3333", { title: "Echoes: A Study", creators: [{ creatorType: "author", lastName: "Writer", firstName: "Cy" }], citationKey: "writer2010echoes" });
    put("DDDD4444", { itemType: "note", note: "a standalone note" });
    put("EEEE5555", { title: "Weak Ties Revisited", extra: "Calibre UUID: uuid-5", citationKey: "one2001weak", deleted: 1 });
    api = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://x");
      requests.push(`${url.pathname}?${url.searchParams}`);
      if (req.headers["zotero-api-key"] !== "k") return void res.writeHead(403).end();
      if (throttle-- > 0) return void res.writeHead(429, { "retry-after": "0" }).end();
      const since = Number(url.searchParams.get("since") ?? 0);
      const headers = { "content-type": "application/json", "last-modified-version": String(libraryVersion) };
      if (url.pathname === "/users/1/items/top") {
        const changed = [...items.values()].filter((i) => i.version > since);
        const start = Number(url.searchParams.get("start") ?? 0);
        return void res.writeHead(200, { ...headers, "total-results": String(changed.length) }).end(JSON.stringify(changed.slice(start, start + 2)));
      }
      if (url.pathname === "/users/1/deleted") return void res.writeHead(200, headers).end(JSON.stringify({ items: deleted.filter((d) => d.version > since).map((d) => d.key) }));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    zconfig = { library: "users/1", apiKey: "k", apiBase: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, intervalMinutes: 30 };
  });

  afterEach(() => new Promise<void>((r) => api.close(() => r())));

  it("mirrors the library in pages, matches books, pins their keys, and reports what needs a person", async () => {
    const first = await syncZotero(c, zconfig);
    expect(first).toEqual({ full: true, fetched: 5, removed: 0, version: 5, pinned: ["author1986networks"] });
    // One 429 was retried; then three pages of two.
    expect(requests.filter((r) => r.startsWith("/users/1/items/top")).map((r) => new URLSearchParams(r.split("?")[1]).get("start"))).toEqual(["0", "0", "2", "4"]);
    expect(pinnedByUuid(data, "uuid-1")).toMatchObject({ citekey: "author1986networks", pinned_by: "zotero:AAAA1111" });
    expect(queryChanges(data, { sources: ["zotero"] }).rows.map((r) => (r as Change).kind)).toEqual(["citekey_pinned"]);

    const report = zoteroReport(c, zconfig);
    expect(report.books).toMatchObject({ calibre_uuid: 2, isbn: 0, confirmed: 0, candidates: 1 });
    expect(report.sync).toMatchObject({ version: 5, items: 4, trashed: 1, error: null });
    expect(report.candidates).toEqual([{ book_id: "main:2", title: "Echoes", year: null, candidates: [{ key: "CCCC3333", citekey: "writer2010echoes", title: "Echoes: A Study", year: null }] }]);
    expect(report.mismatches).toEqual([{ book_id: "main:6", title: "Strength in Numbers", zotero_key: "BBBB2222", matched_by: "calibre_uuid", calibre: "fixed2000strength", zotero_citekey: "fixed2000strengtha" }]);
    // The trashed item and the note match nothing; library:7, a copy of Networks, is not offered A (filed for main:1).
    expect(zoteroMatch(c, getBookRow("main:5")).match).toBeNull();
    expect(zoteroMatch(c, getBookRow("library:7")).candidates).toEqual([]);
    expect(zoteroCiteInfo(c, getBookRow("main:2"))?.note).toMatch(/1 item\(s\) with this title and author \(CCCC3333\)/);
    expect(zoteroCiteInfo(c, getBookRow("main:1"))).toMatchObject({ zotero: { key: "AAAA1111", matched_by: "calibre_uuid" }, note: expect.stringMatching(/don't file it again/) });

    // Incremental: only what changed since version 5, and the deletion log.
    items.delete("AAAA1111"); libraryVersion++; deleted.push({ key: "AAAA1111", version: libraryVersion });
    put("GGGG7777", { title: "Networks (2nd printing)", ISBN: "0-00-000000-X 9780000000002", citationKey: "author1986networks" });
    // A second copy filed by mistake: same title without its subtitle, same first author and year.
    put("HHHH8888", { title: "Networks: Ties and Structure", date: "1986", creators: [{ creatorType: "author", lastName: "Author" }], citationKey: "author1986networksa" });
    requests = [];
    expect(await syncZotero(c, zconfig)).toEqual({ full: false, fetched: 2, removed: 1, version: 8, pinned: [] });
    expect(requests).toEqual(["/users/1/items/top?format=json&includeTrashed=1&since=5&limit=100&start=0", "/users/1/deleted?since=5"]);
    expect(zoteroMatch(c, getBookRow("main:1"))).toMatchObject({ match: { key: "GGGG7777", matched_by: "isbn" }, duplicates: [{ key: "HHHH8888", citekey: "author1986networksa" }] });
    expect(zoteroReport(c, zconfig).duplicates).toMatchObject([{ book_id: "main:1", zotero_key: "GGGG7777", duplicates: [{ key: "HHHH8888" }] }]);
    // Not a duplicate (another edition, say): hidden for this book.
    linkZotero(c, { book_id: "main:1", key: "HHHH8888", action: "reject" }, "me");
    expect(zoteroReport(c, zconfig).duplicates).toEqual([]);

    // A person settles the candidate: rejecting hides it; confirming links and pins.
    expect(linkZotero(c, { book_id: "main:2", key: "CCCC3333", action: "reject" }, "me").candidates).toEqual([]);
    linkZotero(c, { book_id: "main:2", key: "CCCC3333", action: "clear" }, "me");
    expect(linkZotero(c, { book_id: "main:2", key: "CCCC3333", action: "confirm" }, "me")).toMatchObject({ pinned: ["writer2010echoes"], match: { matched_by: "confirmed" } });

    // Merged in Zotero: the duplicate goes to the trash, and the kept item records that it replaces it.
    put("CCCC3333", { title: "Echoes: A Study", creators: [{ creatorType: "author", lastName: "Writer" }], citationKey: "writer2010echoes", deleted: 1 });
    put("KKKK9999", { title: "Echoes", date: "2010", creators: [{ creatorType: "author", lastName: "Writer" }], citationKey: "writer2010echoesb",
      relations: { "dc:replaces": ["http://zotero.org/users/1/items/CCCC3333"] } });
    // Filed for main:1 by UUID, then merged into another item with the UUID line lost.
    put("GGGG7777", { title: "Networks (2nd printing)", extra: "Calibre UUID: uuid-1", citationKey: "author1986networks", deleted: 1 });
    put("MMMM0000", { title: "Networks", date: "1986", creators: [{ creatorType: "author", lastName: "Author" }], citationKey: "author1986networks",
      relations: { "dc:replaces": "http://zotero.org/users/1/items/GGGG7777" } });
    await syncZotero(c, zconfig);
    expect(zoteroMatch(c, getBookRow("main:2")).match).toMatchObject({ key: "KKKK9999", matched_by: "confirmed" });
    expect(zoteroMatch(c, getBookRow("main:1")).match).toMatchObject({ key: "MMMM0000", matched_by: "calibre_uuid" });
    // The pin stays; the kept item's different key is reported for a person.
    expect(zoteroReport(c, zconfig).mismatches.map((m) => [m.book_id, m.zotero_key, m.zotero_citekey])).toEqual([
      ["main:2", "KKKK9999", "writer2010echoesb"], ["main:6", "BBBB2222", "fixed2000strengtha"],
    ]);
  });

  it("keeps the last error and the library version when a sync fails", async () => {
    await syncZotero(c, zconfig);
    await expect(syncZotero(c, { ...zconfig, apiKey: "wrong" })).rejects.toThrow(/refused the API key/);
    expect(zoteroReport(c, zconfig).sync).toMatchObject({ version: 5, error: expect.stringMatching(/refused the API key/) });
    await syncZotero(c, zconfig);
    expect(zoteroReport(c, zconfig).sync.error).toBeNull();
  });
});
