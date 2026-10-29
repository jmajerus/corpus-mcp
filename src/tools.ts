import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { bookBibtex } from "./bibtex.js";
import type { CslName } from "@jmajerus/citekey";
import { type CitekeyBlocker, DEFAULT_PRESET, type PresetName, calibreNames, followsRule } from "./citekey.js";
import { type DataStore, type PinnedCitekey, allPinned, pinnedByKey, pinnedByUuid, recordChanges } from "./data.js";
import type { DB } from "./db.js";
import { type BookFormat, openBook } from "./extract.js";
import { type IsbnCandidate, validIsbn } from "./isbn.js";
import type { YearCandidate } from "./years.js";
import { type TitlePageScan, mangledTitle } from "./titlepage.js";
import type { Vocabulary, VocabularySource } from "./vocabulary.js";
import type { Taxonomy } from "./taxonomy/taxonomy.js";

export { validIsbn };

/**
 * Tool implementations over the index. Pages are 1-based in every input and output.
 * For PDFs a page is a physical page and `page_label` is its printed number. For EPUB and
 * MOBI a page is a location in the service's fixed layout: stable, but not citable.
 * Every tool that takes a book id also takes a citekey.
 */

export class ToolError extends Error {}

/** The read-only index, the read-write primary data, the mirrored book files, and the tag vocabulary. */
export interface Corpus {
  db: DB; data: DataStore; booksRoot: string; vocabulary: Vocabulary;
  /** Where the vocabulary comes from, when it is a file (the server); tests pass a Vocabulary alone. */
  vocabularySource?: VocabularySource;
  /** The supplied vocabulary with corpus-mcp's overlay merged over it (the server); `vocabulary` is its current merge. */
  taxonomy?: Taxonomy;
  /** The citekey preset the index was built with (default "author-year-word"). */
  citekeyPreset?: PresetName;
}

export interface BookRow {
  id: string; library: string; uuid: string | null; title: string; authors: string; author_sorts: string;
  publisher: string | null; year: number | null; language: string | null; isbn: string | null;
  calibre_citekey: string | null; proposed_citekey: string | null; citekey_blockers: string; printed_isbns: string | null; tags: string;
  printed_years: string | null; printed_year: number | null; title_page: string | null;
  description: string | null; format: BookFormat | null; file_path: string | null; sha256: string | null; reflowable: number | null;
  page_count: number | null; status: string; error: string | null; calibre_id: number; file_size: number | null; text_chars: number | null;
}

interface PageRow { page_index: number; label: string | null; section_path: string | null; text: string }

const BOOK_ID = /^[^:\s]+:\d+$/;
/** Characters BibTeX keys can safely hold. */
const BIBTEX_KEY = /^[A-Za-z0-9_:.+-]+$/;

/** A book by id ("main:42") or citekey: Calibre's identifier, then a pinned key, then a proposed key held by one book. */
export function getBook(c: Corpus, idOrCitekey: string): BookRow {
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
export function effectiveCitekey(book: BookRow, pin: PinnedCitekey | undefined) {
  if (book.calibre_citekey) return { citekey: book.calibre_citekey, citekey_source: "calibre" as const };
  if (pin) return { citekey: pin.citekey, citekey_source: "pinned" as const };
  return { citekey: null, citekey_source: null };
}

export function citekeyInfo(book: BookRow, pin: PinnedCitekey | undefined) {
  return {
    ...effectiveCitekey(book, pin),
    proposed_citekey: book.proposed_citekey,
    citekey_blockers: JSON.parse(book.citekey_blockers) as CitekeyBlocker[],
  };
}

/** Shelf names per book id, for the given books (all books when omitted). */
export function shelvesByBook(c: Corpus, bookIds?: string[]): Map<string, string[]> {
  const rows = c.db.prepare(`
    SELECT bs.book_id, s.name FROM book_shelves bs JOIN shelves s ON s.id = bs.shelf_id
    ${bookIds ? "WHERE bs.book_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY s.name`)
    .all(...(bookIds ? [JSON.stringify(bookIds)] : [])) as { book_id: string; name: string }[];
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.book_id, [...(map.get(r.book_id) ?? []), r.name]);
  return map;
}

/** The SQL condition for books on a shelf, matched by name; an unknown name is an error that lists the shelves. */
function shelfFilter(c: Corpus, shelf: string): string {
  const known = c.db.prepare("SELECT name FROM shelves ORDER BY name").pluck().all() as string[];
  if (!known.some((name) => name.toLowerCase() === shelf.toLowerCase())) {
    throw new ToolError(known.length ? `No shelf "${shelf}". Shelves: ${known.join(", ")}.` : "No shelves have been synced from Calibre-Web.");
  }
  return "b.id IN (SELECT bs.book_id FROM book_shelves bs JOIN shelves s ON s.id = bs.shelf_id WHERE s.name = @shelf COLLATE NOCASE)";
}

/**
 * The SQL condition for books carrying a tag or any tag below it, with the value bound as @tag. Calibre
 * (and Calibre-Web's "Categories") nest tags with ".": "social-sciences" matches
 * "social-sciences.psychology". The tag may start at any level, so "psychology" matches
 * "social-sciences.psychology.social-psychology". Vocabulary titles work too ("Psychology",
 * "Social Sciences › Psychology"); they are translated to slugs. Case-insensitive.
 */
export function tagFilterValue(c: Corpus, tag: string): string {
  return c.vocabulary.toSlugPath(tag);
}

export function tagFilter(c: Corpus, tag: string): string {
  const condition = `EXISTS (SELECT 1 FROM json_each(b.tags) t
    WHERE ('.' || lower(t.value) || '.') LIKE '%.' || replace(replace(replace(lower(@tag), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '.%' ESCAPE '\\')`;
  const any = c.db.prepare(`SELECT 1 FROM books b WHERE ${condition} LIMIT 1`).get({ tag: tagFilterValue(c, tag) });
  if (!any) {
    const similar = c.db.prepare(`
      SELECT DISTINCT t.value FROM books b, json_each(b.tags) t WHERE instr(lower(t.value), lower(?)) > 0 ORDER BY 1 LIMIT 10`)
      .pluck().all(tag.split(".").at(-1)) as string[];
    throw new ToolError(`No book is tagged "${tag}".${similar.length ? ` Similar tags: ${similar.join(", ")}.` : " See list_tags."}`);
  }
  return condition;
}

function bookSummary(book: BookRow, pin: PinnedCitekey | undefined, shelves: string[] = []) {
  return {
    book_id: book.id,
    title: book.title,
    authors: JSON.parse(book.authors) as string[],
    shelves,
    tags: JSON.parse(book.tags) as string[],
    year: book.year,
    ...(book.year === null && book.printed_year !== null ? { printed_year: book.printed_year } : {}),
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

export interface SearchArgs {
  query: string; book_id?: string; library?: string; shelf?: string; tag?: string; author?: string; limit?: number; advanced?: boolean;
}

export function searchCorpus(c: Corpus, args: SearchArgs) {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const match = args.advanced ? args.query : toFtsQuery(args.query);
  const bookId = args.book_id ? getBook(c, args.book_id).id : undefined;
  const where = ["passages_fts MATCH @match", "b.status = 'indexed'"];
  if (bookId) where.push("b.id = @book_id");
  if (args.library) where.push("b.library = @library");
  if (args.shelf) where.push(shelfFilter(c, args.shelf));
  if (args.tag) where.push(tagFilter(c, args.tag));
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
      match, book_id: bookId, library: args.library, shelf: args.shelf, tag: args.tag && tagFilterValue(c, args.tag),
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
      // "location" pages are positions in a reflowable book, not citable page numbers.
      page_kind: row.reflowable ? "location" : "pdf_page",
      page_label: row.label,
      section: row.section_path,
      snippet: row.snippet,
    });
    if (results.length === limit) break;
  }
  return { query: match, count: results.length, results };
}

export interface ListArgs { query?: string; library?: string; shelf?: string; tag?: string; include_unindexed?: boolean; limit?: number }

export function listBooks(c: Corpus, args: ListArgs) {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
  const pins = allPinned(c.data);
  const query = args.query?.toLowerCase();
  // Pinned keys live in data.db, so match them here and pass the UUIDs into the index query.
  const pinnedMatches = query ? [...pins.values()].filter((p) => p.citekey.includes(query)).map((p) => p.calibre_uuid) : [];
  const where: string[] = [];
  if (!args.include_unindexed) where.push("status = 'indexed'");
  if (args.library) where.push("library = @library");
  if (args.shelf) where.push(shelfFilter(c, args.shelf));
  if (args.tag) where.push(tagFilter(c, args.tag));
  if (query) {
    where.push(`(title LIKE @q OR authors LIKE @q OR tags LIKE @q OR isbn LIKE @q OR publisher LIKE @q OR id = @exact
      OR calibre_citekey LIKE @q OR proposed_citekey LIKE @q OR uuid IN (SELECT value FROM json_each(@pinned)))`);
  }
  const rows = c.db.prepare(`
    SELECT * FROM books b ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY title COLLATE NOCASE, id LIMIT @limit`).all({
    library: args.library, shelf: args.shelf, tag: args.tag && tagFilterValue(c, args.tag), q: query ? `%${query}%` : undefined,
    exact: args.query, limit,
    pinned: JSON.stringify(pinnedMatches),
  }) as BookRow[];
  const shelves = shelvesByBook(c, rows.map((b) => b.id));
  const copies = c.db.prepare<[string, string], string>("SELECT id FROM books WHERE sha256 = ? AND id != ?").pluck();
  return {
    count: rows.length,
    books: rows.map((b) => ({
      ...bookSummary(b, b.uuid ? pins.get(b.uuid) : undefined, shelves.get(b.id)),
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
    ...bookSummary(book, pinnedByUuid(c.data, book.uuid), shelvesByBook(c, [book.id]).get(book.id)),
    outline: outline.map((o) => ({
      level: o.level,
      title: o.title,
      page: o.start_page === null ? null : o.start_page + 1,
      ...(book.reflowable ? {} : { page_label: o.label }),
    })),
    ...(outline.length ? {} : { note: "This book has no outline. Read it by page range, or search within it with search_corpus." }),
  };
}

/** Calibre-Web's public shelves, with how many indexed books each holds. */
export function listShelves(c: Corpus) {
  const shelves = c.db.prepare(`
    SELECT s.name, COUNT(bs.book_id) AS books,
           COUNT(CASE WHEN b.status = 'indexed' THEN 1 END) AS indexed_books
    FROM shelves s LEFT JOIN book_shelves bs ON bs.shelf_id = s.id LEFT JOIN books b ON b.id = bs.book_id
    GROUP BY s.id ORDER BY s.name`).all();
  const exportedAt = c.db.prepare("SELECT value FROM meta WHERE key = 'shelves_exported_at'").pluck().get();
  return { exported_at: exportedAt ?? null, shelves };
}

interface TagNode { name: string; tag: string; label?: string; books: number; children: TagNode[] }

export interface ListTagsArgs { under?: string; min_books?: number }

/**
 * Calibre tags (Calibre-Web's "Categories") on indexed books as a tree, split on ".". A node's
 * `books` counts books carrying that tag or any tag below it.
 */
export function listTags(c: Corpus, args: ListTagsArgs = {}) {
  const rows = c.db.prepare(`
    SELECT b.id, t.value AS tag FROM books b, json_each(b.tags) t WHERE b.status = 'indexed'`).all() as { id: string; tag: string }[];
  const root: TagNode = { name: "", tag: "", books: 0, children: [] };
  const booksAt = new Map<TagNode, Set<string>>();
  for (const { id, tag } of rows) {
    let node = root;
    const parts = tag.split(".").map((p) => p.trim()).filter(Boolean);
    parts.forEach((part, i) => {
      let child = node.children.find((n) => n.name.toLowerCase() === part.toLowerCase());
      if (!child) {
        child = { name: part, tag: parts.slice(0, i + 1).join("."), books: 0, children: [] };
        node.children.push(child);
      }
      if (!booksAt.has(child)) booksAt.set(child, new Set());
      booksAt.get(child)!.add(id);
      node = child;
    });
  }
  const minBooks = args.min_books ?? 1;
  const finish = (node: TagNode): TagNode => ({
    name: node.name, tag: node.tag,
    ...(c.vocabulary.labelFor(node.tag) ? { label: c.vocabulary.labelFor(node.tag) } : {}),
    books: booksAt.get(node)?.size ?? 0,
    children: node.children.map(finish).filter((n) => n.books >= minBooks).sort((a, b) => a.name.localeCompare(b.name)),
  });
  let top = finish(root).children;
  if (args.under) {
    const path = c.vocabulary.toSlugPath(args.under).split(".").map((p) => p.trim().toLowerCase());
    let nodes = top;
    let found: TagNode | undefined;
    for (const part of path) {
      found = nodes.find((n) => n.name.toLowerCase() === part);
      if (!found) throw new ToolError(`No tag "${args.under}". See list_tags without "under".`);
      nodes = found.children;
    }
    top = [found!];
  }
  return {
    note: "Calibre tags, shown as Categories in Calibre-Web. \".\" nests them; filtering by a tag includes the tags below it. Vocabulary tags are term ids, with their title paths in label.",
    tags: top,
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
    const kind = book.reflowable ? "location" : "page";
    const header = `--- ${kind} ${page.page_index + 1}${page.label ? ` (printed ${page.label})` : ""}${page.section_path ? ` · ${page.section_path}` : ""} ---`;
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
  const note = book.reflowable
    ? `\n[${book.format?.toUpperCase()}: these are reading locations, not page numbers; cite this book by chapter.]`
    : "";
  return `${book.title} (${book.id})${note}\n\n${parts.join("\n\n")}${continuation}`;
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

/** Joins names "A", "A and B", "A, B, and C": the legacy `citation` field only. */
function joinAuthors(authors: string[]): string | undefined {
  if (authors.length === 0) return undefined;
  if (authors.length <= 2) return authors.join(" and ");
  return `${authors.slice(0, -1).join(", ")}, and ${authors.at(-1)}`;
}

export interface CslItem {
  id: string; "citation-key"?: string; type: "book"; title: string; author?: CslName[]; publisher?: string;
  issued?: { "date-parts": number[][] }; ISBN?: string;
}

/**
 * The year to cite: Calibre's, or when Calibre has none, the year the book prints on its copyright page
 * (src/years.ts), with where it came from.
 */
export function bookYear(book: Pick<BookRow, "year" | "printed_year">): { year: number | null; year_source: "calibre" | "printed" | null } {
  if (book.year) return { year: book.year, year_source: "calibre" };
  if (book.printed_year) return { year: book.printed_year, year_source: "printed" };
  return { year: null, year_source: null };
}

/** The years the book's own text prints, found at index time. */
export function printedYears(book: Pick<BookRow, "printed_years">): YearCandidate[] {
  return book.printed_years ? (JSON.parse(book.printed_years) as YearCandidate[]) : [];
}

/** The author and title candidates read from the book's own pages, found at index time. */
export function titlePageScan(book: Pick<BookRow, "title_page">): TitlePageScan {
  return book.title_page ? (JSON.parse(book.title_page) as TitlePageScan) : { authors: [], title: null };
}

/**
 * Where a book's author stands: in Calibre; missing there but printed in the book; missing in both; or
 * several people in one Calibre author record.
 */
export type AuthorState = "calibre" | "printed" | "none" | "merged";
export function authorState(book: Pick<BookRow, "citekey_blockers" | "title_page">): AuthorState {
  const blockers = JSON.parse(book.citekey_blockers) as string[];
  if (blockers.includes("merged_authors")) return "merged";
  if (!blockers.includes("unknown_author")) return "calibre";
  return titlePageScan(book).authors.length ? "printed" : "none";
}

/** The book as a CSL JSON item; empty fields are left out. */
export function cslItem(book: BookRow, citekey: string | null): CslItem {
  const names = calibreNames(JSON.parse(book.authors) as string[], JSON.parse(book.author_sorts) as string[]);
  const isbn = book.isbn ? validIsbn(book.isbn) : null;
  return {
    id: citekey ?? `calibre:${book.uuid ?? book.id}`,
    ...(citekey ? { "citation-key": citekey } : {}),
    type: "book",
    title: book.title,
    ...(names.length ? { author: names } : {}),
    ...(book.publisher ? { publisher: book.publisher } : {}),
    ...(bookYear(book).year ? { issued: { "date-parts": [[bookYear(book).year!]] } } : {}),
    ...(isbn ? { ISBN: isbn } : {}),
  };
}

const BLOCKER_FIXES: Record<CitekeyBlocker, string> = {
  unknown_author: "Calibre has no author for this book.",
  merged_authors: "One Calibre author record names several people (Calibre shows commas inside a name as \"|\"). Split it into separate authors in Calibre.",
  no_year: "Calibre has no publication year for this book.",
  malformed: "The proposed citekey is malformed; check the author and title in Calibre.",
};

/** The ISBNs the book's own text prints, found at index time. */
export function printedIsbns(book: BookRow): IsbnCandidate[] {
  return book.printed_isbns ? (JSON.parse(book.printed_isbns) as IsbnCandidate[]) : [];
}

/** Legacy: the filing calls the first CSL release still returns, until consumers switch to bibtex and isbn. */
interface LegacyFiling { tool: "file_zotero_reference"; arguments: { bibtex: string } | { isbn: string }; source: "calibre-metadata" | "isbn-lookup" }

export interface CiteArgs { book_id: string; page?: number; end_page?: number }

/**
 * A book's citation as a CSL JSON item, with a CSL locator for a page range (null when the pages are
 * reading locations, not citable pages), the reading position, and plain filing data: a BibTeX entry
 * from Calibre's metadata, a check-digit-valid ISBN, and printed ISBN candidates when Calibre has none.
 */
export function citePassage(c: Corpus, args: CiteArgs) {
  const book = getBook(c, args.book_id);
  const authors = JSON.parse(book.authors) as string[];
  const pin = pinnedByUuid(c.data, book.uuid);
  const keys = citekeyInfo(book, pin);
  const filingKey = keys.citekey ?? (keys.citekey_blockers.length ? null : book.proposed_citekey);
  const csl = cslItem(book, filingKey);
  // Legacy shape, kept for one release.
  const citation: Record<string, string> = { title: book.title };
  const author = joinAuthors(authors.filter((a) => a !== "Unknown"));
  if (author) citation.author = author;
  if (book.publisher) citation.publisher = book.publisher;
  const { year, year_source: yearSource } = bookYear(book);
  if (year) citation.year = String(year);

  let locator: { label: "page"; locator: string } | null = null;
  let position: Record<string, unknown> | null = null;
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
      locator = { label: "page", locator: a === b ? a : `${a}-${b}` };
      citation.pages = locator.locator;
      if (!first.label) warnings.push("This PDF has no printed page labels; pages are physical page numbers.");
    } else {
      warnings.push("EPUB and MOBI locations are not page numbers, so there is no locator. Name the chapter (position.section) in the text if it matters.");
    }
    position = {
      page: args.page, end_page: end, page_kind: book.reflowable ? "location" : "page", section: first.section_path,
      ...(book.reflowable ? {} : { page_label: first.label, end_page_label: last.label }),
    };
  }
  if (!book.publisher) warnings.push("Calibre has no publisher for this book.");

  const bibtex = filingKey ? bookBibtex({
    citekey: filingKey, title: book.title, authors, authorSorts: JSON.parse(book.author_sorts) as string[],
    publisher: book.publisher, year, isbn: book.isbn, calibreUuid: book.uuid,
  }) : null;
  const isbn = book.isbn ? validIsbn(book.isbn) : null;
  // Candidates only: copyright pages often list several editions, and the right one is the edition held.
  const isbnCandidates = isbn ? [] : printedIsbns(book);
  const printed = yearSource === "printed" ? printedYears(book).find((y) => y.year === year && y.kind !== "reprint") : undefined;
  const result = {
    csl, locator, position, ...keys, bibtex, isbn, isbn_candidates: isbnCandidates, year_source: yearSource,
    ...(printed ? { year_evidence: { page: printed.page, page_label: printed.page_label, context: printed.context } } : {}), citation,
  };
  if (printed) {
    warnings.push(`Calibre has no publication year; ${year} is from the book's own text (${printed.position === "back" ? "back page" : "page"} ${printed.page}: "${printed.context}"). Check it, and add it in Calibre.`);
  }
  if (keys.citekey_source === "pinned") return { ...result, warnings };

  if (!bibtex) warnings.push(...keys.citekey_blockers.map((b) => BLOCKER_FIXES[b]));
  if (!isbn && book.isbn) warnings.push(`Calibre's ISBN "${book.isbn}" fails its check digit, so it is left out. Correct it in Calibre.`);
  if (!isbn && isbnCandidates.length) {
    warnings.push(`Calibre has no valid ISBN, but the book prints ${isbnCandidates.length} (isbn_candidates). Confirm the one for this edition (the file is ${book.format?.toUpperCase()}) before using it, and add it to Calibre. ISBNs in the last pages (position "back") are often adverts for other books.`);
  }
  if (!bibtex && !isbn) warnings.push("There is no BibTeX entry or valid ISBN to file this book with yet. Fix the metadata in Calibre.");
  const zoteroFiling: LegacyFiling[] = [
    ...(bibtex ? [{ tool: "file_zotero_reference" as const, source: "calibre-metadata" as const, arguments: { bibtex } }] : []),
    ...(isbn ? [{ tool: "file_zotero_reference" as const, source: "isbn-lookup" as const, arguments: { isbn } }] : []),
  ];
  return { ...result, zotero_filing: zoteroFiling, warnings };
}

export interface PinArgs { book_id: string; citekey: string; replace?: boolean }

/** Records a citekey assigned elsewhere (when the book was filed in a reference manager), against the book's Calibre UUID. */
export function pinCitekey(c: Corpus, args: PinArgs, pinnedBy?: string, source: "agent" | "admin" | "zotero" = "agent") {
  const book = getBook(c, args.book_id);
  if (!book.uuid) throw new ToolError(`${book.id} has no Calibre UUID, so its citekey cannot be pinned.`);
  // Kept as given: another project's keys may use capitals (Better BibTeX's nyeFuturePower2011). Lookups ignore case.
  const citekey = args.citekey.trim();
  if (!BIBTEX_KEY.test(citekey)) {
    throw new ToolError(`"${args.citekey}" is not a BibTeX key: use letters, digits, and _ : . + - only.`);
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
  if (book.calibre_citekey && book.calibre_citekey !== citekey.toLowerCase()) {
    warnings.push(`Calibre's citekey identifier "${book.calibre_citekey}" overrides this pin until it is removed in Calibre.`);
  }
  const metadata = { title: book.title, authors: JSON.parse(book.authors) as string[], authorSorts: JSON.parse(book.author_sorts) as string[], publisher: book.publisher, year: bookYear(book).year };
  const preset = c.citekeyPreset ?? DEFAULT_PRESET;
  if (!followsRule(citekey, metadata, preset)) {
    warnings.push(`"${citekey}" does not follow this server's citekey rule (${preset}; proposed "${book.proposed_citekey ?? ""}"). Pinned as given.`);
  }
  const proposed = book.proposed_citekey;
  const lower = citekey.toLowerCase();
  const suffixed = proposed && lower.length === proposed.length + 1 && lower.startsWith(proposed);
  if (proposed && lower !== proposed && !suffixed) {
    warnings.push(`The proposed citekey was "${book.proposed_citekey}". Pinned "${citekey}" as given.`);
  }
  const pinnedAt = new Date().toISOString();
  c.data.prepare(`
    INSERT INTO citekeys (calibre_uuid, citekey, book_id, title, pinned_at, pinned_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (calibre_uuid) DO UPDATE SET citekey = excluded.citekey, book_id = excluded.book_id,
      title = excluded.title, pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by`)
    .run(book.uuid, citekey, book.id, book.title, pinnedAt, pinnedBy ?? null);
  recordChanges(c.data, [{
    kind: "citekey_pinned", source, book_id: book.id, calibre_uuid: book.uuid, title: book.title,
    detail: existing ? `${existing.citekey} → ${citekey}` : citekey, actor: pinnedBy ?? null,
  }]);
  return { status: existing ? "replaced" : "pinned", book_id: book.id, citekey, previous: existing?.citekey, pinned_at: pinnedAt, warnings };
}

/** Removes a book's pinned citekey (the admin book page); its key no longer resolves to the book. */
export function unpinCitekey(c: Corpus, bookId: string, by: string) {
  const book = getBook(c, bookId);
  const pin = pinnedByUuid(c.data, book.uuid);
  if (!pin) throw new ToolError(`${book.id} has no pinned citekey.`);
  c.data.prepare("DELETE FROM citekeys WHERE calibre_uuid = ?").run(pin.calibre_uuid);
  recordChanges(c.data, [{
    kind: "citekey_unpinned", source: "admin", book_id: book.id, calibre_uuid: book.uuid, title: book.title, detail: pin.citekey, actor: by,
  }]);
  return { status: "unpinned", book_id: book.id, citekey: pin.citekey };
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
    printed_years: printedYearReport(c),
    title_pages: titlePageReport(c),
    tags: tagHygiene(c),
  };
}

/**
 * Why a tag is probably not a subject (a BISAC code, a publisher's name, a status or format, a
 * description pasted into the tag field), or null. Vocabulary tags are never suspect.
 */
export function suspectTagReason(c: Corpus): (tag: string) => string | null {
  const publishers = (c.db.prepare("SELECT DISTINCT lower(publisher) FROM books WHERE publisher IS NOT NULL").pluck().all() as string[]);
  return (tag) => {
    const lower = tag.toLowerCase();
    if (c.vocabulary.has(tag)) return null;
    if (/^[A-Z]{3}\d{6}\b/.test(tag)) return "BISAC subject code";
    // A publisher's name, or two or more words of one ("Pragmatic Bookshelf" against "The Pragmatic
    // Bookshelf, LLC"). One word alone must match exactly: "Minnesota" is a subject even though the
    // publisher is "Minnesota Department of Natural Resources".
    const multiWord = /\s/.test(lower.trim());
    if (publishers.some((p) => p === lower || (multiWord && p.includes(lower)))) return "publisher name";
    if (/\b(?:MEAP|sample|review copy|draft|v\d+(?:\.\d+)?|ebook|kindle)\b/i.test(tag)) return "status or format, not a subject";
    // Library of Congress subject headings ("Russia -- Social life and customs -- Fiction") are subjects.
    if (tag.length > 40 && !tag.includes(".") && !tag.includes(" -- ")) return "reads like a description";
    return null;
  };
}

/**
 * A calibre-tags.sh plan removing suspect tags (see suspectTagReason), plus any tags named in `also`,
 * from every book in the library that carries them.
 */
export function tagCleanupPlan(c: Corpus, library: string, also: string[] = []) {
  const reason = suspectTagReason(c);
  const extra = new Set(also.map((t) => t.toLowerCase()));
  const books = c.db.prepare("SELECT * FROM books WHERE library = ? AND uuid IS NOT NULL AND tags != '[]' ORDER BY id").all(library) as BookRow[];
  const plan = [];
  for (const b of books) {
    const remove = (JSON.parse(b.tags) as string[]).filter((t) => reason(t) || extra.has(t.toLowerCase()));
    if (remove.length) plan.push({ calibre_id: Number(b.id.split(":")[1]), uuid: b.uuid!, title: b.title, remove });
  }
  return { library, generated_at: new Date().toISOString(), books: plan };
}

/** Tags that are probably not subjects: BISAC codes, publisher names, statuses, descriptions, one-offs. */
function tagHygiene(c: Corpus) {
  const tags = c.db.prepare(`
    SELECT t.value AS tag, COUNT(*) AS books FROM books b, json_each(b.tags) t WHERE b.status = 'indexed' GROUP BY 1`)
    .all() as { tag: string; books: number }[];
  const reason = suspectTagReason(c);
  const suspect = tags.map((t) => ({ ...t, reason: reason(t.tag) })).filter((t) => t.reason)
    .sort((a, b) => b.books - a.books || a.tag.localeCompare(b.tag));
  return {
    note: "Calibre tags (Categories in Calibre-Web). Fix or remove suspect tags in Calibre-Web.",
    tagged_books: c.db.prepare("SELECT COUNT(*) FROM books WHERE status = 'indexed' AND tags != '[]'").pluck().get(),
    distinct: tags.length,
    used_once: tags.filter((t) => t.books === 1).length,
    hierarchical: tags.filter((t) => t.tag.includes(".")).length,
    suspect: suspect.slice(0, 50),
    ...(suspect.length > 50 ? { suspect_truncated: suspect.length - 50 } : {}),
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

/** Books Calibre has no year for whose text prints one: the year citations use, to confirm and add in Calibre. */
function printedYearReport(c: Corpus) {
  const books = c.db.prepare("SELECT * FROM books WHERE status = 'indexed' AND year IS NULL ORDER BY id").all() as BookRow[];
  const found = books.filter((b) => b.printed_year !== null).map((b) => {
    const from = printedYears(b).find((y) => y.year === b.printed_year && y.kind !== "reprint")!;
    return { book_id: b.id, title: b.title, year: b.printed_year, kind: from.kind, page: from.page, position: from.position, context: from.context };
  });
  return {
    note: "Calibre has no publication year for these books, but their text prints one, which citations and proposed citekeys use. Confirm it and add it in Calibre.",
    books_without_year: books.length,
    books_printing_year: found.length,
    books: found.slice(0, 100),
    ...(found.length > 100 ? { books_truncated: found.length - 100 } : {}),
  };
}

/**
 * Books whose Calibre author is missing or merged, or whose title is a file name, with the authors and
 * title their own pages print: candidates to confirm and fix in Calibre. Never used in citations.
 */
function titlePageReport(c: Corpus) {
  const books = c.db.prepare("SELECT * FROM books WHERE status = 'indexed' ORDER BY id").all() as BookRow[];
  const counts = { unknown_author: 0, unknown_author_found: 0, merged_authors: 0, merged_authors_found: 0, mangled_titles: 0, mangled_titles_found: 0 };
  const found = [];
  for (const b of books) {
    const state = authorState(b);
    const scan = titlePageScan(b);
    const mangled = mangledTitle(b.title);
    if (state === "printed" || state === "none") counts.unknown_author++;
    if (state === "printed") counts.unknown_author_found++;
    if (state === "merged") counts.merged_authors++;
    if (state === "merged" && scan.authors.length) counts.merged_authors_found++;
    if (mangled) counts.mangled_titles++;
    if (mangled && scan.title) counts.mangled_titles_found++;
    const authors = state === "printed" || state === "merged" ? scan.authors : [];
    const title = mangled ? scan.title : null;
    if (authors.length || title) {
      found.push({
        book_id: b.id, title: b.title, calibre_authors: JSON.parse(b.authors) as string[],
        authors: authors.map((a) => ({ name: a.name, from: a.sources, page: a.page })), printed_title: title?.title ?? null,
      });
    }
  }
  return {
    note: "Authors and titles printed in these books, where Calibre has no author, several people in one author record, or a file name for a title. Candidates only: confirm them and fix Calibre.",
    ...counts,
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
  let printedYear = 0;
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
      if (bookYear(b).year_source === "printed") printedYear++;
      byProposed.set(b.proposed_citekey!, [...(byProposed.get(b.proposed_citekey!) ?? []), b.id]);
    }
  }
  return {
    note: "Books need a citekey to be filed in Zotero from their Calibre metadata. Fix blocked books in Calibre.",
    pinned,
    calibre_identifier: calibre,
    ready_to_file: ready,
    // Ready only because the copyright page gives the year Calibre lacks (see printed_years).
    ready_with_printed_year: printedYear,
    blocked,
    proposed_collisions: [...byProposed].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, books: ids })),
    blocked_books: blockedBooks.slice(0, 100),
    ...(blockedBooks.length > 100 ? { blocked_books_truncated: blockedBooks.length - 100 } : {}),
  };
}
