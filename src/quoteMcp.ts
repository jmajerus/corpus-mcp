import type { BookRow } from "./tools.js";

/**
 * quote-mcp, where quotes are kept (docs/dev-briefs/holdings-and-quotes.md §3.4). The reader shows a book's
 * quotes from it and saves new ones to it, through its LAN-only /api/corpus/quotes. A browser that came
 * through the tunnel can't reach those routes, so this server calls them for the page.
 */

/** A quote as the reader highlights it: pages 1-based, offsets into the stored page text. */
export interface ReaderQuote {
  id: number; start_page: number; start_offset: number; end_page: number; end_offset: number;
  comment: string | null; tags: string[]; flags: string[]; admin_path: string;
}

interface QuoteMcpQuote {
  id: number; comment: string | null; tags: string[]; flags: string[]; admin_path: string;
  anchor: { sha256: string | null; start_page: number; start_offset: number; end_page: number; end_offset: number } | null;
}

export class QuoteMcpError extends Error {}

async function call(base: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new QuoteMcpError(`quote-mcp can't be reached (${(error as Error).message}).`);
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * The book's quotes on stored pages from–to (0-based): those whose anchor is on this file of the book. One
 * anchored on an earlier file (its sha differs) has offsets that no longer fit, so it isn't highlighted.
 */
export async function readerQuotes(base: string, book: BookRow, from: number, to: number): Promise<ReaderQuote[]> {
  const r = await call(base, "GET", `/api/corpus/quotes?book=${encodeURIComponent(book.uuid ?? book.id)}`);
  if (r.status !== 200) throw new QuoteMcpError(`quote-mcp answered ${r.status} for this book's quotes.`);
  return (r.body.quotes as QuoteMcpQuote[])
    .filter((q) => q.anchor && q.anchor.sha256 === book.sha256 && q.anchor.start_page <= to && q.anchor.end_page >= from)
    .map(({ id, anchor: a, comment, tags, flags, admin_path }) => ({
      id, start_page: a!.start_page + 1, start_offset: a!.start_offset, end_page: a!.end_page + 1, end_offset: a!.end_offset,
      comment, tags, flags, admin_path,
    }));
}

export interface ReaderSave { text: string; page?: number; comment?: string; tags?: string[]; request_id?: string }

/**
 * Saves the reader's selection with quote-mcp's add_quote, recorded as the person saving it. The answer is
 * what the page shows: saved (or already saved) with the quote, or not saved with a reason and the closest
 * passages.
 */
export async function saveReaderQuote(base: string, book: BookRow, save: ReaderSave, by: string) {
  const r = await call(base, "POST", "/api/corpus/quotes", { work: book.uuid ?? book.id, ...save, by });
  const b = r.body;
  if (r.status === 201) return { saved: true, quote: b.quote, warnings: (b.warnings as string[] | undefined) ?? [] };
  if (r.status === 200) return { saved: false, already: true, reason: (b.reason as string | undefined) ?? "Already saved.", quote: b.quote };
  if (r.status === 422) return { saved: false, reason: (b.message as string | undefined) ?? "Not found in the book.", closest: (b.closest as unknown[] | undefined) ?? [] };
  if (r.status === 502) throw new QuoteMcpError("quote-mcp couldn't check the passage against this book.");
  throw new QuoteMcpError(`quote-mcp answered ${r.status}${typeof b.error === "string" ? ` (${b.error})` : ""}.`);
}
