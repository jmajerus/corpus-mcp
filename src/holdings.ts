import { createHash } from "node:crypto";
import { pinnedByUuid } from "./data.js";
import { type BookRow, type Corpus, effectiveCitekey } from "./tools.js";
import { zoteroMatch } from "./zotero.js";

/**
 * The books feed for holdings-mcp (docs/dev-briefs/holdings-and-quotes.md §1): every indexed book with its
 * keys, as a snapshot with a strong ETag, so a poll that finds nothing new is a 304. Keys are real keys only,
 * as in the public key list: a Calibre or pinned citekey, else the matched Zotero item's; never a proposed
 * one. `zotero` is the item the book is matched to (confirmed, filed with the book's UUID, or the one item
 * with its ISBN), never a candidate a person hasn't confirmed. Books with an excluded tag aren't sent.
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
  /** False for a book that failed, has no file, or has no text layer (fewer than 20 characters a page). */
  has_text: boolean;
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
  return {
    calibre_uuid: b.uuid, book_id: b.id, library: b.library, title: b.title, authors: JSON.parse(b.authors) as string[], year: b.year,
    formats: b.format ? [b.format] : [],
    has_text: hasText(b),
    citekey, citekey_source, zotero,
  };
}

/** Indexed with a text layer: at least 20 characters a page, the admin pages' rule. */
export const hasText = (b: BookRow) => b.status === "indexed" && !!b.page_count && (b.text_chars ?? 0) >= 20 * b.page_count;

export function holdingsBooks(c: Corpus, o: { excludeTags: string[]; zoteroLibrary?: string }): HoldingsFeed {
  return { version: HOLDINGS_VERSION, books: holdingsBookRows(c, o.excludeTags).map((b) => holdingsBook(c, b, o.zoteroLibrary)) };
}

/** The feed's body and its strong ETag, a hash of the body. */
export function holdingsBooksResponse(c: Corpus, o: { excludeTags: string[]; zoteroLibrary?: string }): { body: string; etag: string } {
  const body = JSON.stringify(holdingsBooks(c, o));
  return { body, etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"` };
}
