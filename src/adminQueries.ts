import { zoteroItemLink, zoteroMatch, zoteroSynced } from "./zotero.js";
import type { Config } from "./config.js";
import { allPinned, pinnedByUuid, queryChanges } from "./data.js";
import { validIsbn } from "./isbn.js";
import { searchQuotes } from "./quotes.js";
import { categoryDiff } from "./tagging.js";
import {
  type BookRow, type Corpus, ToolError, bookYear, getBook, printedIsbns, printedYears, shelvesByBook, suspectTagReason, tagFilter, tagFilterValue,
} from "./tools.js";

/**
 * Current-state views for the admin pages: books (list and detail), categories, and citekeys. Each
 * book's derived states (categories, citekey, ISBN, problems) are computed the same way everywhere.
 */

interface ProposalRow { calibre_uuid: string; status: string; tags: string; approved_tags: string | null; rationale: string; proposed_by: string | null; proposed_at: string; reviewed_by: string | null; reviewed_at: string | null }

export type CategoryState = "uncategorized" | "categorized" | "pending" | "not_applied";
export type CitekeyState = "calibre" | "pinned" | "ready" | "blocked";
export type IsbnState = "valid" | "invalid" | "printed" | "none";
export type Problem = "failed" | "no_file" | "no_text" | "no_outline";

function bookStates(c: Corpus, b: BookRow, proposal: ProposalRow | undefined, pinned: boolean, outlineCount: number) {
  const tags = JSON.parse(b.tags) as string[];
  const vocab = tags.filter((t) => c.vocabulary.has(t));
  let category: CategoryState = vocab.length ? "categorized" : "uncategorized";
  if (proposal?.status === "pending") category = "pending";
  else if (proposal?.status === "approved") {
    const diff = categoryDiff(c, b, JSON.parse(proposal.approved_tags ?? "[]") as string[]);
    if (diff.add.length || diff.remove.length) category = "not_applied";
  }
  // A Calibre "citekey" identifier overrides a pin; otherwise a book is pinned, blocked, or ready to file.
  const citekey: CitekeyState = b.calibre_citekey ? "calibre" : pinned ? "pinned" : (JSON.parse(b.citekey_blockers) as string[]).length ? "blocked" : "ready";
  const isbn: IsbnState = b.isbn ? (validIsbn(b.isbn) ? "valid" : "invalid") : printedIsbns(b).length ? "printed" : "none";
  const problems: Problem[] = [];
  if (b.status === "failed") problems.push("failed");
  if (b.status === "no_file") problems.push("no_file");
  if (b.status === "indexed" && b.page_count && (b.text_chars ?? 0) < 20 * b.page_count) problems.push("no_text");
  if (b.status === "indexed" && outlineCount === 0) problems.push("no_outline");
  return { vocab, free: tags.filter((t) => !c.vocabulary.has(t)), category, citekey, isbn, problems };
}

export interface AdminBookQuery {
  q?: string; library?: string; format?: string; status?: string; shelf?: string; tag?: string;
  category?: CategoryState; citekey?: CitekeyState; isbn?: IsbnState; problem?: Problem; sort?: "title" | "year" | "id"; limit?: number; offset?: number;
}

export function adminBooks(c: Corpus, query: AdminBookQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.q) {
    where.push("(lower(b.title) LIKE @q OR lower(b.authors) LIKE @q OR lower(b.id) = @exact OR b.isbn LIKE @q OR lower(b.proposed_citekey) = @exact OR lower(b.calibre_citekey) = @exact)");
    params.q = `%${query.q.toLowerCase()}%`;
    params.exact = query.q.toLowerCase();
  }
  if (query.library) { where.push("b.library = @library"); params.library = query.library; }
  if (query.format) { where.push("b.format = @format"); params.format = query.format; }
  if (query.status) { where.push("b.status = @status"); params.status = query.status; }
  if (query.shelf) {
    where.push("b.id IN (SELECT bs.book_id FROM book_shelves bs JOIN shelves s ON s.id = bs.shelf_id WHERE s.name = @shelf COLLATE NOCASE)");
    params.shelf = query.shelf;
  }
  if (query.tag) { where.push(tagFilter(c, query.tag)); params.tag = tagFilterValue(c, query.tag); }
  const order = query.sort === "year" ? "b.year DESC, b.title COLLATE NOCASE" : query.sort === "id" ? "b.library, b.calibre_id" : "b.title COLLATE NOCASE, b.id";
  const rows = c.db.prepare(`SELECT b.* FROM books b ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order}`).all(params) as BookRow[];

  const proposals = new Map((c.data.prepare("SELECT * FROM tag_proposals").all() as ProposalRow[]).map((p) => [p.calibre_uuid, p]));
  const pins = allPinned(c.data);
  const outlines = new Map((c.db.prepare("SELECT book_id, COUNT(*) AS n FROM outline GROUP BY book_id").all() as { book_id: string; n: number }[]).map((r) => [r.book_id, r.n]));
  const shelves = shelvesByBook(c);
  const all = rows.map((b) => {
    const pin = b.uuid ? pins.get(b.uuid) : undefined;
    return { b, pin, s: bookStates(c, b, b.uuid ? proposals.get(b.uuid) : undefined, Boolean(pin), outlines.get(b.id) ?? 0) };
  });
  // Facet counts cover the search above, before the state filters, so each state shows what selecting it finds.
  const facets: Record<string, Record<string, number>> = { format: {}, status: {}, category: {}, citekey: {}, isbn: {}, problem: {} };
  for (const { b, s } of all) {
    facets.format[b.format ?? "none"] = (facets.format[b.format ?? "none"] ?? 0) + 1;
    facets.status[b.status] = (facets.status[b.status] ?? 0) + 1;
    facets.category[s.category] = (facets.category[s.category] ?? 0) + 1;
    facets.citekey[s.citekey] = (facets.citekey[s.citekey] ?? 0) + 1;
    facets.isbn[s.isbn] = (facets.isbn[s.isbn] ?? 0) + 1;
    for (const p of s.problems) facets.problem[p] = (facets.problem[p] ?? 0) + 1;
  }
  const filtered = all.filter(({ s }) =>
    (!query.category || s.category === query.category) && (!query.citekey || s.citekey === query.citekey)
    && (!query.isbn || s.isbn === query.isbn) && (!query.problem || s.problems.includes(query.problem)));
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  return {
    total: filtered.length,
    facets,
    libraries: c.db.prepare("SELECT DISTINCT library FROM books ORDER BY library").pluck().all(),
    rows: filtered.slice(offset, offset + limit).map(({ b, pin, s }) => ({
      book_id: b.id, title: b.title, authors: JSON.parse(b.authors) as string[], year: b.year, format: b.format, status: b.status,
      pages: b.page_count, shelves: shelves.get(b.id) ?? [],
      categories: s.vocab.map((t) => ({ tag: t, label: c.vocabulary.find(t)?.label ?? t })), other_tags: s.free.length,
      category_state: s.category, citekey_state: s.citekey, citekey: b.calibre_citekey ?? pin?.citekey ?? null, proposed_citekey: b.proposed_citekey,
      isbn_state: s.isbn, problems: s.problems,
    })),
  };
}

/** Everything about one book, for its admin page. */
export function adminBook(c: Corpus, config: Config, id: string) {
  const b = getBook(c, id);
  const proposal = b.uuid ? c.data.prepare<[string], ProposalRow>("SELECT * FROM tag_proposals WHERE calibre_uuid = ?").get(b.uuid) : undefined;
  const pin = pinnedByUuid(c.data, b.uuid);
  const outline = c.db.prepare(`
    SELECT o.level, o.title, o.start_page, p.label FROM outline o
    LEFT JOIN pages p ON p.book_id = o.book_id AND p.page_index = o.start_page WHERE o.book_id = ? ORDER BY o.ord`).all(b.id) as
    { level: number; title: string; start_page: number | null; label: string | null }[];
  const s = bookStates(c, b, proposal, Boolean(pin), outline.length);
  const approved = proposal?.status === "approved" ? (JSON.parse(proposal.approved_tags ?? "[]") as string[]) : null;
  const admin = config.admin;
  const reason = suspectTagReason(c);
  const zotero = zoteroSynced(c) ? zoteroMatch(c, b) : null;
  return {
    zotero: zotero && {
      ...zotero, link: zotero.match ? zoteroItemLink(config.zotero?.library, zotero.match.key) : null,
      candidates: zotero.candidates.map((x) => ({ ...x, link: zoteroItemLink(config.zotero?.library, x.key) })),
    },
    book_id: b.id, library: b.library, calibre_id: b.calibre_id, uuid: b.uuid, title: b.title, authors: JSON.parse(b.authors) as string[],
    author_sorts: JSON.parse(b.author_sorts) as string[], publisher: b.publisher, year: b.year, language: b.language,
    description: b.description, status: b.status, error: b.error,
    file: { format: b.format, path: b.file_path, size: b.file_size, sha256: b.sha256, pages: b.page_count, page_kind: b.reflowable === null ? null : b.reflowable ? "location" : "pdf_page", text_chars: b.text_chars },
    same_file_as: b.sha256 ? c.db.prepare("SELECT id FROM books WHERE sha256 = ? AND id != ?").pluck().all(b.sha256, b.id) : [],
    shelves: shelvesByBook(c, [b.id]).get(b.id) ?? [],
    categories: {
      state: s.category,
      calibre: s.vocab.map((t) => ({ tag: t, label: c.vocabulary.find(t)?.label ?? t })),
      approved: approved?.map((t) => ({ tag: t, label: c.vocabulary.find(t)?.label ?? t })) ?? null,
      pending_in_calibre: approved ? categoryDiff(c, b, approved) : null,
      proposal: proposal ? {
        status: proposal.status, tags: JSON.parse(proposal.tags) as string[], rationale: proposal.rationale,
        proposed_by: proposal.proposed_by, proposed_at: proposal.proposed_at, reviewed_by: proposal.reviewed_by, reviewed_at: proposal.reviewed_at,
      } : null,
    },
    other_tags: s.free.map((t) => ({ tag: t, suspect: reason(t) })),
    citekey: {
      state: s.citekey, calibre_identifier: b.calibre_citekey, pinned: pin ?? null, proposed: b.proposed_citekey,
      blockers: JSON.parse(b.citekey_blockers) as string[],
    },
    isbn: { calibre: b.isbn, valid: b.isbn ? validIsbn(b.isbn) : null, state: s.isbn, printed: printedIsbns(b) },
    publication_year: { calibre: b.year, printed: b.printed_year, ...bookYear(b), candidates: printedYears(b) },
    problems: s.problems,
    outline: outline.map((o) => ({ level: o.level, title: o.title, page: o.start_page === null ? null : o.start_page + 1, page_label: o.label })),
    calibre_web_url: admin?.calibreWebUrl && b.library === config.shelvesLibrary ? `${admin.calibreWebUrl}/book/${b.calibre_id}` : null,
    changes: queryChanges(c.data, { book: b.id, limit: 50 }).rows,
    quotes: searchQuotes(c, { book: b.id, limit: 200 }).quotes,
  };
}

/** The category vocabulary as a tree, with how many indexed books carry each tag (and its subtree). */
export function adminCategories(c: Corpus) {
  const counts = new Map<string, number>();
  for (const { tag, n } of c.db.prepare(`
    SELECT lower(t.value) AS tag, COUNT(*) AS n FROM books b, json_each(b.tags) t WHERE b.status != 'no_file' GROUP BY 1`).all() as { tag: string; n: number }[]) {
    counts.set(tag, n);
  }
  interface Node { tag: string; label: string; name: string; books: number; total: number; children: Node[] }
  const nodes = new Map<string, Node>();
  const roots: Node[] = [];
  const reason = suspectTagReason(c);
  for (const v of c.vocabulary.tags) {
    const parts = v.tag.split(".");
    for (let i = 1; i <= parts.length; i++) {
      const tag = parts.slice(0, i).join(".");
      if (nodes.has(tag)) continue;
      const label = c.vocabulary.labelFor(tag) ?? tag;
      const node: Node = { tag, label, name: label.split(" › ").at(-1)!, books: counts.get(tag) ?? 0, total: 0, children: [] };
      nodes.set(tag, node);
      (i === 1 ? roots : nodes.get(parts.slice(0, i - 1).join("."))!.children).push(node);
    }
  }
  const total = (n: Node): number => (n.total = n.books + n.children.reduce((sum, child) => sum + total(child), 0));
  roots.forEach(total);
  const free = [...counts].filter(([tag]) => !c.vocabulary.has(tag)).map(([tag, books]) => ({ tag, books, suspect: reason(tag) }))
    .sort((a, b) => b.books - a.books || a.tag.localeCompare(b.tag));
  const categorized = c.db.prepare(`SELECT COUNT(*) FROM books b WHERE b.status != 'no_file' AND EXISTS (
    SELECT 1 FROM json_each(b.tags) t WHERE lower(t.value) IN (SELECT value FROM json_each(@vocab)))`).pluck()
    .get({ vocab: JSON.stringify(c.vocabulary.tags.map((t) => t.tag)) }) as number;
  const books = c.db.prepare("SELECT COUNT(*) FROM books WHERE status != 'no_file'").pluck().get() as number;
  return { books, categorized, uncategorized: books - categorized, tree: roots.sort((a, b) => a.label.localeCompare(b.label)), free };
}

/** Pinned citekeys, and what keeps other books from getting one. */
export function adminCitekeys(c: Corpus) {
  const pins = [...allPinned(c.data).values()];
  const byUuid = c.db.prepare<[string], BookRow>("SELECT * FROM books WHERE uuid = ? ORDER BY id");
  return {
    pinned: pins.map((p) => {
      const b = byUuid.get(p.calibre_uuid);
      return { ...p, current_book_id: b?.id ?? null, current_title: b?.title ?? null, proposed: b?.proposed_citekey ?? null };
    }).sort((a, b) => a.citekey.localeCompare(b.citekey)),
  };
}

/** A filter value checked against its allowed set, or undefined. */
export function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  if (!allowed.includes(value as T)) throw new ToolError(`Unknown value "${value}".`);
  return value as T;
}
