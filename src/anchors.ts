import { randomUUID } from "node:crypto";
import { type DataStore, pinnedByKey } from "./data.js";
import type { DB } from "./db.js";
import { type HoldingsBook, hasText, holdingsBook, holdingsBookRows } from "./holdings.js";
import { CONTEXT, MAX_QUOTE, type QuoteAnchor, find, locate, pagesOf, suggestions } from "./quotes.js";
import type { BookRow, Corpus } from "./tools.js";

/**
 * Verify and anchors for quote-mcp (docs/dev-briefs/holdings-and-quotes.md §2, shapes agreed with
 * quote-mcp). quote-mcp owns the quote; corpus-mcp checks it against the book's text (POST /api/verify),
 * keeps where it is (POST and DELETE /api/anchors), and finds it again after a rescan, numbering every
 * change so quote-mcp can follow them (GET /api/anchors/changes). An anchor's wording is kept only to
 * find it again.
 */

/** An anchor as the API sends it. Pages are 0-based indices into the stored pages: opaque to callers. */
export interface Anchor {
  calibre_uuid: string; sha256: string | null;
  start_page: number; start_offset: number; end_page: number; end_offset: number;
  page_label: string | null; end_page_label: string | null; section: string | null;
  prefix: string; suffix: string; text: string;
}

interface AnchorRow {
  quote_id: number; calibre_uuid: string; book_id: string; sha256: string | null;
  start_page: number; start_offset: number; end_page: number; end_offset: number;
  page_label: string | null; end_page_label: string | null; section_path: string | null;
  prefix: string; suffix: string; text: string; status: "verified" | "orphaned"; created_at: string; updated_at: string;
}

type ChangeKind = "stored" | "replaced" | "reanchored" | "orphaned" | "found" | "deleted";

/** An answer for the HTTP layer: a status and a JSON body (none for 204). */
export interface ApiAnswer { status: number; body?: unknown }

const BOOK_ID = /^[^:\s]+:\d+$/;
const ZOTERO_KEY = /^zotero:((?:users|groups)\/\d+)\/([A-Za-z0-9]+)$/;

export interface AnchorOptions { excludeTags: string[]; zoteroLibrary?: string }

/**
 * The books a key names: a book id, `zotero:<library>/<key>` (the books matched to that item), a Calibre
 * UUID, or a citekey (Calibre's, then a pinned one, then a proposed one).
 */
function booksFor(c: Corpus, o: AnchorOptions, key: string): BookRow[] {
  const rows = (where: string, ...args: unknown[]) => holdingsBookRows(c, o.excludeTags, where, ...args);
  if (BOOK_ID.test(key)) return rows("id = ?", key);
  const zotero = key.match(ZOTERO_KEY);
  if (zotero) {
    if (!o.zoteroLibrary || zotero[1] !== o.zoteroLibrary) return [];
    return rows("1").filter((b) => holdingsBook(c, b, o.zoteroLibrary).zotero?.key === zotero[2]);
  }
  const byUuid = rows("uuid = ? COLLATE NOCASE", key);
  if (byUuid.length) return byUuid;
  const citekey = key.toLowerCase();
  const calibre = rows("calibre_citekey = ?", citekey);
  if (calibre.length) return calibre;
  const pinned = pinnedByKey(c.data, citekey);
  if (pinned) return rows("uuid = ?", pinned.calibre_uuid);
  return rows("proposed_citekey = ?", citekey);
}

function labels(db: DB, bookId: string) {
  const page = db.prepare<[string, number], { label: string | null; section_path: string | null }>("SELECT label, section_path FROM pages WHERE book_id = ? AND page_index = ?");
  return (n: number) => page.get(bookId, n);
}

/** A printed page or range ("p. 211–212"); null without printed page labels (an EPUB's locations). */
function locator(start: string | null, end: string | null): string | null {
  return start ? `p. ${start}${end && end !== start ? `–${end}` : ""}` : null;
}

function anchorOf(c: Corpus, book: BookRow, a: QuoteAnchor): Anchor {
  const label = labels(c.db, book.id);
  const s = label(a.start_page);
  const e = label(a.end_page);
  return {
    calibre_uuid: book.uuid!, sha256: book.sha256,
    start_page: a.start_page, start_offset: a.start_offset, end_page: a.end_page, end_offset: a.end_offset,
    page_label: s?.label ?? null, end_page_label: e?.label ?? null, section: s?.section_path ?? null,
    prefix: a.prefix, suffix: a.suffix, text: a.text,
  };
}

const fromRow = (r: AnchorRow): Anchor => ({
  calibre_uuid: r.calibre_uuid, sha256: r.sha256, start_page: r.start_page, start_offset: r.start_offset, end_page: r.end_page,
  end_offset: r.end_offset, page_label: r.page_label, end_page_label: r.end_page_label, section: r.section_path,
  prefix: r.prefix, suffix: r.suffix, text: r.text,
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (error: string): ApiAnswer => ({ status: 400, body: { error } });

/** POST /api/verify: is this text in this book, and where? save_quote's check, without the save. */
export function verifyPassage(c: Corpus, o: AnchorOptions, body: unknown): ApiAnswer {
  if (!isObject(body)) return bad("Send { book, text, page? }.");
  const key = typeof body.book === "string" ? body.book.trim() : "";
  const wanted = typeof body.text === "string" ? body.text.trim() : "";
  if (!key) return bad("Send the book: a book id, citekey, Calibre UUID, or zotero:<library>/<key>.");
  if (!wanted) return bad("Send the text to verify.");
  if (wanted.length > MAX_QUOTE) return bad(`Quotes are limited to ${MAX_QUOTE} characters; this one has ${wanted.length}.`);
  if (body.page !== undefined && body.page !== null && !(Number.isInteger(body.page) && (body.page as number) >= 1)) return bad("page is a page number from 1.");
  const page = typeof body.page === "number" ? body.page - 1 : undefined;

  let books = booksFor(c, o, key);
  if (!books.length) return { status: 404, body: { error: "no-book" } };
  // Of two copies, the one with text is the one to check.
  if (books.length > 1 && books.filter(hasText).length === 1) books = books.filter(hasText);
  if (books.length > 1) return { status: 409, body: { error: "ambiguous", books: books.map((b) => holdingsBook(c, b, o.zoteroLibrary)) } };
  const book = books[0];
  const named: HoldingsBook = holdingsBook(c, book, o.zoteroLibrary);
  if (book.status !== "indexed" || !book.uuid) return { status: 404, body: { error: "no-text", book: named } };

  const found = find(c.db, book, page, wanted);
  if (!found) {
    // A book with too little text to judge by can't say the passage isn't there.
    if (!hasText(book)) return { status: 404, body: { error: "no-text", book: named } };
    const label = labels(c.db, book.id);
    const closest = suggestions(c, book, wanted).map((s) => {
      const l = label(s.page - 1);
      return { page: s.page, page_label: l?.label ?? null, section: l?.section_path ?? null, locator: locator(l?.label ?? null, null), snippet: s.snippet };
    });
    return { status: 200, body: { match: false, closest, book: named } };
  }
  const anchor = anchorOf(c, book, found);
  return {
    status: 200,
    body: {
      match: true, exact: wanted === anchor.text, text: anchor.text, locator: locator(anchor.page_label, anchor.end_page_label),
      page_label: anchor.page_label, section: anchor.section, anchor, book: named,
    },
  };
}

/** The anchor log's id: it changes only when the numbering starts again (a new data store). */
function logId(data: DataStore): string {
  const id = data.prepare("SELECT value FROM meta WHERE key = 'anchor_log'").pluck().get() as string | undefined;
  if (id) return id;
  const fresh = randomUUID();
  data.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('anchor_log', ?)").run(fresh);
  return data.prepare("SELECT value FROM meta WHERE key = 'anchor_log'").pluck().get() as string;
}

function recordChange(data: DataStore, quoteId: number, kind: ChangeKind, status: string | null, anchor: Anchor | null, at: string): void {
  logId(data);
  data.prepare("INSERT INTO anchor_changes (quote_id, kind, status, anchor, at) VALUES (?, ?, ?, ?, ?)")
    .run(quoteId, kind, status, anchor ? JSON.stringify(anchor) : null, at);
}

function writeAnchor(data: DataStore, quoteId: number, book: BookRow, a: Anchor, status: "verified" | "orphaned", at: string): void {
  data.prepare(`
    INSERT INTO anchors (quote_id, calibre_uuid, book_id, sha256, start_page, start_offset, end_page, end_offset, page_label, end_page_label,
      section_path, prefix, suffix, text, status, created_at, updated_at)
    VALUES (@quote_id, @calibre_uuid, @book_id, @sha256, @start_page, @start_offset, @end_page, @end_offset, @page_label, @end_page_label,
      @section, @prefix, @suffix, @text, @status, @at, @at)
    ON CONFLICT (quote_id) DO UPDATE SET calibre_uuid = excluded.calibre_uuid, book_id = excluded.book_id, sha256 = excluded.sha256,
      start_page = excluded.start_page, start_offset = excluded.start_offset, end_page = excluded.end_page, end_offset = excluded.end_offset,
      page_label = excluded.page_label, end_page_label = excluded.end_page_label, section_path = excluded.section_path,
      prefix = excluded.prefix, suffix = excluded.suffix, text = excluded.text, status = excluded.status, updated_at = excluded.updated_at`)
    .run({ quote_id: quoteId, book_id: book.id, ...a, status, at });
}

const sameAnchor = (a: Anchor, b: Anchor) => (Object.keys(a) as (keyof Anchor)[]).every((k) => a[k] === b[k]);

/**
 * POST /api/anchors: stores the anchor a verify returned, for a quote-mcp quote. It is checked against the
 * book first: the same file, and the same wording at those offsets. Storing the same anchor again is a no-op.
 */
export function storeAnchor(c: Corpus, body: unknown): ApiAnswer {
  if (!isObject(body) || !isObject(body.anchor)) return bad("Send { quote_id, anchor }.");
  const quoteId = body.quote_id;
  if (!Number.isSafeInteger(quoteId) || (quoteId as number) < 1) return bad("quote_id is quote-mcp's id, a positive integer.");
  const a = body.anchor;
  const int = (k: string) => Number.isSafeInteger(a[k]) && (a[k] as number) >= 0;
  if (typeof a.calibre_uuid !== "string" || typeof a.text !== "string" || !a.text || !["start_page", "start_offset", "end_page", "end_offset"].every(int)
    || (a.end_page as number) < (a.start_page as number)) {
    return bad("The anchor is malformed: post it back as /api/verify returned it.");
  }
  const book = c.db.prepare<[string], BookRow>("SELECT * FROM books WHERE uuid = ? AND status = 'indexed' ORDER BY id").get(a.calibre_uuid);
  if (!book) return { status: 404, body: { error: "no-book" } };
  const stale: ApiAnswer = { status: 409, body: { error: "stale-anchor" } };
  if (a.sha256 !== book.sha256) return stale;
  // The wording at those offsets, assembled as locate() assembles it; the context is the book's, not the caller's.
  const [from, to, start, end] = [a.start_page, a.end_page, a.start_offset, a.end_offset] as number[];
  const pages = pagesOf(c.db, book.id, from, to);
  if (pages.length !== to - from + 1 || start > pages[0].text.length || end > pages[pages.length - 1].text.length) return stale;
  const text = pages.map((p, n) => p.text.slice(n === 0 ? start : 0, n === pages.length - 1 ? end : p.text.length)).join("\n").trim();
  if (text !== a.text) return stale;
  const again: QuoteAnchor = {
    start_page: from, start_offset: start, end_page: to, end_offset: end, text,
    prefix: pages[0].text.slice(Math.max(0, start - CONTEXT), start), suffix: pages[pages.length - 1].text.slice(end, end + CONTEXT),
  };

  const anchor = anchorOf(c, book, again);
  const id = quoteId as number;
  const existing = c.data.prepare("SELECT * FROM anchors WHERE quote_id = ?").get(id) as AnchorRow | undefined;
  const answer = { quote_id: id, status: "verified", anchor };
  if (existing && existing.status === "verified" && sameAnchor(fromRow(existing), anchor)) return { status: 200, body: answer };
  const at = new Date().toISOString();
  c.data.transaction(() => {
    writeAnchor(c.data, id, book, anchor, "verified", at);
    recordChange(c.data, id, existing ? "replaced" : "stored", "verified", anchor, at);
  })();
  return existing ? { status: 200, body: { ...answer, replaced: true } } : { status: 201, body: answer };
}

/** DELETE /api/anchors/<quote_id>: the quote was deleted or moved off this book. */
export function deleteAnchor(c: Corpus, quoteId: number): ApiAnswer {
  const at = new Date().toISOString();
  const deleted = c.data.transaction(() => {
    if (!c.data.prepare("DELETE FROM anchors WHERE quote_id = ?").run(quoteId).changes) return false;
    recordChange(c.data, quoteId, "deleted", null, null, at);
    return true;
  })();
  return deleted ? { status: 204 } : { status: 404, body: { error: "no-anchor" } };
}

/** GET /api/anchors/changes?since=N: changes after N, oldest first, a page at a time. */
export function anchorChanges(c: Corpus, since: string | null, limit = 500): ApiAnswer {
  const after = since === null || since === "" ? 0 : Number(since);
  if (!Number.isSafeInteger(after) || after < 0) return bad("since is a change number from 0.");
  const log = logId(c.data);
  const rows = c.data.prepare("SELECT * FROM anchor_changes WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit) as
    { seq: number; quote_id: number; kind: ChangeKind; status: string | null; anchor: string | null; at: string }[];
  const last = rows.length ? rows[rows.length - 1].seq : ((c.data.prepare("SELECT MAX(seq) FROM anchor_changes").pluck().get() as number | null) ?? 0);
  return {
    status: 200,
    body: { log, changes: rows.map((r) => ({ ...r, anchor: r.anchor ? (JSON.parse(r.anchor) as Anchor) : null })), last },
  };
}

/**
 * After a scan, as reanchorQuotes does for corpus-mcp's own quotes: anchors whose book file changed are
 * found again by their wording (near the old place, then anywhere) or orphaned; an orphaned anchor is
 * tried again when its book's file changes again. Each outcome is a change quote-mcp follows.
 */
export function reanchorAnchors(db: DB, data: DataStore): { reanchored: number; orphaned: number; found: number } {
  const c = { db, data } as Corpus;
  const byUuid = db.prepare<[string], BookRow>("SELECT * FROM books WHERE uuid = ? AND status = 'indexed' ORDER BY id");
  const counts = { reanchored: 0, orphaned: 0, found: 0 };
  for (const r of data.prepare("SELECT * FROM anchors").all() as AnchorRow[]) {
    const book = byUuid.get(r.calibre_uuid);
    if (book && book.sha256 === r.sha256) continue;
    if (!book && r.status === "orphaned") continue;
    // Its own pages first, so words the book repeats keep the place they had; then nearby, then anywhere.
    const hit = book
      ? [[r.start_page, r.end_page], [r.start_page - 10, r.end_page + 10], [0, book.page_count ?? 0]]
        .reduce<QuoteAnchor | null>((found, [from, to]) => found ?? locate(pagesOf(db, book.id, from, to), r.text), null)
      : null;
    const at = new Date().toISOString();
    data.transaction(() => {
      if (hit && book) {
        const anchor = anchorOf(c, book, hit);
        writeAnchor(data, r.quote_id, book, anchor, "verified", at);
        const kind = r.status === "orphaned" ? "found" : "reanchored";
        recordChange(data, r.quote_id, kind, "verified", anchor, at);
        counts[kind]++;
      } else {
        // Remember which file it failed against, so the next scan doesn't search the same file again.
        data.prepare("UPDATE anchors SET status = 'orphaned', sha256 = ?, updated_at = ? WHERE quote_id = ?").run(book?.sha256 ?? r.sha256, at, r.quote_id);
        if (r.status !== "orphaned") {
          recordChange(data, r.quote_id, "orphaned", "orphaned", fromRow(r), at);
          counts.orphaned++;
        }
      }
    })();
  }
  return counts;
}
