import { type DataStore, recordChanges } from "./data.js";
import type { DB } from "./db.js";
import { type BookRow, type Corpus, ToolError, citePassage, getBook, toFtsQuery } from "./tools.js";

/**
 * Quotable excerpts. A quote is verified against the book's stored text when saved: the agent's or
 * person's text is matched loosely (Unicode forms, curly quotes, dashes, soft hyphens, spacing, then
 * case), and the book's exact wording is what gets stored, with an anchor that a re-index uses to find
 * it again. Quotes live in data.db; they are never deleted by a re-index, only marked orphaned.
 */

export const MAX_QUOTE = 2000;
const CONTEXT = 40;

const QUOTE_MARKS: [RegExp, string][] = [
  [/[‘’‚‛′ʼ]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, "-"],
  [/[   ]/g, " "],
  [/[­​-‍﻿]/g, ""],
];

/** A text in comparison form, with the original index of every comparison character. */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let ch = text[i].normalize("NFKC");
    for (const [pattern, replacement] of QUOTE_MARKS) ch = ch.replace(pattern, replacement);
    for (const c of ch) {
      if (/\s/.test(c)) {
        if (norm.length && norm[norm.length - 1] !== " ") {
          norm += " ";
          map.push(i);
        }
      } else {
        norm += c;
        map.push(i);
      }
    }
  }
  return { norm, map };
}

export function normalizeQuote(text: string): string {
  return normalizeWithMap(text).norm.trim();
}

/** Lower case that never changes the string's length, so a map built for one form fits the other. */
function lowerSameLength(text: string): string {
  let out = "";
  for (const c of text) {
    const lower = c.toLowerCase();
    out += lower.length === c.length ? lower : c;
  }
  return out;
}

interface PageText { page_index: number; label: string | null; section_path: string | null; text: string }

export interface QuoteAnchor { start_page: number; start_offset: number; end_page: number; end_offset: number; text: string; prefix: string; suffix: string }

/** Finds `needle` across consecutive pages; offsets are into each page's stored text. */
export function locate(pages: PageText[], needle: string): QuoteAnchor | null {
  const want = normalizeQuote(needle);
  if (!want) return null;
  let hay = "";
  const where: { page: number; offset: number }[] = [];
  pages.forEach((p, n) => {
    const { norm, map } = normalizeWithMap(p.text);
    if (n > 0 && hay.length && hay[hay.length - 1] !== " ") {
      hay += " ";
      where.push({ page: n - 1, offset: pages[n - 1].text.length });
    }
    hay += norm;
    for (const i of map) where.push({ page: n, offset: i });
  });
  let at = hay.indexOf(want);
  if (at < 0) at = lowerSameLength(hay).indexOf(lowerSameLength(want));
  if (at < 0) return null;
  const first = where[at];
  const last = where[at + want.length - 1];
  const start = { page: first.page, offset: first.offset };
  const end = { page: last.page, offset: last.offset + 1 };
  const parts: string[] = [];
  for (let n = start.page; n <= end.page; n++) {
    const t = pages[n].text;
    parts.push(t.slice(n === start.page ? start.offset : 0, n === end.page ? end.offset : t.length));
  }
  const startText = pages[start.page].text;
  const endText = pages[end.page].text;
  return {
    start_page: pages[start.page].page_index, start_offset: start.offset,
    end_page: pages[end.page].page_index, end_offset: end.offset,
    text: parts.join("\n").trim(),
    prefix: startText.slice(Math.max(0, start.offset - CONTEXT), start.offset),
    suffix: endText.slice(end.offset, end.offset + CONTEXT),
  };
}

function pagesOf(db: DB, bookId: string, from: number, to: number): PageText[] {
  return db.prepare("SELECT page_index, label, section_path, text FROM pages WHERE book_id = ? AND page_index BETWEEN ? AND ? ORDER BY page_index")
    .all(bookId, Math.max(0, from), to) as PageText[];
}

/**
 * The quote's place in the book, searched outward from the given page: that page, then a page either
 * side (a quote crossing a page break), then two pages either side, then pages the full-text index
 * suggests anywhere in the book.
 */
function find(db: DB, book: BookRow, page: number | undefined, text: string): QuoteAnchor | null {
  const tried = new Set<string>();
  const attempt = (from: number, to: number) => {
    const key = `${from}-${to}`;
    if (tried.has(key)) return null;
    tried.add(key);
    const pages = pagesOf(db, book.id, from, to);
    return pages.length ? locate(pages, text) : null;
  };
  if (page !== undefined) {
    for (const [from, to] of [[page, page], [page, page + 1], [page - 1, page], [page - 2, page + 2]]) {
      const hit = attempt(from, to);
      if (hit) return hit;
    }
  }
  const words = [...new Set(normalizeQuote(text).split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 3))]
    .sort((a, b) => b.length - a.length).slice(0, 4);
  if (!words.length) return null;
  const candidates = db.prepare(`
    SELECT DISTINCT x.page_index FROM passages_fts JOIN passages x ON x.id = passages_fts.rowid
    WHERE passages_fts MATCH ? AND x.book_id = ? ORDER BY bm25(passages_fts) LIMIT 6`).pluck().all(toFtsQuery(words.join(" ")), book.id) as number[];
  for (const q of candidates) {
    const hit = attempt(q - 1, q + 1);
    if (hit) return hit;
  }
  return null;
}

/** Passages near the given words, for a quote that could not be found as written. */
function suggestions(c: Corpus, book: BookRow, text: string) {
  const words = normalizeQuote(text).split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 3).slice(0, 8);
  if (!words.length) return [];
  return c.db.prepare(`
    SELECT x.page_index, snippet(passages_fts, 0, '«', '»', '…', 30) AS snippet FROM passages_fts JOIN passages x ON x.id = passages_fts.rowid
    WHERE passages_fts MATCH ? AND x.book_id = ? ORDER BY bm25(passages_fts) LIMIT 3`)
    .all(words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR "), book.id)
    .map((r) => ({ page: (r as { page_index: number }).page_index + 1, snippet: (r as { snippet: string }).snippet }));
}

interface QuoteRow {
  id: number; calibre_uuid: string; book_id: string; title: string; text: string; note: string | null; categories: string; labels: string;
  start_page: number; start_offset: number; end_page: number; end_offset: number; page_label: string | null; end_page_label: string | null;
  section_path: string | null; prefix: string; suffix: string; sha256: string | null; status: "verified" | "orphaned"; source: string;
  created_by: string | null; created_at: string; updated_by: string | null; updated_at: string | null;
}

function cleanLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((l) => l.trim()).filter(Boolean))].slice(0, 20);
}

function canonicalCategories(c: Corpus, categories: string[] | undefined): string[] {
  const out: string[] = [];
  const unknown: string[] = [];
  for (const cat of categories ?? []) {
    const hit = c.vocabulary.find(cat);
    if (!hit) unknown.push(cat);
    else if (!out.includes(hit.tag)) out.push(hit.tag);
  }
  if (unknown.length) throw new ToolError(`Not in the vocabulary: ${unknown.map((t) => `"${t}"`).join(", ")}. Use get_tag_vocabulary.`);
  return out;
}

/** The vocabulary tags the quote's book carries in Calibre now. */
function bookCategories(c: Corpus, uuid: string): string[] {
  const tags = c.db.prepare("SELECT tags FROM books WHERE uuid = ? ORDER BY id").pluck().get(uuid) as string | undefined;
  return tags ? (JSON.parse(tags) as string[]).filter((t) => c.vocabulary.has(t)) : [];
}

/**
 * A quote's categories: its own when it was given some (a departure from its book), otherwise its
 * book's, read at the time of asking, so re-categorizing a book carries its quotes along.
 */
export function effectiveCategories(c: Corpus, r: { categories: string; calibre_uuid: string }): { tags: string[]; inherited: boolean } {
  const own = JSON.parse(r.categories) as string[];
  return own.length ? { tags: own, inherited: false } : { tags: bookCategories(c, r.calibre_uuid), inherited: true };
}

function present(c: Corpus, r: QuoteRow) {
  const reflowable = c.db.prepare("SELECT reflowable FROM books WHERE uuid = ? ORDER BY id").pluck().get(r.calibre_uuid) as number | undefined;
  const cats = effectiveCategories(c, r);
  const withLabel = (t: string) => ({ tag: t, label: c.vocabulary.find(t)?.label ?? t });
  const locator = r.page_label
    ? `p. ${r.page_label}${r.end_page_label && r.end_page_label !== r.page_label ? `–${r.end_page_label}` : ""}`
    : r.section_path ?? (reflowable ? `location ${r.start_page + 1}` : `page ${r.start_page + 1}`);
  return {
    id: r.id, book_id: r.book_id, calibre_uuid: r.calibre_uuid, title: r.title, text: r.text, note: r.note,
    categories: cats.tags.map(withLabel),
    categories_inherited: cats.inherited,
    book_categories: bookCategories(c, r.calibre_uuid).map(withLabel),
    labels: JSON.parse(r.labels) as string[],
    page: r.start_page + 1, end_page: r.end_page + 1, page_label: r.page_label, end_page_label: r.end_page_label, section: r.section_path,
    locator, status: r.status, source: r.source, created_by: r.created_by, created_at: r.created_at, updated_by: r.updated_by, updated_at: r.updated_at,
  };
}

export interface SaveQuoteArgs { book_id: string; text: string; page?: number; note?: string; categories?: string[]; labels?: string[] }

/** Verifies and saves a quote. `page` (1-based) is where to look first; the whole book is searched if needed. */
export function saveQuote(c: Corpus, args: SaveQuoteArgs, by: string | undefined, source: "agent" | "admin") {
  const book = getBook(c, args.book_id);
  if (book.status !== "indexed") throw new ToolError(`${book.id} has no indexed text to quote.`);
  if (!book.uuid) throw new ToolError(`${book.id} has no Calibre UUID.`);
  const wanted = args.text.trim();
  if (!wanted) throw new ToolError("The quote is empty.");
  if (wanted.length > MAX_QUOTE) throw new ToolError(`Quotes are limited to ${MAX_QUOTE} characters; this one has ${wanted.length}.`);
  const categories = canonicalCategories(c, args.categories);
  const anchor = find(c.db, book, args.page !== undefined ? args.page - 1 : undefined, wanted);
  if (!anchor) {
    return { saved: false, reason: "The text was not found in this book as written.", closest: suggestions(c, book, wanted) };
  }
  const label = c.db.prepare<[string, number], { label: string | null; section_path: string | null }>("SELECT label, section_path FROM pages WHERE book_id = ? AND page_index = ?");
  const startPage = label.get(book.id, anchor.start_page);
  const endPage = label.get(book.id, anchor.end_page);
  const duplicate = c.data.prepare("SELECT id FROM quotes WHERE calibre_uuid = ? AND start_page = ? AND start_offset = ? AND end_page = ? AND end_offset = ?")
    .pluck().get(book.uuid, anchor.start_page, anchor.start_offset, anchor.end_page, anchor.end_offset) as number | undefined;
  if (duplicate) return { saved: false, reason: `This passage is already saved as quote ${duplicate}.`, id: duplicate };
  const now = new Date().toISOString();
  const id = Number(c.data.prepare(`
    INSERT INTO quotes (calibre_uuid, book_id, title, text, note, categories, labels, start_page, start_offset, end_page, end_offset,
      page_label, end_page_label, section_path, prefix, suffix, sha256, status, source, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?)`)
    .run(book.uuid, book.id, book.title, anchor.text, args.note?.trim() || null, JSON.stringify(categories), JSON.stringify(cleanLabels(args.labels)),
      anchor.start_page, anchor.start_offset, anchor.end_page, anchor.end_offset, startPage?.label ?? null, endPage?.label ?? null,
      startPage?.section_path ?? null, anchor.prefix, anchor.suffix, book.sha256, source, by ?? null, now).lastInsertRowid);
  recordChanges(c.data, [{ kind: "quote_saved", source, book_id: book.id, calibre_uuid: book.uuid, title: book.title, detail: `#${id} ${anchor.text.slice(0, 80)}`, actor: by ?? null }]);
  const quote = getQuote(c, id);
  return { saved: true, exact: normalizeQuote(wanted) === normalizeQuote(anchor.text) && wanted === anchor.text, quote };
}

function row(c: Corpus, id: number): QuoteRow {
  const r = c.data.prepare<[number], QuoteRow>("SELECT * FROM quotes WHERE id = ?").get(id);
  if (!r) throw new ToolError(`No quote ${id}.`);
  return r;
}

/** One quote, with the text around it and its citation. */
export function getQuote(c: Corpus, id: number) {
  const r = row(c, id);
  // The book it was saved from, or the same Calibre book under another id since.
  const book = c.db.prepare<{ id: string; uuid: string }, BookRow>("SELECT * FROM books WHERE id = @id OR uuid = @uuid ORDER BY id = @id DESC").get({ id: r.book_id, uuid: r.calibre_uuid });
  let before = r.prefix;
  let after = r.suffix;
  if (book && r.status === "verified") {
    const pages = pagesOf(c.db, book.id, r.start_page, r.end_page);
    const first = pages[0]?.text ?? "";
    const last = pages.at(-1)?.text ?? "";
    before = first.slice(Math.max(0, r.start_offset - 300), r.start_offset);
    after = last.slice(r.end_offset, r.end_offset + 300);
  }
  const citation = book ? citePassage(c, { book_id: book.id, page: r.start_page + 1, end_page: r.end_page + 1 }) : null;
  return { ...present(c, r), current_book_id: book?.id ?? null, context: { before, after }, citation: citation?.citation ?? null, citekey: citation?.citekey ?? null };
}

export interface QuoteQuery {
  q?: string; book?: string; author?: string; category?: string; label?: string; status?: string; by?: string; since?: string;
  limit?: number; offset?: number;
}

export function searchQuotes(c: Corpus, query: QuoteQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.q) { where.push("q.id IN (SELECT rowid FROM quotes_fts WHERE quotes_fts MATCH @match)"); params.match = toFtsQuery(query.q); }
  if (query.book) {
    const book = getBook(c, query.book);
    where.push("(q.calibre_uuid = @uuid OR q.book_id = @book)");
    params.uuid = book.uuid;
    params.book = book.id;
  }
  if (query.status) { where.push("q.status = @status"); params.status = query.status; }
  if (query.by) { where.push("lower(q.created_by) LIKE @by"); params.by = `%${query.by.toLowerCase()}%`; }
  if (query.since) { where.push("q.created_at >= @since"); params.since = query.since; }
  if (query.label) { where.push("EXISTS (SELECT 1 FROM json_each(q.labels) l WHERE lower(l.value) = lower(@label))"); params.label = query.label.trim(); }
  let rows = c.data.prepare(`SELECT q.* FROM quotes q ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY q.created_at DESC, q.id DESC`).all(params) as QuoteRow[];
  if (query.category) {
    // Matches the quote's effective categories (its own, or its book's), and everything below the one asked for.
    const slug = c.vocabulary.find(query.category)?.tag ?? c.vocabulary.toSlugPath(query.category).toLowerCase();
    rows = rows.filter((r) => effectiveCategories(c, r).tags.some((t) => t === slug || t.startsWith(`${slug}.`)));
  }
  if (query.author) {
    const author = query.author.toLowerCase();
    const byUuid = c.db.prepare<[string], { authors: string }>("SELECT authors FROM books WHERE uuid = ?");
    rows = rows.filter((r) => (byUuid.get(r.calibre_uuid)?.authors ?? "").toLowerCase().includes(author));
  }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const labels = c.data.prepare("SELECT DISTINCT l.value FROM quotes, json_each(quotes.labels) l ORDER BY 1").pluck().all();
  const counts = Object.fromEntries((c.data.prepare("SELECT status, COUNT(*) AS n FROM quotes GROUP BY status").all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  return { total: rows.length, counts, labels, quotes: rows.slice(offset, offset + limit).map((r) => present(c, r)) };
}

export interface UpdateQuoteArgs { id: number; note?: string | null; categories?: string[]; labels?: string[] }

/** Changes a quote's note, categories, or labels. The quoted text is fixed; save a new quote instead. */
export function updateQuote(c: Corpus, args: UpdateQuoteArgs, by: string | undefined, source: "agent" | "admin") {
  const r = row(c, args.id);
  const note = args.note === undefined ? r.note : args.note?.trim() || null;
  const categories = args.categories === undefined ? (JSON.parse(r.categories) as string[]) : canonicalCategories(c, args.categories);
  const labels = args.labels === undefined ? (JSON.parse(r.labels) as string[]) : cleanLabels(args.labels);
  c.data.prepare("UPDATE quotes SET note = ?, categories = ?, labels = ?, updated_by = ?, updated_at = ? WHERE id = ?")
    .run(note, JSON.stringify(categories), JSON.stringify(labels), by ?? null, new Date().toISOString(), r.id);
  recordChanges(c.data, [{ kind: "quote_edited", source, book_id: r.book_id, calibre_uuid: r.calibre_uuid, title: r.title, detail: `#${r.id}`, actor: by ?? null }]);
  return getQuote(c, r.id);
}

export function deleteQuote(c: Corpus, id: number, by: string | undefined, source: "agent" | "admin") {
  const r = row(c, id);
  c.data.prepare("DELETE FROM quotes WHERE id = ?").run(id);
  recordChanges(c.data, [{ kind: "quote_deleted", source, book_id: r.book_id, calibre_uuid: r.calibre_uuid, title: r.title, detail: `#${id} ${r.text.slice(0, 80)}`, actor: by ?? null }]);
  return { deleted: id };
}

/** The Concept Clusters citation for a quote, with the verified text to quote. */
export function citeQuote(c: Corpus, id: number) {
  const q = getQuote(c, id);
  if (!q.current_book_id) throw new ToolError(`Quote ${id}'s book is no longer in the index.`);
  const cite = citePassage(c, { book_id: q.current_book_id, page: q.page, end_page: q.end_page });
  return { quote: q.text, quote_locator: q.locator, ...cite };
}

/** Quotes on a range of pages of one book, with offsets for highlighting in the reader. */
export function quotesOnPages(c: Corpus, book: BookRow, from: number, to: number) {
  return (c.data.prepare(`
    SELECT * FROM quotes WHERE calibre_uuid = ? AND status = 'verified' AND start_page <= ? AND end_page >= ? ORDER BY start_page, start_offset`)
    .all(book.uuid, to, from) as QuoteRow[])
    .map((r) => ({ id: r.id, start_page: r.start_page + 1, start_offset: r.start_offset, end_page: r.end_page + 1, end_offset: r.end_offset, note: r.note }));
}

/**
 * After a scan: quotes whose book file changed are found again by their text (first near the old
 * place, then anywhere), or marked orphaned; quotes whose book left the index are orphaned too.
 */
export function reanchorQuotes(db: DB, data: DataStore): { reanchored: number; orphaned: number } {
  const quotes = data.prepare("SELECT * FROM quotes").all() as QuoteRow[];
  const byUuid = db.prepare<[string], BookRow>("SELECT * FROM books WHERE uuid = ? AND status = 'indexed' ORDER BY id");
  const label = db.prepare<[string, number], { label: string | null; section_path: string | null }>("SELECT label, section_path FROM pages WHERE book_id = ? AND page_index = ?");
  let reanchored = 0;
  let orphaned = 0;
  for (const q of quotes) {
    const book = byUuid.get(q.calibre_uuid);
    // Only a changed file (or a book that left the index) can move a quote; an orphaned quote is retried
    // when its book's file changes again, not on every scan.
    if (book && book.sha256 === q.sha256) continue;
    if (!book && q.status === "orphaned") continue;
    let anchor: QuoteAnchor | null = null;
    if (book) {
      anchor = locate(pagesOf(db, book.id, q.start_page - 10, q.end_page + 10), q.text)
        ?? locate(pagesOf(db, book.id, 0, book.page_count ?? 0), q.text);
    }
    const now = new Date().toISOString();
    if (anchor && book) {
      const s = label.get(book.id, anchor.start_page);
      const e = label.get(book.id, anchor.end_page);
      data.prepare(`UPDATE quotes SET book_id = ?, start_page = ?, start_offset = ?, end_page = ?, end_offset = ?, page_label = ?, end_page_label = ?,
        section_path = ?, prefix = ?, suffix = ?, sha256 = ?, status = 'verified', updated_at = ? WHERE id = ?`)
        .run(book.id, anchor.start_page, anchor.start_offset, anchor.end_page, anchor.end_offset, s?.label ?? null, e?.label ?? null,
          s?.section_path ?? null, anchor.prefix, anchor.suffix, book.sha256, now, q.id);
      recordChanges(data, [{ kind: "quote_reanchored", source: "calibre", book_id: book.id, calibre_uuid: q.calibre_uuid, title: q.title, detail: `#${q.id}` }]);
      reanchored++;
    } else {
      // Remember which file it failed against, so the next scan does not search the same file again.
      data.prepare("UPDATE quotes SET status = 'orphaned', sha256 = ?, updated_at = ? WHERE id = ?").run(book?.sha256 ?? q.sha256, now, q.id);
      if (q.status !== "orphaned") {
        recordChanges(data, [{ kind: "quote_orphaned", source: "calibre", book_id: q.book_id, calibre_uuid: q.calibre_uuid, title: q.title, detail: `#${q.id}` }]);
        orphaned++;
      }
    }
  }
  return { reanchored, orphaned };
}
