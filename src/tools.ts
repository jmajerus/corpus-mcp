import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import type { DB } from "./db.js";
import { type BookFormat, openBook } from "./extract.js";

/**
 * Tool implementations over the index. Pages are 1-based in every input and output.
 * For PDFs a page is a physical page and `page_label` is its printed number. For EPUB and
 * MOBI a page is a location in the service's fixed layout: stable, but not citable.
 */

export class ToolError extends Error {}

interface BookRow {
  id: string; library: string; title: string; authors: string; publisher: string | null; year: number | null;
  language: string | null; isbn: string | null; tags: string; format: BookFormat | null; file_path: string | null;
  sha256: string | null; reflowable: number | null; page_count: number | null; status: string; error: string | null;
}

interface PageRow { page_index: number; label: string | null; section_path: string | null; text: string }

function getBook(db: DB, bookId: string): BookRow {
  const book = db.prepare<[string], BookRow>("SELECT * FROM books WHERE id = ?").get(bookId);
  if (!book) throw new ToolError(`No book "${bookId}". Use list_books to find book ids.`);
  return book;
}

function getIndexedBook(db: DB, bookId: string): BookRow & { page_count: number } {
  const book = getBook(db, bookId);
  if (book.status !== "indexed") {
    throw new ToolError(`Book "${bookId}" has no indexed text (${book.status === "no_file" ? "no PDF, EPUB, or MOBI file" : `extraction failed: ${book.error}`}).`);
  }
  return book as BookRow & { page_count: number };
}

function checkPage(book: { id: string; page_count: number }, page: number): void {
  if (!Number.isInteger(page) || page < 1 || page > book.page_count) {
    throw new ToolError(`Page ${page} is outside ${book.id}, which has pages 1–${book.page_count}.`);
  }
}

function bookSummary(book: BookRow) {
  return {
    book_id: book.id,
    title: book.title,
    authors: JSON.parse(book.authors) as string[],
    year: book.year,
    publisher: book.publisher,
    isbn: book.isbn,
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

export function searchCorpus(db: DB, args: SearchArgs) {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const match = args.advanced ? args.query : toFtsQuery(args.query);
  const where = ["passages_fts MATCH @match", "b.status = 'indexed'"];
  if (args.book_id) where.push("b.id = @book_id");
  if (args.library) where.push("b.library = @library");
  if (args.author) where.push("b.authors LIKE @author");

  let rows: (PageRow & BookRow & { ord: number; snippet: string })[];
  try {
    rows = db.prepare(`
      SELECT b.*, x.page_index, x.ord, p.label, p.section_path,
             snippet(passages_fts, 0, '«', '»', '…', 40) AS snippet
      FROM passages_fts
      JOIN passages x ON x.id = passages_fts.rowid
      JOIN books b ON b.id = x.book_id
      JOIN pages p ON p.book_id = x.book_id AND p.page_index = x.page_index
      WHERE ${where.join(" AND ")}
      ORDER BY bm25(passages_fts)
      LIMIT @fetch`).all({
      match, book_id: args.book_id, library: args.library,
      author: args.author ? `%${args.author}%` : undefined, fetch: limit * 4,
    }) as typeof rows;
  } catch (error) {
    throw new ToolError(`Search failed: ${(error as Error).message}. ${args.advanced ? "Check the FTS5 syntax, or omit advanced." : ""}`);
  }

  // The same file can sit in more than one library; keep its best-ranked hit only.
  const seen = new Set<string>();
  const results = [];
  for (const row of rows) {
    const key = `${row.sha256}:${row.page_index}:${row.ord}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      book_id: row.id,
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

export function listBooks(db: DB, args: ListArgs) {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
  const where: string[] = [];
  if (!args.include_unindexed) where.push("status = 'indexed'");
  if (args.library) where.push("library = @library");
  if (args.query) where.push("(title LIKE @q OR authors LIKE @q OR tags LIKE @q OR isbn LIKE @q OR publisher LIKE @q OR id = @exact)");
  const rows = db.prepare(`
    SELECT * FROM books ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY title COLLATE NOCASE, id LIMIT @limit`).all({
    library: args.library, q: args.query ? `%${args.query}%` : undefined, exact: args.query, limit,
  }) as BookRow[];
  const copies = db.prepare<[string, string], string>("SELECT id FROM books WHERE sha256 = ? AND id != ?").pluck();
  return {
    count: rows.length,
    books: rows.map((b) => ({ ...bookSummary(b), same_file_as: b.sha256 ? copies.all(b.sha256, b.id) : [] })),
  };
}

export function getBookOutline(db: DB, bookId: string) {
  const book = getIndexedBook(db, bookId);
  const outline = db.prepare(`
    SELECT o.level, o.title, o.start_page, p.label
    FROM outline o LEFT JOIN pages p ON p.book_id = o.book_id AND p.page_index = o.start_page
    WHERE o.book_id = ? ORDER BY o.ord`).all(bookId) as { level: number; title: string; start_page: number | null; label: string | null }[];
  return {
    ...bookSummary(book),
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

export function readBook(db: DB, args: ReadArgs) {
  const book = getIndexedBook(db, args.book_id);
  const maxChars = Math.min(Math.max(args.max_chars ?? 12000, 500), 40000);
  let start: number;
  let end: number;

  if (args.section) {
    const entries = db.prepare(
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

  const pages = db.prepare(
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

export function renderPage(db: DB, booksRoot: string, args: RenderArgs): { png: string; width: number; height: number } {
  const book = getIndexedBook(db, args.book_id);
  if (book.reflowable) throw new ToolError(`${book.id} is ${book.format?.toUpperCase()}, which has no fixed pages to render. Use read_book.`);
  checkPage(book, args.page);
  const scale = Math.min(Math.max(args.scale ?? 1.5, 0.5), 3);
  const file = path.join(booksRoot, book.file_path!);
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

export interface CiteArgs { book_id: string; page?: number; end_page?: number }

export function citePassage(db: DB, args: CiteArgs) {
  const book = getBook(db, args.book_id);
  const authors = JSON.parse(book.authors) as string[];
  const citation: Record<string, string> = { title: book.title };
  const author = joinAuthors(authors.filter((a) => a !== "Unknown"));
  if (author) citation.author = author;
  if (book.publisher) citation.publisher = book.publisher;
  if (book.year) citation.year = String(book.year);

  let locator: Record<string, unknown> | undefined;
  const warnings: string[] = [];
  if (args.page !== undefined) {
    const indexed = getIndexedBook(db, args.book_id);
    const end = args.end_page ?? args.page;
    checkPage(indexed, args.page);
    checkPage(indexed, end);
    const pageRow = db.prepare<[string, number], PageRow>("SELECT * FROM pages WHERE book_id = ? AND page_index = ?");
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
  if (!book.year) warnings.push("Calibre has no publication year for this book.");
  if (!book.isbn) warnings.push("Calibre has no ISBN for this book, so it cannot be matched to a Zotero item by ISBN.");

  return { citation, locator, isbn: book.isbn, warnings };
}

export function corpusStatus(db: DB) {
  const counts = db.prepare("SELECT library, format, status, COUNT(*) AS books FROM books GROUP BY 1, 2, 3 ORDER BY 1, 2, 3").all();
  const lastScan = db.prepare("SELECT value FROM meta WHERE key = 'last_scan'").pluck().get();
  const failed = db.prepare("SELECT id, title, error FROM books WHERE status = 'failed'").all();
  const noText = db.prepare(`
    SELECT b.id, b.title, b.page_count FROM books b
    WHERE b.status = 'indexed' AND (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM pages p WHERE p.book_id = b.id) < 20 * b.page_count`).all();
  const noOutline = db.prepare(`
    SELECT id, title, format FROM books b
    WHERE status = 'indexed' AND NOT EXISTS (SELECT 1 FROM outline o WHERE o.book_id = b.id)`).all();
  return {
    last_scan: lastScan ?? null,
    counts,
    failed,
    little_or_no_text: { note: "Probably scanned images without a text layer; they need OCR.", books: noText },
    no_outline: { note: "No chapter locators. For MOBI books, convert to EPUB in Calibre.", books: noOutline },
  };
}
