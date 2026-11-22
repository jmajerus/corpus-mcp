import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Anchor, reanchorAnchors, storeAnchor, verifyPassage } from "../src/anchors.js";
import { relocatedAnchorPlanner } from "../src/anchor-migration.js";
import type { Config } from "../src/config.js";
import { openDataStore } from "../src/data.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import { applyPageLabelPins, bookOutline, inferNumbering, pinPageLabels, pinnedLabels, printedContents, textQuality } from "../src/printed-pages.js";
import { damagedSpellings, locate } from "../src/quotes.js";
import { type Corpus, citePassage, readBook, skimPage } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { findPrintedYears, printedYear } from "../src/years.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

const page = (page_index: number, text: string, label: string | null = String(page_index + 1)) => ({ page_index, label, section_path: null, text });

describe("ligature-tolerant matching", () => {
  const pages = [page(0, "Tis non-tangible space came, afer all, from crafsmanship."), page(1, "Te next page begins here.")];

  it("matches across letters the text lost to ligatures, and restores them from the quote", () => {
    const hit = locate(pages, "This non-tangible space came, after all, from craftsmanship.", { ligatures: true })!;
    expect(hit.text).toBe("Tis non-tangible space came, afer all, from crafsmanship.");
    expect(hit.reading).toBe("This non-tangible space came, after all, from craftsmanship.");
    expect(hit.restored).toBe(3);
    expect([hit.start_offset, hit.end_offset]).toEqual([0, pages[0].text.length]);
  });

  it("keeps the book's own punctuation and case, and works across a page break", () => {
    const hit = locate(pages, "from craftsmanship. The next page", { ligatures: true })!;
    expect(hit.text).toBe("from crafsmanship.\nTe next page");
    expect(hit.reading).toBe("from craftsmanship.\nThe next page");
    expect([hit.start_page, hit.end_page]).toEqual([0, 1]);
  });

  it("is opt-in, needs a long enough quote, and never adds letters the quote lacks", () => {
    expect(locate(pages, "This non-tangible space came")).toBeNull();
    expect(locate(pages, "This non", { ligatures: true })).toBeNull();
    expect(locate([page(0, "This non-tangible space came")], "Tis non-tangible space came", { ligatures: true })).toBeNull();
    // An exact match is still exact, with no reading.
    expect(locate(pages, "Te next page begins", { ligatures: true })).not.toHaveProperty("reading");
  });

  it("finds a quote whose every word has ligature runs, with no page given, by looking up damaged spellings", () => {
    expect(damagedSpellings("different")).toEqual(["diferent", "dierent"]);
    expect(damagedSpellings("plain")).toEqual([]);
  });

  it("matches a run lost whole (\"dierent\" for \"different\")", () => {
    expect(locate([page(0, "A dierent kind of eect entirely.")], "A different kind of effect entirely.", { ligatures: true })?.reading)
      .toBe("A different kind of effect entirely.");
  });
});

describe("re-extraction with a reading", () => {
  const damaged = [page(0, "Intro."), page(1, "Tis non-tangible space came afer all.")];
  const clean = [page(0, "Intro."), page(1, "This non-tangible space came after all.")];
  const old = { ...locate(damaged, "This non-tangible space came after all.", { ligatures: true })! };

  it("finds the quote in a clean extraction by its reading, and keeps the reading while the text is still damaged", () => {
    const toClean = relocatedAnchorPlanner(damaged, clean)(old);
    expect(toClean).toMatchObject({ status: "remapped", anchor: { text: "This non-tangible space came after all." } });
    expect(toClean.status !== "review" && toClean.anchor.reading).toBeFalsy();
    const same = relocatedAnchorPlanner(damaged, damaged)(old);
    expect(same).toMatchObject({ status: "unchanged", anchor: { reading: "This non-tangible space came after all." } });
  });
});

describe("text quality", () => {
  it("flags dropped ligatures by comparing damaged and intact spellings, and counts unreadable characters", () => {
    const damaged = textQuality([page(0, "Te cat. Te dog. Tis is it. Tey went afer it, ofen. The end."), page(1, "© 201�")]);
    expect(damaged.dropped_ligatures.map((d) => d.ligature)).toEqual(["Th"]);
    expect(damaged.dropped_ligatures[0].examples).toEqual(["Te", "Tis", "Tey"]);
    expect(damaged).toMatchObject({ unreadable_chars: 1, unreadable_pages: [2] });
    expect(damaged.note).toMatch(/add_quote matches across the missing letters/);
    expect(textQuality([page(0, "The cat. The dog. This is it. They went. Te quiero, said Ana.")])).toEqual({ dropped_ligatures: [], unreadable_chars: 0, unreadable_pages: [] });
  });
});

describe("printed numbering", () => {
  // File page = printed page + 1: a cover sheet before the book, as in a ResearchGate download.
  const book = Array.from({ length: 32 }, (_, i) => page(i, "Body text that runs on."));
  book[0] = page(0, "Cover sheet");
  book[4] = page(4, "4\n\nContents\n\nForeword . . . . . . . .9 PART I: The Theories 1. Introduction . . . . . . .15 1.1 The Course of the Research . . . . . . .17 2. What is Called Zero? . . . . . . .27");
  // Indices are 0-based: file page 10 is index 9.
  book[9] = page(9, "Foreword\n\nIt starts.");
  book[15] = page(15, "15\n\n1. Introduction\n\nIn the case of the creative mind.");
  book[17] = page(17, "The research went on.\n\n1.1 The Course of the Research\n\nIt went.");
  book[27] = page(27, "2. What is Called Zero?\n\nZero is.");

  it("reads the contents with dot leaders", () => {
    const contents = printedContents(book);
    expect(contents.pages).toEqual([4]);
    expect(contents.entries.map((e) => [e.title, e.printed_page])).toEqual([
      ["Foreword", "9"], ["PART I: The Theories 1. Introduction", "15"], ["1.1 The Course of the Research", "17"], ["2. What is Called Zero?", "27"],
    ]);
  });

  it("infers the offset from where the contents' headings start and from folios, and suggests the pin", () => {
    const { numbering, entries } = inferNumbering(book);
    expect(numbering).toMatchObject({ offset: 1, suggested_pin: { file_page: 2, page_label: "1" }, evidence: { contents_entries: 4, folios: 2 } });
    expect(entries.map((e) => [e.file_page, e.found])).toEqual([[10, true], [16, true], [18, true], [28, true]]);
  });

  it("finds nothing without enough evidence", () => {
    expect(inferNumbering([page(0, "Just text."), page(1, "More text.")]).numbering).toBeNull();
  });

  it("numbers pages from pinned ranges, roman then arabic, with none before the first", () => {
    expect(pinnedLabels([{ file_page: 5, page_label: "1" }, { file_page: 2, page_label: "iii" }], 7)).toEqual([null, "iii", "iv", "v", "1", "2", "3"]);
    expect(pinnedLabels([{ file_page: 1, page_label: "XII" }], 2)).toEqual(["XII", "XIII"]);
  });
});

describe("skim", () => {
  it("ends a short first sentence, but not at an abbreviation or an initial", () => {
    expect(skimPage("Hi. This is the rest of a long paragraph that goes on and on past any heading length.")).toBe("· Hi.");
    expect(skimPage("Mr. Smith met J. R. Jones at noon. Then they left together for the long walk home again.")).toBe("· Mr. Smith met J. R. Jones at noon.");
  });

  it("keeps headings whole and each paragraph's first sentence", () => {
    expect(skimPage("15\n\n1. Introduction\n\nIn the case of the mind, it seems. Hence your complaints.\n\nShort final line.")).toBe(
      "15\n1. Introduction\n· In the case of the mind, it seems.\n· Short final line.");
  });
});

describe("printed years", () => {
  it("reads a ResearchGate cover sheet's date as a publication year", () => {
    const pages = [{ page_index: 0, label: null, text: "Zero Spaces: Poiesis\n\nBook · December 2014\n\nCITATIONS 0" }];
    const years = findPrintedYears(pages, 200);
    expect(years).toMatchObject([{ year: 2014, kind: "published", page: 1 }]);
    expect(printedYear(years)?.year).toBe(2014);
  });
});

describe("pinning page labels", () => {
  let root: string;
  let c: Corpus;
  let config: Config;
  const o = { excludeTags: [], zoteroLibrary: "users/1" };

  beforeAll(() => {
    root = tempDir();
    const body = Array.from({ length: 20 }, (_, i) => [`Page ${i + 1} of the body, with plain words on it.`]);
    body[0] = ["Cover sheet. Copyright 2014 by Atropos Press"];
    body[1] = ["Contents", "Introduction . . . . . . .3 Second Chapter . . . . . . .6 Third Chapter . . . . . . .9"];
    body[3] = ["3", "Introduction", "Te subject of crafsmanship is ofen overlooked."];
    body[6] = ["Second Chapter", "It begins here."];
    body[9] = ["Third Chapter", "It begins here too."];
    body[12] = ["Te dierent eects of crafsmanship are many."];
    makeLibrary(root, "main", [
      { id: 14, title: "Zero Spaces", authors: ["Gabrielle Collet"], pubdate: "2018-01-01", files: { pdf: makePdf({ pages: body }) } },
    ]);
    config = {
      booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"), dataDbPath: path.join(root, "data.db"),
      backupDir: path.join(root, "backups"), shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
      citekeyPreset: "author-year-word", vocabularyPath: path.join(import.meta.dirname, "vocabulary.json"),
    };
    const db = openDatabase(config.dbPath);
    scanLibraries(config, db);
    c = { db, data: openDataStore(config.dataDbPath), booksRoot: root, vocabulary: Vocabulary.load(config.vocabularyPath) };
  });

  afterAll(() => {
    c.db.close();
    c.data.close();
    if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true }); else console.log("KEPT", root);
  });

  it("saves a quote whose words the PDF text damaged, with the printed reading, and stores its anchor", () => {
    const answer = verifyPassage(c, o, { book: "main:14", text: "The subject of craftsmanship is often overlooked." });
    const body = answer.body as { match: boolean; exact: boolean; text: string; restored: { letters: number; stored_text: string }; anchor: Anchor };
    expect(body).toMatchObject({ match: true, exact: true, text: "The subject of craftsmanship is often overlooked.", restored: { kind: "dropped-ligatures", letters: 3 } });
    expect(body.anchor).toMatchObject({ text: "Te subject of crafsmanship is ofen overlooked.", reading: "The subject of craftsmanship is often overlooked." });
    expect(storeAnchor(c, o, { quote_id: 875, anchor: body.anchor }).status).toBe(201);
    expect(c.data.prepare("SELECT reading FROM anchors WHERE quote_id = 875").pluck().get()).toBe("The subject of craftsmanship is often overlooked.");
    // Posting it again is a no-op; a reading that isn't the text restored is refused.
    expect(storeAnchor(c, o, { quote_id: 875, anchor: body.anchor }).status).toBe(200);
    expect(storeAnchor(c, o, { quote_id: 876, anchor: { ...body.anchor, reading: "The subject of witchcraft is often overlooked." } }).status).toBe(400);
  });

  it("finds a damaged passage with no page hint when every looked-up word has ligature runs", () => {
    const body = verifyPassage(c, o, { book: "main:14", text: "The different effects of craftsmanship" }).body as { match: boolean; text: string };
    expect(body).toMatchObject({ match: true, text: "The different effects of craftsmanship" });
  });

  it("reports the file-position labels, the inferred numbering, the contents, and the text quality in the outline", () => {
    const outline = bookOutline(c, "main:14") as ReturnType<typeof bookOutline> & Record<string, any>;
    expect(outline.page_labels).toMatchObject({ source: "file_position", inferred: { offset: 1, suggested_pin: { file_page: 2, page_label: "1" } } });
    expect(outline.page_labels.note).toMatch(/pin_page_labels with file_page 2 and page_label "1"/);
    expect(outline.printed_contents.map((e: { title: string; file_page: number; found: boolean }) => [e.title, e.file_page, e.found]))
      .toEqual([["Introduction", 4, true], ["Second Chapter", 7, true], ["Third Chapter", 10, true]]);
    expect(outline.text_quality.dropped_ligatures).toMatchObject([{ ligature: "ft", words_intact: 0 }]);
  });

  it("flags a Calibre year the book contradicts", () => {
    const cite = citePassage(c, { book_id: "main:14" });
    expect(cite.warnings.join(" ")).toMatch(/Calibre gives 2018, but the book prints 2014 \(file_page 1/);
    expect(cite).toMatchObject({ year_source: "calibre", printed_year: { year: 2014, file_page: 1 } });
  });

  it("pins a numbering, applies it at the refresh to pages and anchors, and clears it", () => {
    const pinned = pinPageLabels(c, { book_id: "main:14", file_page: 4, page_label: "3" }, "editor@example.org");
    expect(pinned).toMatchObject({ status: "pinned", quotes_relabelled: 1, sample: [{ file_page: 4, page_label: "3" }, { file_page: 14, page_label: "13" }, { file_page: 20, page_label: "19" }] });
    expect(pinned.warnings).toEqual(["File pages 1–3 get no page_label. Pin another range for numbered front matter."]);
    expect(pinPageLabels(c, { book_id: "main:14", file_page: 4, page_label: "3" })).toMatchObject({ status: "unchanged" });
    expect((bookOutline(c, "main:14") as Record<string, any>).page_labels.source).toBe("pin_pending");

    // The refresh, with the index open for writing.
    const db = openDatabase(config.dbPath);
    expect(applyPageLabelPins(db, c.data, root)).toEqual({ books: 1, pages: 20, anchors: 1, stale: [] });
    expect(applyPageLabelPins(db, c.data, root)).toEqual({ books: 0, pages: 0, anchors: 0, stale: [] });
    const anchor = c.data.prepare("SELECT page_label FROM anchors WHERE quote_id = 875").pluck().get();
    expect(anchor).toBe("3");
    const change = c.data.prepare("SELECT kind, anchor FROM anchor_changes ORDER BY seq DESC LIMIT 1").get() as { kind: string; anchor: string };
    expect(change.kind).toBe("reanchored");
    expect(JSON.parse(change.anchor)).toMatchObject({ page_label: "3", start_page: 3 });
    expect((bookOutline(c, "main:14") as Record<string, any>).page_labels.source).toBe("pinned");
    expect(citePassage(c, { book_id: "main:14", page_label: "3" }).position).toMatchObject({ file_page: 4, page_label: "3" });
    expect(readBook(c, { book_id: "main:14", file_page: 1, end_file_page: 2 })).toMatch(/--- file_page 1 ---/);

    // A disagreeing pin is warned about; clearing restores the PDF's own labels.
    expect(pinPageLabels(c, { book_id: "main:14", file_page: 4, page_label: "4" }).warnings.join(" ")).toMatch(/suggest file_page = printed page \+ 1/);
    expect(pinPageLabels(c, { book_id: "main:14", clear: true })).toMatchObject({ status: "cleared" });
    applyPageLabelPins(db, c.data, root);
    expect(c.db.prepare("SELECT label FROM pages WHERE book_id = 'main:14' AND page_index = 3").pluck().get()).toBe("4");
    expect(c.data.prepare("SELECT COUNT(*) FROM page_label_pins").pluck().get()).toBe(0);
    db.close();
  });

  it("finds a restored quote again in a clean file by its reading, and drops the reading", () => {
    // A new file for the book, whose text has the ligatures intact.
    const clean = "3\n\nIntroduction\n\nThe subject of craftsmanship is often overlooked.";
    c.db.prepare("UPDATE pages SET text = ? WHERE book_id = 'main:14' AND page_index = 3").run(clean);
    c.data.prepare("UPDATE anchors SET sha256 = 'the-old-file' WHERE quote_id = 875").run();
    expect(reanchorAnchors(c.db, c.data)).toMatchObject({ reanchored: 1, orphaned: 0 });
    const row = c.data.prepare("SELECT text, reading, status FROM anchors WHERE quote_id = 875").get();
    expect(row).toEqual({ text: "The subject of craftsmanship is often overlooked.", reading: null, status: "verified" });
    const change = JSON.parse(c.data.prepare("SELECT anchor FROM anchor_changes ORDER BY seq DESC LIMIT 1").pluck().get() as string);
    expect(change.text).toBe("The subject of craftsmanship is often overlooked.");
    expect(change).not.toHaveProperty("reading");
  });

  it("refuses what it can't pin", () => {
    expect(() => pinPageLabels(c, { book_id: "main:14", file_page: 99, page_label: "1" })).toThrow(/outside main:14/);
    expect(() => pinPageLabels(c, { book_id: "main:14", file_page: 2, page_label: "two" })).toThrow(/neither an arabic/);
    expect(() => pinPageLabels(c, { book_id: "main:14" })).toThrow(/Pass file_page and page_label/);
  });
});
