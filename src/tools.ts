import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { bookBibtex } from "./bibtex.js";
import { CITEKEY_PATTERN, type CitekeyBlocker } from "./citekey.js";
import { type DataStore, type PinnedCitekey, allPinned, pinnedByKey, pinnedByUuid } from "./data.js";
import type { DB } from "./db.js";
import { type BookFormat, openBook } from "./extract.js";
import { type IsbnCandidate, validIsbn } from "./isbn.js";

export { validIsbn };

/**
 * Tool implementations over the index. Pages are 1-based in every input and output.
 * For PDFs a page is a physical page and `page_label` is its printed number. For EPUB and
 * MOBI a page is a location in the service's fixed layout: stable, but not citable.
 * Every tool that takes a book id also takes a citekey.
 */

export class ToolError extends Error {}

/** The read-only index, the read-write primary data, and the mirrored book files. */
export interface Corpus { db: DB; data: DataStore; booksRoot: string }

interface BookRow {
  id: string; library: string; uuid: string | null; title: string; authors: string; author_sorts: string;
  publisher: string | null; year: number | null; language: string | null; isbn: string | null;
  calibre_citekey: string | null; proposed_citekey: string | null; citekey_blockers: string; printed_isbns: string | null; tags: string;
  format: BookFormat | null; file_path: string | null; sha256: string | null; reflowable: number | null;
  page_count: number | null; status: string; error: string | null;
}

interface PageRow { page_index: number; label: string | null; section_path: string | null; text: string }

const BOOK_ID = /^[^:\s]+:\d+$/;

/** A book by id ("main:42") or citekey: Calibre's identifier, then a pinned key, then a proposed key held by one book. */
function getBook(c: Corpus, idOrCitekey: string): BookRow {
  const byId = c.db.prepare<[string], BookRow>("SELECT * FROM books WHERE id = ?");
  if (BOOK_ID.test(idOrCitekey)) {
    const book = byId.get(idOrCitekey);
    if (!book) throw new ToolError(`No book "${idOrCitekey}". Use list_books to find book ids.`);
    return book;
  }
  const key = idOrCitekey.trim().toLowerCase();
  const calibre = c.db.prepare<[string], BookRow>("SELECT * FROM books WHERE calibre_citekey = ? ORDER BY id").get(key);
  if (calibre) return calibre;
  const pinned = pinnedByKey(c.data, key);
  if (pinned) {
    const book = c.db.prepare<[string], BookRow>("SELECT * FROM books WHERE uuid = ? ORDER BY id").get(pinned.calibre_uuid);
    if (book) return book;
    throw new ToolError(`Citekey "${key}" is pinned to "${pinned.title}" (${pinned.book_id}), which is no longer in the index.`);
  }
  const proposed = c.db.prepare<[string], BookRow>("SELECT * FROM books WHERE proposed_citekey = ? ORDER BY id").all(key);
  if (proposed.length === 1) return proposed[0];
  if (proposed.length > 1) {
    throw new ToolError(`Citekey "${key}" is proposed for ${proposed.length} books (${proposed.map((b) => b.id).join(", ")}). Use a book id.`);
  }
  throw new ToolError(`No book "${idOrCitekey}". Use list_books to find book ids or citekeys.`);
}

function getIndexedBook(c: Corpus, idOrCitekey: string): BookRow & { page_count: number } {
  const book = getBook(c, idOrCitekey);
  if (book.status !== "indexed") {
    throw new ToolError(`Book "${book.id}" has no indexed text (${book.status === "no_file" ? "no PDF, EPUB, or MOBI file" : `extraction failed: ${book.error}`}).`);
  }
  return book as BookRow & { page_count: number };
}

function checkPage(book: { id: string; page_count: number }, page: number): void {
  if (!Number.isInteger(page) || page < 1 || page > book.page_count) {
    throw new ToolError(`Page ${page} is outside ${book.id}, which has pages 1–${book.page_count}.`);
  }
}

/** The key that identifies the book in Zotero: Calibre's identifier overrides a pinned key. */
function effectiveCitekey(book: BookRow, pin: PinnedCitekey | undefined) {
  if (book.calibre_citekey) return { citekey: book.calibre_citekey, citekey_source: "calibre" as const };
  if (pin) return { citekey: pin.citekey, citekey_source: "pinned" as const };
  return { citekey: null, citekey_source: null };
}

function citekeyInfo(book: BookRow, pin: PinnedCitekey | undefined) {
  return {
    ...effectiveCitekey(book, pin),
    proposed_citekey: book.proposed_citekey,
    citekey_blockers: JSON.parse(book.citekey_blockers) as CitekeyBlocker[],
  };
}

function bookSummary(book: BookRow, pin: PinnedCitekey | undefined) {
  return {
    book_id: book.id,
    title: book.title,
    authors: JSON.parse(book.authors) as string[],
    year: book.year,
    publisher: book.publisher,
    isbn: book.isbn,
    ...citekeyInfo(book, pin),
    format: book.format,
    pages: book.page_count,
    page_kind: book.reflowable === null ? null : book.reflowable ? "location" : "pdf_page",
    status: book.status,
  };
}

/** Plain queries become an AND of quoted terms; double-quoted phrases are kept. */
export function toFtsQuery(query: string): string {
  const terms = [...query.matchAll(/"([^"]+)"|(\S+)/g)]
    .map((m) => (m[1] ?? m[2]).replace(/[^\p{L}\p{N}\s'*-]/gu, " ").trim())
    .filter(Boolean);
  if (!terms.length) throw new ToolError("The query has no searchable words.");
  return terms
    .map((t) => {
      const prefix = t.endsWith("*") && !t.includes(" ");
      const body = t.replace(/\*+$/, "").replace(/"/g, '""');
      return prefix ? `"${body}"*` : `"${body}"`;
    })
    .join(" ");
}

export interface SearchArgs { query: string; book_id?: string; library?: string; author?: string; limit?: number; advanced?: boolean }

export function searchCorpus(c: Corpus, args: SearchArgs) {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const match = args.advanced ? args.query : toFtsQuery(args.query);
  const bookId = args.book_id ? getBook(c, args.book_id).id : undefined;
  const where = ["passages_fts MATCH @match", "b.status = 'indexed'"];
  if (bookId) where.push("b.id = @book_id");
  if (args.library) where.push("b.library = @library");
  if (args.author) where.push("b.authors LIKE @author");

  let rows: (PageRow & BookRow & { ord: number; snippet: string })[];
  try {
    rows = c.db.prepare(`
      SELECT b.*, x.page_index, x.ord, p.label, p.section_path,
             snippet(passages_fts, 0, '«', '»', '…', 40) AS snippet
      FROM passages_fts
      JOIN passages x ON x.id = passages_fts.rowid
      JOIN books b ON b.id = x.book_id
      JOIN pages p ON p.book_id = x.book_id AND p.page_index = x.page_index
      WHERE ${where.join(" AND ")}
      ORDER BY bm25(passages_fts)
      LIMIT @fetch`).all({
      match, book_id: bookId, library: args.library,
      author: args.author ? `%${args.author}%` : undefined, fetch: limit * 4,
    }) as typeof rows;
  } catch (error) {
    throw new ToolError(`Search failed: ${(error as Error).message}. ${args.advanced ? "Check the FTS5 syntax, or omit advanced." : ""}`);
  }

  // The same file can sit in more than one library; keep its best-ranked hit only.
  const pins = allPinned(c.data);
  const seen = new Set<string>();
  const results = [];
  for (const row of rows) {
    const key = `${row.sha256}:${row.page_index}:${row.ord}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      book_id: row.id,
      citekey: effectiveCitekey(row, row.uuid ? pins.get(row.uuid) : undefined).citekey,
      title: row.title,
      authors: JSON.parse(row.authors) as string[],
      year: row.year,
      page: row.page_index + 1,
      page_label: row.label,
      section: row.section_path,
      snippet: row.snippet,
    });
    if (results.length === limit) break;
  }
  return { query: match, count: results.length, results };
}

export interface ListArgs { query?: string; library?: string; include_unindexed?: boolean; limit?: number }

export function listBooks(c: Corpus, args: ListArgs) {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
  const pins = allPinned(c.data);
  const query = args.query?.toLowerCase();
  // Pinned keys live in data.db, so match them here and pass the UUIDs into the index query.
  const pinnedMatches = query ? [...pins.values()].filter((p) => p.citekey.includes(query)).map((p) => p.calibre_uuid) : [];
  const where: string[] = [];
  if (!args.include_unindexed) where.push("status = 'indexed'");
  if (args.library) where.push("library = @library");
  if (query) {
    where.push(`(title LIKE @q OR authors LIKE @q OR tags LIKE @q OR isbn LIKE @q OR publisher LIKE @q OR id = @exact
      OR calibre_citekey LIKE @q OR proposed_citekey LIKE @q OR uuid IN (SELECT value FROM json_each(@pinned)))`);
  }
  const rows = c.db.prepare(`
    SELECT * FROM books ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY title COLLATE NOCASE, id LIMIT @limit`).all({
    library: args.library, q: query ? `%${query}%` : undefined, exact: args.query, limit, pinned: JSON.stringify(pinnedMatches),
  }) as BookRow[];
  const copies = c.db.prepare<[string, string], string>("SELECT id FROM books WHERE sha256 = ? AND id != ?").pluck();
  return {
    count: rows.length,
    books: rows.map((b) => ({
      ...bookSummary(b, b.uuid ? pins.get(b.uuid) : undefined),
      same_file_as: b.sha256 ? copies.all(b.sha256, b.id) : [],
    })),
  };
}

export function getBookOutline(c: Corpus, bookId: string) {
  const book = getIndexedBook(c, bookId);
  const outline = c.db.prepare(`
    SELECT o.level, o.title, o.start_page, p.label
    FROM outline o LEFT JOIN pages p ON p.book_id = o.book_id AND p.page_index = o.start_page
    WHERE o.book_id = ? ORDER BY o.ord`).all(book.id) as { level: number; title: string; start_page: number | null; label: string | null }[];
  return {
    ...bookSummary(book, pinnedByUuid(c.data, book.uuid)),
    tags: JSON.parse(book.tags) as string[],
    outline: outline.map((o) => ({
      level: o.level,
      title: o.title,
      page: o.start_page === null ? null : o.start_page + 1,
      ...(book.reflowable ? {} : { page_label: o.label }),
    })),
    ...(outline.length ? {} : { note: "This book has no outline. Read it by page range, or search within it with search_corpus." }),
  };
}

export interface ReadArgs { book_id: string; start_page?: number; end_page?: number; section?: string; max_chars?: number }

export function readBook(c: Corpus, args: ReadArgs) {
  const book = getIndexedBook(c, args.book_id);
  const maxChars = Math.min(Math.max(args.max_chars ?? 12000, 500), 40000);
  let start: number;
  let end: number;

  if (args.section) {
    const entries = c.db.prepare(
      "SELECT ord, level, title, path, start_page FROM outline WHERE book_id = ? AND start_page IS NOT NULL ORDER BY ord",
    ).all(book.id) as { ord: number; level: number; title: string; path: string; start_page: number }[];
    const needle = args.section.toLowerCase();
    const exact = entries.findIndex((e) => e.title.toLowerCase() === needle);
    const index = exact >= 0 ? exact : entries.findIndex((e) => e.path.toLowerCase().includes(needle));
    if (index < 0) throw new ToolError(`No outline section matching "${args.section}" in ${book.id}. Use get_book_outline.`);
    const entry = entries[index];
    const next = entries.slice(index + 1).find((e) => e.level <= entry.level && e.start_page > entry.start_page);
    start = entry.start_page + 1;
    end = next ? next.start_page : book.page_count;
  } else {
    start = args.start_page ?? 1;
    end = args.end_page ?? start;
  }
  checkPage(book, start);
  checkPage(book, end);
  if (end < start) throw new ToolError(`end_page ${end} is before start_page ${start}.`);

  const pages = c.db.prepare(
    "SELECT page_index, label, section_path, text FROM pages WHERE book_id = ? AND page_index BETWEEN ? AND ? ORDER BY page_index",
  ).iterate(book.id, start - 1, end - 1) as IterableIterator<PageRow>;

  const parts: string[] = [];
  let used = 0;
  let lastRead = start - 1;
  let truncated = false;
  for (const page of pages) {
    const header = `--- page ${page.page_index + 1}${page.label ? ` (printed ${page.label})` : ""}${page.section_path ? ` · ${page.section_path}` : ""} ---`;
    const block = `${header}\n${page.text}`;
    if (used + block.length > maxChars && parts.length) {
      truncated = true;
      break;
    }
    parts.push(block.length > maxChars ? `${block.slice(0, maxChars)}\n[page truncated at max_chars]` : block);
    used += block.length;
    lastRead = page.page_index + 1;
  }
  const continuation = truncated || lastRead < end
    ? `\n\n[Read pages ${start}–${lastRead} of ${start}–${end}. Continue with start_page ${lastRead + 1}.]`
    : "";
  return `${book.title} (${book.id})\n\n${parts.join("\n\n")}${continuation}`;
}

export interface RenderArgs { book_id: string; page: number; scale?: number }

export function renderPage(c: Corpus, args: RenderArgs): { png: string; width: number; height: number } {
  const book = getIndexedBook(c, args.book_id);
  if (book.reflowable) throw new ToolError(`${book.id} is ${book.format?.toUpperCase()}, which has no fixed pages to render. Use read_book.`);
  checkPage(book, args.page);
  const scale = Math.min(Math.max(args.scale ?? 1.5, 0.5), 3);
  const file = path.join(c.booksRoot, book.file_path!);
  if (!fs.existsSync(file)) throw new ToolError(`The file for ${book.id} is missing on disk. The index may be out of date.`);
  const doc = openBook(fs.readFileSync(file), book.format!);
  try {
    const page = doc.loadPage(args.page - 1);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const result = { png: Buffer.from(pixmap.asPNG()).toString("base64"), width: pixmap.getWidth(), height: pixmap.getHeight() };
    pixmap.destroy();
    page.destroy();
    return result;
  } finally {
    doc.destroy();
  }
}

/** Joins names the way the Concept Clusters corpus mostly does: "A", "A and B", "A, B, and C". */
function joinAuthors(authors: string[]): string | undefined {
  if (authors.length === 0) return undefined;
  if (authors.length <= 2) return authors.join(" and ");
  return `${authors.slice(0, -1).join(", ")}, and ${authors.at(-1)}`;
}

const BLOCKER_FIXES: Record<CitekeyBlocker, string> = {
  unknown_author: "Calibre has no author for this book.",
  merged_authors: "One Calibre author record names several people (Calibre shows commas inside a name as \"|\"). Split it into separate authors in Calibre.",
  no_year: "Calibre has no publication year for this book.",
  malformed: "The proposed citekey is malformed; check the author and title in Calibre.",
};

/** The ISBNs the book's own text prints, found at index time. */
function printedIsbns(book: BookRow): IsbnCandidate[] {
  return book.printed_isbns ? (JSON.parse(book.printed_isbns) as IsbnCandidate[]) : [];
}

interface ZoteroFiling { tool: "file_zotero_reference"; arguments: { bibtex: string } | { isbn: string }; source: "calibre-metadata" | "isbn-lookup" }

export interface CiteArgs { book_id: string; page?: number; end_page?: number }

export function citePassage(c: Corpus, args: CiteArgs) {
  const book = getBook(c, args.book_id);
  const authors = JSON.parse(book.authors) as string[];
  const citation: Record<string, string> = { title: book.title };
  const author = joinAuthors(authors.filter((a) => a !== "Unknown"));
  if (author) citation.author = author;
  if (book.publisher) citation.publisher = book.publisher;
  if (book.year) citation.year = String(book.year);

  let locator: Record<string, unknown> | undefined;
  const warnings: string[] = [];
  if (args.page !== undefined) {
    const indexed = getIndexedBook(c, book.id);
    const end = args.end_page ?? args.page;
    checkPage(indexed, args.page);
    checkPage(indexed, end);
    const pageRow = c.db.prepare<[string, number], PageRow>("SELECT * FROM pages WHERE book_id = ? AND page_index = ?");
    const first = pageRow.get(book.id, args.page - 1)!;
    const last = pageRow.get(book.id, end - 1)!;
    if (!book.reflowable) {
      const a = first.label ?? String(args.page);
      const b = last.label ?? String(end);
      citation.pages = a === b ? a : `${a}-${b}`;
      if (!first.label) warnings.push("This PDF has no printed page labels; pages are physical page numbers.");
    } else {
      warnings.push("EPUB and MOBI locations are not page numbers, so the citation has no pages. Name the chapter in the puzzle text if it matters.");
    }
    locator = { page: args.page, end_page: end, section: first.section_path, ...(book.reflowable ? {} : { page_label: first.label }) };
  }
  if (!book.publisher) warnings.push("Calibre has no publisher for this book.");

  const pin = pinnedByUuid(c.data, book.uuid);
  const keys = citekeyInfo(book, pin);
  if (keys.citekey_source === "pinned") {
    // Pinned means Concept Clusters filed it and assigned this key.
    return { citation, locator, ...keys, isbn: book.isbn, warnings };
  }

  // Not filed yet. Preferred: BibTeX from Calibre's own metadata. Fallback: ISBN lookup.
  const zoteroFiling: ZoteroFiling[] = [];
  const filingKey = keys.citekey ?? (keys.citekey_blockers.length ? null : book.proposed_citekey);
  if (filingKey) {
    zoteroFiling.push({
      tool: "file_zotero_reference",
      source: "calibre-metadata",
      arguments: {
        bibtex: bookBibtex({
          citekey: filingKey, title: book.title, authors, authorSorts: JSON.parse(book.author_sorts) as string[],
          publisher: book.publisher, year: book.year, isbn: book.isbn, calibreUuid: book.uuid,
        }),
      },
    });
  } else {
    warnings.push(...keys.citekey_blockers.map((b) => BLOCKER_FIXES[b]));
  }
  const isbn = book.isbn ? validIsbn(book.isbn) : null;
  let isbnCandidates: IsbnCandidate[] | undefined;
  if (isbn) {
    zoteroFiling.push({ tool: "file_zotero_reference", source: "isbn-lookup", arguments: { isbn } });
  } else {
    if (book.isbn) warnings.push(`Calibre's ISBN "${book.isbn}" fails its check digit, so file_zotero_reference will reject it. Correct it in Calibre first.`);
    // Candidates only: copyright pages often list several editions, and the right one is the edition held.
    isbnCandidates = printedIsbns(book);
    if (isbnCandidates.length) {
      warnings.push(`Calibre has no valid ISBN, but the book prints ${isbnCandidates.length} (isbn_candidates). Confirm the one for this edition (the file is ${book.format?.toUpperCase()}) before filing with file_zotero_reference({ isbn }), and add it to Calibre. ISBNs in the last pages (position "back") are often adverts for other books.`);
    }
  }
  if (zoteroFiling.length) {
    warnings.push("To file the book in Zotero, try zotero_filing in order. ISBN lookups use Open Library or Google Books, so check the citation Zotero returns. Then call pin_citekey with the citekey file_zotero_reference returns.");
  } else {
    warnings.push("This book cannot be filed in Zotero yet. Fix the metadata in Calibre, or file it by DOI, URL, or item key.");
  }
  return { citation, locator, ...keys, isbn: book.isbn, isbn_candidates: isbnCandidates, zotero_filing: zoteroFiling, warnings };
}

export interface PinArgs { book_id: string; citekey: string; replace?: boolean }

/** Records the citekey Concept Clusters assigned when it filed the book, against the book's Calibre UUID. */
export function pinCitekey(c: Corpus, args: PinArgs, pinnedBy?: string) {
  const book = getBook(c, args.book_id);
  if (!book.uuid) throw new ToolError(`${book.id} has no Calibre UUID, so its citekey cannot be pinned.`);
  const citekey = args.citekey.trim().toLowerCase();
  if (!CITEKEY_PATTERN.test(citekey)) {
    throw new ToolError(`"${args.citekey}" is not a citekey of the form author + year + title word (e.g. "nye2011future", with an optional a–z suffix).`);
  }
  const holder = pinnedByKey(c.data, citekey);
  if (holder && holder.calibre_uuid !== book.uuid) {
    throw new ToolError(`Citekey "${citekey}" is already pinned to "${holder.title}" (${holder.book_id}).`);
  }
  const existing = pinnedByUuid(c.data, book.uuid);
  const warnings: string[] = [];
  if (existing?.citekey === citekey) {
    return { status: "unchanged", book_id: book.id, citekey, pinned_at: existing.pinned_at, warnings };
  }
  if (existing && !args.replace) {
    throw new ToolError(`${book.id} is already pinned to "${existing.citekey}". Pass replace: true to change it.`);
  }
  if (book.calibre_citekey && book.calibre_citekey !== citekey) {
    warnings.push(`Calibre's citekey identifier "${book.calibre_citekey}" overrides this pin until it is removed in Calibre.`);
  }
  const proposed = book.proposed_citekey;
  const suffixed = proposed && citekey.length === proposed.length + 1 && citekey.startsWith(proposed);
  if (proposed && citekey !== proposed && !suffixed) {
    warnings.push(`The proposed citekey was "${book.proposed_citekey}". Pinned "${citekey}" as given.`);
  }
  const pinnedAt = new Date().toISOString();
  c.data.prepare(`
    INSERT INTO citekeys (calibre_uuid, citekey, book_id, title, pinned_at, pinned_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (calibre_uuid) DO UPDATE SET citekey = excluded.citekey, book_id = excluded.book_id,
      title = excluded.title, pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by`)
    .run(book.uuid, citekey, book.id, book.title, pinnedAt, pinnedBy ?? null);
  return { status: existing ? "replaced" : "pinned", book_id: book.id, citekey, previous: existing?.citekey, pinned_at: pinnedAt, warnings };
}

export function corpusStatus(c: Corpus) {
  const { db } = c;
  const counts = db.prepare("SELECT library, format, status, COUNT(*) AS books FROM books GROUP BY 1, 2, 3 ORDER BY 1, 2, 3").all();
  const lastScan = db.prepare("SELECT value FROM meta WHERE key = 'last_scan'").pluck().get();
  const failed = db.prepare("SELECT id, title, error FROM books WHERE status = 'failed'").all();
  const noText = db.prepare(`
    SELECT id, title, page_count FROM books WHERE status = 'indexed' AND text_chars < 20 * page_count`).all();
  const noOutline = db.prepare(`
    SELECT id, title, format FROM books b
    WHERE status = 'indexed' AND NOT EXISTS (SELECT 1 FROM outline o WHERE o.book_id = b.id)`).all();
  return {
    last_scan: lastScan ?? null,
    counts,
    failed,
    little_or_no_text: { note: "Probably scanned images without a text layer; they need OCR.", books: noText },
    no_outline: { note: "No chapter locators. For MOBI books, convert to EPUB in Calibre.", books: noOutline },
    citekeys: citekeyReadiness(c),
    printed_isbns: printedIsbnReport(c),
  };
}

/** Books Calibre has no valid ISBN for whose text prints one: candidates to confirm and add in Calibre. */
function printedIsbnReport(c: Corpus) {
  const books = (c.db.prepare("SELECT * FROM books WHERE status = 'indexed' ORDER BY id").all() as BookRow[])
    .filter((b) => !(b.isbn && validIsbn(b.isbn)));
  const found = books
    .map((b) => ({ book_id: b.id, title: b.title, format: b.format, candidates: printedIsbns(b).map((x) => ({ isbn: x.isbn, format: x.format, page: x.page, position: x.position })) }))
    .filter((b) => b.candidates.length);
  return {
    note: "Calibre has no valid ISBN for these books, but their text prints one. Confirm the edition held and add it in Calibre.",
    books_without_isbn: books.length,
    books_printing_isbn: found.length,
    books: found.slice(0, 100),
    ...(found.length > 100 ? { books_truncated: found.length - 100 } : {}),
  };
}

function citekeyReadiness(c: Corpus) {
  const pins = allPinned(c.data);
  const books = c.db.prepare("SELECT * FROM books WHERE status != 'no_file' ORDER BY id").all() as BookRow[];
  const blocked: Record<CitekeyBlocker, number> = { unknown_author: 0, merged_authors: 0, no_year: 0, malformed: 0 };
  const blockedBooks: { book_id: string; title: string; blockers: CitekeyBlocker[] }[] = [];
  const byProposed = new Map<string, string[]>();
  let pinned = 0;
  let calibre = 0;
  let ready = 0;
  for (const b of books) {
    const source = effectiveCitekey(b, b.uuid ? pins.get(b.uuid) : undefined).citekey_source;
    if (source === "calibre") calibre++;
    else if (source === "pinned") pinned++;
    if (source) continue;
    const blockers = JSON.parse(b.citekey_blockers) as CitekeyBlocker[];
    if (blockers.length) {
      for (const x of blockers) blocked[x]++;
      blockedBooks.push({ book_id: b.id, title: b.title, blockers });
    } else {
      ready++;
      byProposed.set(b.proposed_citekey!, [...(byProposed.get(b.proposed_citekey!) ?? []), b.id]);
    }
  }
  return {
    note: "Books need a citekey to be filed in Zotero from their Calibre metadata. Fix blocked books in Calibre.",
    pinned,
    calibre_identifier: calibre,
    ready_to_file: ready,
    blocked,
    proposed_collisions: [...byProposed].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, books: ids })),
    blocked_books: blockedBooks.slice(0, 100),
    ...(blockedBooks.length > 100 ? { blocked_books_truncated: blockedBooks.length - 100 } : {}),
  };
}
