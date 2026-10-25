import { recordChanges } from "./data.js";
import type { BookRow, Corpus } from "./tools.js";
import { ToolError, getBook, shelvesByBook } from "./tools.js";

/**
 * Tagging books with the Concept Clusters vocabulary: an agent takes books from the worklist and
 * proposes tags, a person approves or edits them on the /review page, and tools/calibre-tags.sh
 * writes approved tags into Calibre. Proposals live in data.db.
 */

const MAX_TAGS = 3;

interface ProposalRow {
  calibre_uuid: string; book_id: string; title: string; tags: string; rationale: string;
  status: "pending" | "approved" | "rejected"; approved_tags: string | null;
  proposed_by: string | null; proposed_at: string; reviewed_by: string | null; reviewed_at: string | null;
}

/** Calibre's HTML description as plain text, trimmed for a worklist. */
function plainText(html: string | null, max = 600): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || null;
}

/** The given tags as canonical vocabulary tags; anything outside the vocabulary is an error. */
function canonicalTags(c: Corpus, tags: string[], max: number): string[] {
  const canonical: string[] = [];
  const unknown: string[] = [];
  for (const tag of tags) {
    const found = c.vocabulary.find(tag);
    if (!found) unknown.push(tag);
    else if (!canonical.includes(found.tag)) canonical.push(found.tag);
  }
  if (unknown.length) {
    throw new ToolError(`Not in the vocabulary: ${unknown.map((t) => `"${t}"`).join(", ")}. Use get_tag_vocabulary for the tags (slug or title form).`);
  }
  if (canonical.length < 1 || canonical.length > max) throw new ToolError(`Give 1 to ${max} vocabulary tags.`);
  return canonical;
}

export interface VocabularyArgs { under?: string }

export function getTagVocabulary(c: Corpus, args: VocabularyArgs = {}) {
  const under = args.under ? c.vocabulary.toSlugPath(args.under).toLowerCase() : undefined;
  const tags = c.vocabulary.tags
    .filter((t) => !under || t.tag === under || t.tag.startsWith(`${under}.`))
    .map((t) => ({ tag: t.tag, label: t.label }));
  return {
    note: "Concept Clusters' taxonomy as Calibre tags: slugs \"domain.category.subcategory\", with titles in label. propose_tags takes either form. Propose the most specific tag that fits; a category tag is fine when no subcategory does.",
    count: tags.length,
    tags,
  };
}

/**
 * Rewrites stored proposal tags into the vocabulary's current slug form (from title paths, or tags
 * saved before the switch to slugs). Idempotent; a tag the vocabulary no longer knows is left as is.
 */
export function normalizeProposalTags(c: Corpus): number {
  const rows = c.data.prepare("SELECT calibre_uuid, tags, approved_tags FROM tag_proposals").all() as
    { calibre_uuid: string; tags: string; approved_tags: string | null }[];
  const normalize = (json: string | null) => {
    if (!json) return json;
    const tags = (JSON.parse(json) as string[]).map((t) => c.vocabulary.find(t)?.tag ?? t);
    return JSON.stringify([...new Set(tags)]);
  };
  const update = c.data.prepare("UPDATE tag_proposals SET tags = ?, approved_tags = ? WHERE calibre_uuid = ?");
  let changed = 0;
  c.data.transaction(() => {
    for (const r of rows) {
      const tags = normalize(r.tags)!;
      const approved = normalize(r.approved_tags);
      if (tags !== r.tags || approved !== r.approved_tags) {
        update.run(tags, approved, r.calibre_uuid);
        changed++;
      }
    }
  })();
  return changed;
}

export interface WorklistArgs { limit?: number; shelf?: string; include_tagged?: boolean }

/** Indexed books with no proposal yet (and, by default, no vocabulary tag), with context for choosing tags. */
export function taggingWorklist(c: Corpus, args: WorklistArgs = {}) {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);
  const proposed = new Set(c.data.prepare("SELECT calibre_uuid FROM tag_proposals").pluck().all() as string[]);
  const shelfBooks = args.shelf
    ? new Set(c.db.prepare(`
        SELECT bs.book_id FROM book_shelves bs JOIN shelves s ON s.id = bs.shelf_id WHERE s.name = ? COLLATE NOCASE`)
        .pluck().all(args.shelf) as string[])
    : null;
  if (shelfBooks && !shelfBooks.size) throw new ToolError(`No books on a shelf named "${args.shelf}". See list_shelves.`);
  const candidates = (c.db.prepare("SELECT * FROM books WHERE status = 'indexed' AND uuid IS NOT NULL ORDER BY id").all() as BookRow[])
    .filter((b) => !proposed.has(b.uuid!))
    .filter((b) => !shelfBooks || shelfBooks.has(b.id))
    .filter((b) => args.include_tagged || !(JSON.parse(b.tags) as string[]).some((t) => c.vocabulary.has(t)));
  const batch = candidates.slice(0, limit);
  const shelves = shelvesByBook(c, batch.map((b) => b.id));
  const outline = c.db.prepare("SELECT level, title FROM outline WHERE book_id = ? AND level <= 1 ORDER BY ord");
  return {
    note: "Propose 1-3 tags per book with propose_tags, chosen from get_tag_vocabulary. Base them on what the book is about, not on its shelf alone.",
    remaining: candidates.length,
    books: batch.map((b) => {
      const entries = outline.all(b.id) as { level: number; title: string }[];
      const top = entries.filter((e) => e.level === 0);
      // A book whose outline has one top-level entry (often the title) is better described by its next level.
      const chapters = (top.length > 1 ? top : entries).map((e) => e.title).slice(0, 25);
      return {
        book_id: b.id,
        title: b.title,
        authors: JSON.parse(b.authors) as string[],
        year: b.year,
        publisher: b.publisher,
        shelves: shelves.get(b.id) ?? [],
        tags: JSON.parse(b.tags) as string[],
        description: plainText(b.description),
        chapters,
      };
    }),
  };
}

export interface ProposeArgs { book_id: string; tags: string[]; rationale: string }

export function proposeTags(c: Corpus, args: ProposeArgs, proposedBy?: string) {
  const book = getBook(c, args.book_id);
  if (!book.uuid) throw new ToolError(`${book.id} has no Calibre UUID, so it cannot be tagged.`);
  const tags = canonicalTags(c, args.tags, MAX_TAGS);
  const rationale = args.rationale.trim();
  if (!rationale) throw new ToolError("Give a short rationale for the tags.");
  const existing = c.data.prepare<[string], ProposalRow>("SELECT * FROM tag_proposals WHERE calibre_uuid = ?").get(book.uuid);
  if (existing && existing.status !== "pending") {
    throw new ToolError(`${book.id} already has a ${existing.status} proposal; change it on the review page.`);
  }
  c.data.prepare(`
    INSERT INTO tag_proposals (calibre_uuid, book_id, title, tags, rationale, status, proposed_by, proposed_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT (calibre_uuid) DO UPDATE SET book_id = excluded.book_id, title = excluded.title, tags = excluded.tags,
      rationale = excluded.rationale, proposed_by = excluded.proposed_by, proposed_at = excluded.proposed_at`)
    .run(book.uuid, book.id, book.title, JSON.stringify(tags), rationale, proposedBy ?? null, new Date().toISOString());
  recordChanges(c.data, tags.map((tag) => ({
    kind: "tag_proposed" as const, source: "agent" as const, book_id: book.id, calibre_uuid: book.uuid, title: book.title, detail: tag, actor: proposedBy ?? null,
  })));
  return { status: existing ? "replaced" : "proposed", book_id: book.id, tags };
}

export interface ListProposalsArgs { status?: string; limit?: number; offset?: number }

/** Proposals with the book context a reviewer needs; in_calibre says whether Calibre already has the approved tags. */
export function listProposals(c: Corpus, args: ListProposalsArgs = {}) {
  const status = args.status ?? "pending";
  if (!["pending", "approved", "rejected"].includes(status)) throw new ToolError(`Unknown status "${status}".`);
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const offset = Math.max(args.offset ?? 0, 0);
  const counts = Object.fromEntries((c.data.prepare("SELECT status, COUNT(*) AS n FROM tag_proposals GROUP BY status").all() as { status: string; n: number }[])
    .map((r) => [r.status, r.n]));
  const rows = c.data.prepare(`
    SELECT * FROM tag_proposals WHERE status = ? ORDER BY ${status === "pending" ? "proposed_at" : "reviewed_at DESC"} LIMIT ? OFFSET ?`)
    .all(status, limit, offset) as ProposalRow[];
  const bookByUuid = c.db.prepare<[string], BookRow>("SELECT * FROM books WHERE uuid = ? ORDER BY id");
  const books = rows.map((r) => bookByUuid.get(r.calibre_uuid));
  const shelves = shelvesByBook(c, books.filter((b): b is BookRow => Boolean(b)).map((b) => b.id));
  return {
    counts: { pending: counts.pending ?? 0, approved: counts.approved ?? 0, rejected: counts.rejected ?? 0 },
    proposals: rows.map((r, i) => {
      const book = books[i];
      const calibreTags = book ? (JSON.parse(book.tags) as string[]) : [];
      const approved = r.approved_tags ? (JSON.parse(r.approved_tags) as string[]) : null;
      const lower = new Set(calibreTags.map((t) => t.toLowerCase()));
      return {
        calibre_uuid: r.calibre_uuid,
        book_id: book?.id ?? r.book_id,
        title: book?.title ?? r.title,
        authors: book ? (JSON.parse(book.authors) as string[]) : [],
        year: book?.year ?? null,
        shelves: book ? shelves.get(book.id) ?? [] : [],
        calibre_tags: calibreTags,
        description: plainText(book?.description ?? null, 400),
        tags: JSON.parse(r.tags) as string[],
        rationale: r.rationale,
        status: r.status,
        approved_tags: approved,
        in_calibre: approved && book ? (() => { const d = categoryDiff(c, book, approved); return !d.add.length && !d.remove.length; })() : false,
        // What approving (or, once approved, applying) changes in Calibre: the set replaces the book's vocabulary tags.
        calibre_changes: book ? categoryDiff(c, book, approved ?? (JSON.parse(r.tags) as string[])) : null,
        proposed_by: r.proposed_by,
        proposed_at: r.proposed_at,
        reviewed_by: r.reviewed_by,
        reviewed_at: r.reviewed_at,
      };
    }),
  };
}

export interface ReviewArgs { action: "approve" | "reject" | "reopen"; tags?: string[] }

export function reviewProposal(c: Corpus, calibreUuid: string, args: ReviewArgs, reviewedBy?: string) {
  const row = c.data.prepare<[string], ProposalRow>("SELECT * FROM tag_proposals WHERE calibre_uuid = ?").get(calibreUuid);
  if (!row) throw new ToolError("No such proposal.");
  const now = new Date().toISOString();
  const logged = (kind: "proposal_approved" | "proposal_rejected" | "proposal_reopened", details: (string | null)[]) => recordChanges(c.data, details.map((detail) => ({
    kind, source: "review" as const, book_id: row.book_id, calibre_uuid: row.calibre_uuid, title: row.title, detail, actor: reviewedBy ?? null,
  })));
  if (args.action === "approve") {
    // A reviewer may add a fourth or fifth tag, but every tag stays inside the vocabulary.
    const tags = canonicalTags(c, args.tags ?? (JSON.parse(row.tags) as string[]), 5);
    c.data.prepare("UPDATE tag_proposals SET status = 'approved', approved_tags = ?, reviewed_by = ?, reviewed_at = ? WHERE calibre_uuid = ?")
      .run(JSON.stringify(tags), reviewedBy ?? null, now, calibreUuid);
    logged("proposal_approved", tags);
    return { status: "approved", tags };
  }
  if (args.action === "reject") {
    c.data.prepare("UPDATE tag_proposals SET status = 'rejected', approved_tags = NULL, reviewed_by = ?, reviewed_at = ? WHERE calibre_uuid = ?")
      .run(reviewedBy ?? null, now, calibreUuid);
    logged("proposal_rejected", [null]);
    return { status: "rejected" };
  }
  if (args.action === "reopen") {
    c.data.prepare("UPDATE tag_proposals SET status = 'pending', approved_tags = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE calibre_uuid = ?")
      .run(calibreUuid);
    logged("proposal_reopened", [null]);
    return { status: "pending" };
  }
  throw new ToolError(`Unknown action "${String(args.action)}".`);
}

/**
 * How a book's vocabulary tags in Calibre differ from its approved set: an approved proposal holds the
 * book's complete set of categories, so tags to add and vocabulary tags to remove. Free-form tags are
 * never touched.
 */
export function categoryDiff(c: Corpus, book: BookRow, approved: string[]): { add: string[]; remove: string[] } {
  const calibre = (JSON.parse(book.tags) as string[]).filter((t) => c.vocabulary.has(t));
  const want = new Set(approved.map((t) => t.toLowerCase()));
  const have = new Set(calibre.map((t) => t.toLowerCase()));
  return { add: approved.filter((t) => !have.has(t.toLowerCase())), remove: calibre.filter((t) => !want.has(t.toLowerCase())) };
}

/**
 * The changes that make Calibre match the approved category sets, per book, for tools/calibre-tags.sh.
 * `bookIds` limits the plan to those books (a book page's "apply this book").
 */
export function tagPlan(c: Corpus, library: string, bookIds?: string[]) {
  const rows = c.data.prepare("SELECT * FROM tag_proposals WHERE status = 'approved'").all() as ProposalRow[];
  const bookByUuid = c.db.prepare<[string, string], BookRow>("SELECT * FROM books WHERE uuid = ? AND library = ?");
  const only = bookIds ? new Set(bookIds) : null;
  const books = [];
  for (const r of rows) {
    const book = bookByUuid.get(r.calibre_uuid, library);
    if (!book || (only && !only.has(book.id))) continue;
    const { add, remove } = categoryDiff(c, book, JSON.parse(r.approved_tags ?? "[]") as string[]);
    if (add.length || remove.length) {
      books.push({ calibre_id: Number(book.id.split(":")[1]), uuid: r.calibre_uuid, title: book.title, add, ...(remove.length ? { remove } : {}) });
    }
  }
  return { library, generated_at: new Date().toISOString(), books };
}

export interface SetCategoriesArgs { book_id: string; tags: string[]; note?: string }

/**
 * A person sets a book's complete category set from its admin page: recorded as an approved proposal
 * by that person, applied to Calibre by the tags job (preview, then apply) like any approval.
 */
export function setBookCategories(c: Corpus, args: SetCategoriesArgs, by: string) {
  const book = getBook(c, args.book_id);
  if (!book.uuid) throw new ToolError(`${book.id} has no Calibre UUID, so it cannot be tagged.`);
  const tags = args.tags.length ? canonicalTags(c, args.tags, 8) : [];
  const now = new Date().toISOString();
  const note = args.note?.trim() || `Set on the book's admin page by ${by}.`;
  c.data.prepare(`
    INSERT INTO tag_proposals (calibre_uuid, book_id, title, tags, rationale, status, approved_tags, proposed_by, proposed_at, reviewed_by, reviewed_at)
    VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)
    ON CONFLICT (calibre_uuid) DO UPDATE SET book_id = excluded.book_id, title = excluded.title, tags = excluded.tags,
      rationale = excluded.rationale, status = 'approved', approved_tags = excluded.approved_tags, proposed_by = excluded.proposed_by,
      proposed_at = excluded.proposed_at, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`)
    .run(book.uuid, book.id, book.title, JSON.stringify(tags), note, JSON.stringify(tags), by, now, by, now);
  recordChanges(c.data, [{
    kind: "categories_edited", source: "admin", book_id: book.id, calibre_uuid: book.uuid, title: book.title,
    detail: tags.length ? tags.join(", ") : "(none)", actor: by,
  }]);
  return { status: "approved", book_id: book.id, tags, pending_in_calibre: categoryDiff(c, book, tags) };
}
