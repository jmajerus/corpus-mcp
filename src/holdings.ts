import { createHash } from "node:crypto";
import { pinnedByUuid } from "./data.js";
import { isbn13, validIsbn } from "./isbn.js";
import { type BookRow, type Corpus, effectiveCitekey, printedIsbns } from "./tools.js";
import { zoteroMatch } from "./zotero.js";

/**
 * The books feed for holdings-mcp (docs/dev-briefs/holdings-and-quotes.md §1): every indexed book with its
 * keys, as a snapshot with a strong ETag, so a poll that finds nothing new is a 304. Keys are real keys only,
 * as in the public key list: a Calibre or pinned citekey, else the matched Zotero item's; never a proposed
 * one. `zotero` is the item the book is matched to (confirmed, filed with the book's UUID, or the one item
 * with its ISBN), never a candidate a person hasn't confirmed. `isbns` is Calibre's ISBN when its check
 * digit holds, as digits with no hyphens; never one only seen printed in the book, which a person hasn't
 * confirmed either; those are `isbn_candidates`, a hint for a person to confirm, never a match. Books with
 * an excluded tag aren't sent.
 */

export const HOLDINGS_VERSION = 1;

export interface HoldingsBook {
  calibre_uuid: string | null;
  book_id: string;
  library: string;
  title: string;
  authors: string[];
  year: number | null;
  /** The format the index read; Calibre may hold others. */
  formats: string[];
  /** False for a book with no text layer (fewer than 20 characters a page). */
  has_text: boolean;
  isbns: string[];
  /**
   * ISBN-13s printed in the book's own text that aren't in `isbns`, front matter first; absent when there are
   * none. Editions print each other's ISBNs, and the last pages advertise other books, so a candidate is
   * something for a person to confirm, never a match.
   */
  isbn_candidates?: string[];
  citekey: string | null;
  citekey_source: "calibre" | "pinned" | "zotero" | null;
  zotero: { library: string; key: string; matched_by: string } | null;
}

export interface HoldingsFeed { version: number; books: HoldingsBook[] }

/** Books not left out by an excluded tag, by id. */
export function holdingsBookRows(c: Corpus, excludeTags: string[], where = "1", ...args: unknown[]): BookRow[] {
  const excluded = new Set(excludeTags.map((t) => t.toLowerCase()));
  return (c.db.prepare(`SELECT * FROM books WHERE ${where} ORDER BY id`).all(...args) as BookRow[])
    .filter((b) => !(JSON.parse(b.tags) as string[]).some((t) => excluded.has(t.toLowerCase())));
}

/** One book as the feed sends it, and as /api/verify names the book it checked. */
export function holdingsBook(c: Corpus, b: BookRow, zoteroLibrary?: string): HoldingsBook {
  let { citekey, citekey_source }: { citekey: string | null; citekey_source: HoldingsBook["citekey_source"] } =
    effectiveCitekey(b, b.uuid ? pinnedByUuid(c.data, b.uuid) : undefined);
  let zotero: HoldingsBook["zotero"] = null;
  if (zoteroLibrary) {
    const { match } = zoteroMatch(c, b);
    if (match) {
      zotero = { library: zoteroLibrary, key: match.key, matched_by: match.matched_by };
      if (!citekey && match.citekey) ({ citekey, citekey_source } = { citekey: match.citekey, citekey_source: "zotero" });
    }
  }
  const isbn = b.isbn ? validIsbn(b.isbn) : null;
  // Read at index time, so this is a JSON parse, not a scan.
  const printed = printedIsbns(b).sort((x, y) => (x.position === y.position ? x.page - y.page : x.position === "front" ? -1 : 1));
  const candidates = [...new Set(printed.map((p) => p.isbn13))].filter((i) => !isbn || i !== isbn13(isbn));
  return {
    calibre_uuid: b.uuid, book_id: b.id, library: b.library, title: b.title, authors: JSON.parse(b.authors) as string[], year: b.year,
    formats: b.format ? [b.format] : [],
    has_text: hasText(b),
    isbns: isbn ? [isbn] : [],
    ...(candidates.length ? { isbn_candidates: candidates } : {}),
    citekey, citekey_source, zotero,
  };
}

/** Indexed with a text layer: at least 20 characters a page, the admin pages' rule. */
export const hasText = (b: BookRow) => b.status === "indexed" && !!b.page_count && (b.text_chars ?? 0) >= 20 * b.page_count;

/** Indexed books only: a failed extraction or a missing file is no holding to point an agent at. */
export function holdingsBooks(c: Corpus, o: { excludeTags: string[]; zoteroLibrary?: string }): HoldingsFeed {
  return { version: HOLDINGS_VERSION, books: holdingsBookRows(c, o.excludeTags, "status = 'indexed'").map((b) => holdingsBook(c, b, o.zoteroLibrary)) };
}

/**
 * True when an If-None-Match header names this ETag: by weak comparison, as GET's conditional requests use,
 * so `W/"…"` matches too, and `*` matches any.
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return String(header ?? "").split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}

/** The feed's body and its strong ETag, a hash of the body. */
export function holdingsBooksResponse(c: Corpus, o: { excludeTags: string[]; zoteroLibrary?: string }): { body: string; etag: string } {
  const body = JSON.stringify(holdingsBooks(c, o));
  return { body, etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"` };
}
