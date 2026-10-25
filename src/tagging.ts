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
    throw new ToolError(`Not in the vocabulary: ${unknown.map((t) => `"${t}"`).join(", ")}. Use get_tag_vocabulary for the exact tags.`);
  }
  if (canonical.length < 1 || canonical.length > max) throw new ToolError(`Give 1 to ${max} vocabulary tags.`);
  return canonical;
}

export interface VocabularyArgs { under?: string }

export function getTagVocabulary(c: Corpus, args: VocabularyArgs = {}) {
  const under = args.under?.toLowerCase();
  const tags = c.vocabulary.tags
    .filter((t) => !under || t.tag.toLowerCase() === under || t.tag.toLowerCase().startsWith(`${under}.`))
    .map((t) => t.tag);
  return {
    note: "Concept Clusters' taxonomy as Calibre tags (Domain.Category.Subcategory). Propose the most specific tag that fits; a category tag is fine when no subcategory does.",
    count: tags.length,
    tags,
  };
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
        in_calibre: approved ? approved.every((t) => lower.has(t.toLowerCase())) : false,
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
  if (args.action === "approve") {
    // A reviewer may add a fourth or fifth tag, but every tag stays inside the vocabulary.
    const tags = canonicalTags(c, args.tags ?? (JSON.parse(row.tags) as string[]), 5);
    c.data.prepare("UPDATE tag_proposals SET status = 'approved', approved_tags = ?, reviewed_by = ?, reviewed_at = ? WHERE calibre_uuid = ?")
      .run(JSON.stringify(tags), reviewedBy ?? null, now, calibreUuid);
    return { status: "approved", tags };
  }
  if (args.action === "reject") {
    c.data.prepare("UPDATE tag_proposals SET status = 'rejected', approved_tags = NULL, reviewed_by = ?, reviewed_at = ? WHERE calibre_uuid = ?")
      .run(reviewedBy ?? null, now, calibreUuid);
    return { status: "rejected" };
  }
  if (args.action === "reopen") {
    c.data.prepare("UPDATE tag_proposals SET status = 'pending', approved_tags = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE calibre_uuid = ?")
      .run(calibreUuid);
    return { status: "pending" };
  }
  throw new ToolError(`Unknown action "${String(args.action)}".`);
}

/**
 * Approved tags that Calibre does not have yet, per book, for tools/calibre-tags.sh. Only the
 * missing tags are listed; the script adds them to the book's existing tags.
 */
export function tagPlan(c: Corpus, library: string) {
  const rows = c.data.prepare("SELECT * FROM tag_proposals WHERE status = 'approved'").all() as ProposalRow[];
  const bookByUuid = c.db.prepare<[string, string], BookRow>("SELECT * FROM books WHERE uuid = ? AND library = ?");
  const books = [];
  for (const r of rows) {
    const book = bookByUuid.get(r.calibre_uuid, library);
    if (!book) continue;
    const have = new Set((JSON.parse(book.tags) as string[]).map((t) => t.toLowerCase()));
    const add = (JSON.parse(r.approved_tags ?? "[]") as string[]).filter((t) => !have.has(t.toLowerCase()));
    if (add.length) books.push({ calibre_id: Number(book.id.split(":")[1]), uuid: r.calibre_uuid, title: book.title, add });
  }
  return { library, generated_at: new Date().toISOString(), books };
}
