import { afterAll, afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { refreshDerivedMetadata } from "../src/indexer.js";
import { metadataPages, METADATA_FRONT_CHARS, METADATA_BACK_CHARS } from "../src/metadata-window.js";
import { TITLE_PAGE_SCAN_VERSION } from "../src/titlepage.js";
import { findPrintedIsbns } from "../src/isbn.js";
import { findPrintedYears, printedYear } from "../src/years.js";

const db = openDatabase(":memory:");
afterAll(() => db.close());
afterEach(() => { db.exec("DELETE FROM books; DELETE FROM meta WHERE key = 'pandoc_metadata_window_version'"); });

function book(id: string, version: number, texts: { text: string; section?: string }[]) {
  db.prepare(`INSERT INTO books(id,library,calibre_id,title,authors,tags,folder,status,indexed_at,page_count,extractor_version)
    VALUES(?, 'main', 1, 'Example Book', '["Ann Author"]', '[]', '', 'indexed', '', ?, ?)`).run(id, texts.length, version);
  const insert = db.prepare("INSERT INTO pages(book_id,page_index,text,section_path) VALUES(?,?,?,?)");
  texts.forEach((p, i) => insert.run(id, i, p.text, p.section ?? null));
  return { id, page_count: texts.length, extractor_version: version };
}

it("finds metadata beyond twenty logical locations, retaining real locations and back-matter classification", () => {
  const texts = Array.from({ length: 280 }, () => ({ text: "x".repeat(1_000), section: "Body" }));
  for (let i = 40; i < 55; i++) texts[i].section = "Copyright";
  texts[45].text = "Copyright 2005. ISBN 978-0-306-40615-7";
  texts[51].text = "This edition copyright 2007";
  texts[55].text = "An example: Copyright 2025 Example Corp.";
  texts[144] = { text: "About the authors\nAnn Author is a writer.", section: "About the authors" };
  texts[270].text = "Copyright 2020. ISBN 978-1-4028-9462-6";
  const b = book("logical", 3, texts);
  const pages = metadataPages(db, b);
  expect(pages.some(p => p.page_index === 144)).toBe(false);
  expect(metadataPages(db, b, true).some(p => p.page_index === 144)).toBe(true);
  expect(findPrintedIsbns(pages).map(p => [p.page, p.position])).toEqual([[46, "front"], [271, "back"]]);
  const years = findPrintedYears(pages);
  expect(printedYear(years)?.year).toBe(2005); // The old physical-page rule skips later copyright paragraphs.
  expect(printedYear(years, pages)).toMatchObject({ year: 2007, page: 52, position: "front" });
  refreshDerivedMetadata(db, "author-year-word");
  const row = db.prepare("SELECT printed_year,printed_isbns,proposed_citekey FROM books WHERE id=?").get(b.id) as { printed_year: number; printed_isbns: string; proposed_citekey: string };
  expect(row.printed_year).toBe(2007);
  expect(row.proposed_citekey).toContain("2007");
  expect(JSON.parse(row.printed_isbns).map((p: { page: number }) => p.page)).toEqual([46, 271]);
});

it("keeps boundary blocks whole, gives overlapping front matter priority, and handles short books", () => {
  const b = book("boundary", 3, [
    { text: "x".repeat(METADATA_FRONT_CHARS - 1) },
    { text: "ISBN 978-0-306-40615-7" },
    { text: "x".repeat(METADATA_BACK_CHARS) },
    { text: "x".repeat(METADATA_BACK_CHARS) },
  ]);
  const pages = metadataPages(db, b);
  expect(pages.map(p => p.page_index)).toEqual([0, 1, 3]);
  expect(findPrintedIsbns(pages)[0]).toMatchObject({ page: 2, position: "front" });
  const short = book("short", 3, [{ text: "Copyright 2012" }, { text: "Body" }]);
  expect(metadataPages(db, short).map(p => p.position)).toEqual(["front", "front"]);
});

it("preserves the legacy 20/5-page window and its classification", () => {
  for (const version of [1, 2]) {
    const b = book(`legacy${version}`, version, Array.from({ length: 100 }, () => ({ text: "text" })));
    const pages = metadataPages(db, b);
    expect(pages.map(p => p.page_index)).toEqual([...Array.from({ length: 20 }, (_, i) => i), 95, 96, 97, 98, 99]);
    expect(pages.filter(p => p.position === "back").map(p => p.page_index)).toEqual([95, 96, 97, 98, 99]);
  }
});

it("bounds unnamed copyright continuation by text length and stops at section boundaries or gaps", () => {
  const p = (page_index: number, text: string, section_path: string | null = null) => ({ page_index, text, section_path, label: null });
  const pages = [p(0, "Copyright 2000"), p(1, "x".repeat(6_000)), p(2, "Copyright 2025")];
  expect(printedYear(findPrintedYears(pages), pages)?.year).toBe(2000);
  for (const following of [p(1, "Copyright 2025", "Chapter One"), p(2, "Copyright 2025")]) {
    const sample = [p(0, "Copyright 2000"), following];
    expect(printedYear(findPrintedYears(sample), sample)?.year).toBe(2000);
  }
});

it("invalidates prior Pandoc window caches once while leaving legacy caches unchanged", () => {
  book("logical", 3, [{ text: "Copyright 2016. ISBN 978-0-306-40615-7" }]);
  book("legacy", 1, [{ text: "Copyright 2012" }]);
  db.prepare(`UPDATE books SET year=2000, text_chars=10, printed_isbns='[]', printed_isbns_version=2,
    printed_years='[]', printed_years_version=2, printed_year=1999,
    title_page='{"authors":[],"title":null,"for_title":"Example Book"}',title_page_version=?`).run(TITLE_PAGE_SCAN_VERSION);
  const legacy = db.prepare("SELECT * FROM books WHERE id='legacy'").get();
  refreshDerivedMetadata(db, "author-year-word");
  expect(db.prepare("SELECT printed_year FROM books WHERE id='logical'").pluck().get()).toBe(2016);
  expect(db.prepare("SELECT * FROM books WHERE id='legacy'").get()).toEqual(legacy);
  db.prepare("UPDATE books SET printed_year=2015 WHERE id='logical'").run();
  refreshDerivedMetadata(db, "author-year-word");
  expect(db.prepare("SELECT printed_year FROM books WHERE id='logical'").pluck().get()).toBe(2015);
});
