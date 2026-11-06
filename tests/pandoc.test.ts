import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { extractBook } from "../src/extract.js";
import { extractPandocEpub, PANDOC_ADAPTER_VERSION } from "../src/pandoc.js";
import { relocatedAnchorPlanner } from "../src/anchor-migration.js";
import { storeAnchor, type Anchor } from "../src/anchors.js";
import { openDatabase } from "../src/db.js";
import { openDataStore } from "../src/data.js";
import { scanLibraries } from "../src/indexer.js";
import { pagesOf, joinedPageText, locate, saveQuote } from "../src/quotes.js";
import { stageEpubReextraction } from "../src/reextraction.js";
import type { Config } from "../src/config.js";
import type { Corpus } from "../src/tools.js";
import { makeEpub, makeLibrary, tempDir } from "./fixtures.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: vi.fn(original.spawnSync) };
});

it.each(["2.19.2", "3.0", "3.0.99", "unknown", "3.1junk"])("rejects unsupported Pandoc version %s before accepting its document", (version) => {
  vi.mocked(spawnSync).mockReturnValueOnce({ pid: 1, status: 0, signal: null, stderr: "", output: [],
    stdout: JSON.stringify({ version, document: { "pandoc-api-version": [1, 23, 1], blocks: [], meta: {} },
      locations: [{ text: "Text.", heading: 0 }] }) });
  expect(() => extractPandocEpub(new Uint8Array())).toThrow(/Unsupported Pandoc version.*install Pandoc >= 3\.1/);
});

it.each(["3.1", "3.1.3", "3.1.2.1", "3.10", "4.0"])("accepts supported Pandoc version %s", (version) => {
  vi.mocked(spawnSync).mockReturnValueOnce({ pid: 1, status: 0, signal: null, stderr: "", output: [],
    stdout: JSON.stringify({ version, document: { "pandoc-api-version": [1, 23, 1], blocks: [
      { t: "Para", c: [{ t: "Span", c: [["ch1.xhtml", [], []], []] }] },
      { t: "Para", c: [{ t: "Str", c: "Text." }] },
    ], meta: {} }, blockTexts: ["", "Text."], locations: [{ text: "Text.", heading: 0 }] }) });
  expect(extractPandocEpub(makeEpub("Version", [{ title: "Chapter", paragraphs: ["Text."] }])).pandocVersion).toBe(version);
});

it("uses Pandoc structure and writer for prose, verse, lists, code, and nested headings", () => {
  const data = makeEpub("Structure", [{ title: "Chapter", paragraphs: [], body: `
    <h1>Chapter</h1><div><h2>Section</h2>
    <p>One <em>continuous</em> paragraph\nwith <strong>inline</strong> markup.</p>
    <p>Second paragraph.</p><p>First verse line.<br/>Second verse line.</p>
    <pre><code>one\n  two</code></pre><ol><li>First item</li><li>Second item</li></ol>
    <blockquote><p>A quotation.</p></blockquote></div>` }]);
  const book = extractPandocEpub(data);
  expect(book.pages.map((p) => p.paragraphs.join("\n\n"))).toEqual([
    "Chapter", "Section", "One continuous paragraph with inline markup.", "Second paragraph.",
    "First verse line.\nSecond verse line.", "    one\n      two", "1.  First item\n2.  Second item", "  A quotation.",
  ]);
  expect(book.outline).toMatchObject([
    { title: "Chapter", level: 0, startPage: 0 },
  ]);
  expect(book.pages.slice(1).every((p) => p.separatorBefore === "\n\n")).toBe(true);
  // The adapter retains the rich document: formatting remains available to future writers.
  const html = spawnSync(process.env.CORPUS_PANDOC_PATH || "pandoc", ["--sandbox", "--from=json", "--to=html"], {
    input: JSON.stringify(book.document), encoding: "utf8",
  });
  expect(html.status).toBe(0);
  expect(html.stdout).toContain("<em>continuous</em>");
  expect(html.stdout).toContain("<strong>inline</strong>");
  expect(extractBook(data, "epub", { epubParagraphs: "pandoc" }).pages).toEqual(book.pages);
});

it("fails explicitly when Pandoc is missing and rejects non-EPUB use", () => {
  vi.stubEnv("CORPUS_PANDOC_PATH", "/nonexistent/corpus-pandoc");
  try { expect(() => extractPandocEpub(new Uint8Array())).toThrow(/Pandoc EPUB extraction failed.*Install Pandoc/s); }
  finally { vi.unstubAllEnvs(); }
  expect(() => extractBook(new Uint8Array(), "pdf", { epubParagraphs: "pandoc" })).toThrow(/only supported for EPUB/);
  expect(() => extractPandocEpub(Buffer.from("invalid epub"))).toThrow(/Pandoc EPUB extraction failed/);
});

it("retains EPUB footnotes in both the readable text and the reusable AST", () => {
  const book = extractPandocEpub(makeEpub("Notes", [{ title: "Notes", paragraphs: [], body: `
    <p>Text with a note<a xmlns:epub="http://www.idpf.org/2007/ops" epub:type="noteref" href="#n1">1</a>.</p>
    <aside xmlns:epub="http://www.idpf.org/2007/ops" epub:type="footnote" id="n1"><p>The note body.</p></aside>` }]));
  expect(book.pages[0].paragraphs[0]).toContain("The note body.");
  expect(JSON.stringify(book.document)).toContain('"t":"Note"');
});

it("refuses preprocessing when a conversion changes the text or reading locations", async () => {
  const files = unzipSync(makeEpub("Rewrite", [{ title: "Chapter", paragraphs: [], body: '<p id="target">Words.</p>' }]));
  files["OEBPS/nav.xhtml"] = strToU8(strFromU8(files["OEBPS/nav.xhtml"]).replace('href="ch1.xhtml"', 'href="ch1.xhtml#target"'));
  const { spawnSync: actual } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawnSync).mockImplementationOnce(actual).mockImplementationOnce((...args: Parameters<typeof actual>) => {
    const result = actual(...args);
    const parsed = JSON.parse(String(result.stdout));
    parsed.locations[0].text += " Changed.";
    return { ...result, stdout: JSON.stringify(parsed) };
  });
  expect(() => extractPandocEpub(zipSync(files))).toThrow(/preprocessing changed readable text or location boundaries/);
});

it("relocates unique quotes across blocks and refuses ambiguous or stale anchors", () => {
  const page = (text: string, page_index: number) => ({ text, page_index, label: null, section_path: null, separator_before: "\n\n" });
  const before = [page("Opening. Unique\n\nquote here. End.", 0)];
  const after = [page("New heading", 0), page("Opening.", 1), page("Unique quote", 2), page("here. End.", 3)];
  const old = locate(before, "Unique quote here.")!;
  expect(relocatedAnchorPlanner(before, after)(old)).toMatchObject({ status: "remapped", anchor: {
    start_page: 2, start_offset: 0, end_page: 3, end_offset: 5, text: "Unique quote\n\nhere.",
  } });
  expect(relocatedAnchorPlanner(before, [...after, page("Unique quote here.", 4)])(old))
    .toEqual({ status: "review", reason: "ambiguous-wording" });
  expect(relocatedAnchorPlanner(before, after)({ ...old, start_offset: 0 }))
    .toEqual({ status: "review", reason: "stale-old-anchor" });
  expect(relocatedAnchorPlanner(before, [page("Different wording.", 0)])(old))
    .toEqual({ status: "review", reason: "wording-not-found" });
});

it("stages Pandoc locations and anchors in copies and retains the profile during refresh", async () => {
  const root = tempDir();
  const epub = makeEpub("Pandoc", [{ title: "Chapter", paragraphs: [
    "A long continuous paragraph with enough words to wrap over visual lines. ".repeat(10),
    "A unique saved passage for anchor migration.",
  ] }]);
  makeLibrary(root, "main", [
    { id: 1, title: "Pandoc", files: { epub } },
    { id: 2, title: "Navigation", files: { epub: makeEpub("Navigation", [{ title: "Named chapter", paragraphs: [],
      body: "<p>A chapter identified by navigation rather than an HTML heading.</p>" },
      { title: "Unresolved empty chapter", paragraphs: [], body: "" }]) } },
  ]);
  const config = { booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"), shelvesFile: path.join(root, "shelves.json"),
    shelvesLibrary: "main", citekeyPreset: "author-year-word" } as Config;
  const db = openDatabase(config.dbPath), data = openDataStore(config.dataDbPath);
  try {
    scanLibraries(config, db);
    const before = pagesOf(db, "main:1", 0, 100);
    const old = locate(before, "A unique saved passage for anchor migration.")!;
    const hash = db.prepare("SELECT sha256 FROM books WHERE id='main:1'").pluck().get() as string;
    const anchor: Anchor = { ...old, calibre_uuid: "uuid-1", sha256: hash, page_label: null, end_page_label: null, section: null };
    expect(storeAnchor({ db, data } as Corpus, { excludeTags: [] }, { quote_id: 12, anchor }).status).toBe(201);
    expect(saveQuote({ db, data } as Corpus, { book_id: "main:1", text: old.text }, undefined, "agent").saved).toBe(true);
    const originalAnchors = data.prepare("SELECT * FROM anchors").all();
    const report = await stageEpubReextraction({ index: config.dbPath, data: config.dataDbPath, booksRoot: root,
      books: ["main:1", "main:2"], output: path.join(root, "candidate") });
    expect(report.books[0]).toMatchObject({ status: "staged", newLocations: 3,
      anchors: expect.arrayContaining([{ kind: "anchor", id: 12, status: "remapped" }]) });
    expect(report.books[1]).toMatchObject({ status: "refused", reason: expect.stringContaining("no readable location") });
    expect(report.promotionReady).toBe(false);
    expect(pagesOf(db, "main:1", 0, 100)).toEqual(before);
    expect(data.prepare("SELECT * FROM anchors").all()).toEqual(originalAnchors);
    const candidate = openDatabase(path.join(report.directory, "corpus.db"));
    const candidateData = openDataStore(path.join(report.directory, "data.db"));
    try {
      const pages = pagesOf(candidate, "main:1", 0, 100);
      expect(pages).toHaveLength(3);
      expect(candidate.prepare("SELECT extractor_version FROM books WHERE id='main:1'").pluck().get()).toBe(3);
      expect(candidateData.prepare("SELECT start_page FROM anchors WHERE quote_id=12").pluck().get()).toBe(2);
      expect(candidateData.prepare("SELECT start_page,section_path,text FROM quotes").get()).toEqual({
        start_page: 2, section_path: "Chapter", text: old.text,
      });
      expect(candidate.prepare("SELECT value FROM meta WHERE key='pandoc:main:1'").pluck().get()).toBe(report.books[0].pandocVersion);
      expect(candidate.prepare("SELECT value FROM meta WHERE key='pandoc_adapter:main:1'").pluck().get()).toBe(String(PANDOC_ADAPTER_VERSION));
      expect(candidate.prepare("SELECT extractor_version FROM books WHERE id='main:2'").pluck().get()).toBe(1);
      expect(candidate.prepare("SELECT count(*) FROM outline WHERE book_id='main:2'").pluck().get()).toBeGreaterThan(0);
      expect(scanLibraries(config, candidate, { force: true })).toMatchObject({ extracted: 2, failed: 0 });
      expect(pagesOf(candidate, "main:1", 0, 100)).toEqual(pages);
      candidate.prepare("DELETE FROM meta WHERE key='pandoc_adapter:main:1'").run();
      expect(scanLibraries(config, candidate, { force: true })).toMatchObject({ extracted: 1, failed: 1 });
      expect(pagesOf(candidate, "main:1", 0, 100)).toEqual(pages);
      candidate.prepare("INSERT INTO meta(key,value) VALUES ('pandoc_adapter:main:1',?)").run(String(PANDOC_ADAPTER_VERSION));
      candidate.prepare("UPDATE meta SET value='different-version' WHERE key='pandoc:main:1'").run();
      expect(scanLibraries(config, candidate, { force: true })).toMatchObject({ extracted: 1, failed: 1 });
      expect(pagesOf(candidate, "main:1", 0, 100)).toEqual(pages);
      expect(joinedPageText(pages)).toContain("Chapter\n\nA long continuous paragraph");
    } finally { candidate.close(); candidateData.close(); }
    const repeated = locate(before, "A long continuous paragraph")!;
    expect(storeAnchor({ db, data } as Corpus, { excludeTags: [] }, { quote_id: 13,
      anchor: { ...anchor, ...repeated } }).status).toBe(201);
    const refused = await stageEpubReextraction({ index: config.dbPath, data: config.dataDbPath, booksRoot: root,
      books: ["main:1"], output: path.join(root, "refused") });
    expect(refused.books[0]).toMatchObject({ status: "refused", anchors: expect.arrayContaining([
      expect.objectContaining({ id: 13, status: "review", reason: "ambiguous-wording" }),
    ]) });
    const retained = openDatabase(path.join(refused.directory, "corpus.db"));
    try { expect(pagesOf(retained, "main:1", 0, 100)).toEqual(before); }
    finally { retained.close(); }
  } finally { db.close(); data.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
