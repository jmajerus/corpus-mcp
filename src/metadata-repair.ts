import { pinnedByUuid } from "./data.js";
import { getBook, pinCitekey, ToolError, type Corpus } from "./tools.js";

export interface MetadataValues { title: string; authors: string[]; year: number | null }
export interface MetadataCorrection { book_id: string; title: unknown; authors: unknown; year: unknown; before: unknown }

/** Only the fields reviewed on the book page. The source verifies identity and these before-values again. */
export function metadataRepairPlan(c: Corpus, library: string, correction: MetadataCorrection) {
  const b = getBook(c, correction.book_id);
  if (b.library !== library || !b.uuid) throw new ToolError("This book is not in the writable Calibre library.");
  if (typeof correction.title !== "string" || !correction.title.trim() || correction.title.length > 1000 || /[\x00-\x1f]/.test(correction.title)) throw new ToolError("Enter a title.");
  if (!Array.isArray(correction.authors) || !correction.authors.length || correction.authors.length > 100
    || correction.authors.some(a => typeof a !== "string" || !a.trim() || a.length > 300 || /[\x00-\x1f|]/.test(a))) throw new ToolError("Enter each author on a separate line.");
  if (correction.authors.some(a => (a as string).includes("&"))) throw new ToolError("Enter each author on a separate line. Within one name, use ‘and’ instead of Calibre’s reserved & separator.");
  if (correction.year !== null && (!Number.isInteger(correction.year) || (correction.year as number) < 1001 || (correction.year as number) > 9999)) throw new ToolError("Enter a publication year from 1001 to 9999, or leave it blank.");
  const after: MetadataValues = { title: correction.title.trim(), authors: correction.authors.map(a => (a as string).trim()), year: correction.year as number | null };
  if (new Set(after.authors.map(a => a.toLowerCase())).size !== after.authors.length) throw new ToolError("An author is listed more than once.");
  const before: MetadataValues = { title: b.title, authors: JSON.parse(b.authors) as string[], year: b.year };
  if (!correction.before || (correction.before as MetadataValues).year !== before.year || typeof correction.before !== "object" || (correction.before as MetadataValues).title !== before.title || JSON.stringify((correction.before as MetadataValues).authors) !== JSON.stringify(before.authors)) throw new ToolError("This book's metadata changed. Reload it and review the correction again.");
  if (JSON.stringify(before) === JSON.stringify(after)) throw new ToolError("The title, authors, and publication year are unchanged.");
  return { library, books: [{ calibre_id: b.calibre_id, uuid: b.uuid, title: b.title, before, after }] };
}


/** Complete the reviewed operation only after the refresh has confirmed Calibre's values. */
export function completeMetadataCitekey(c: Corpus, library: string, reviewed: ReturnType<typeof metadataRepairPlan>["books"][number], actor?: string, jobId?: number) {
  const b = getBook(c, `${library}:${reviewed.calibre_id}`);
  const authors = (names: string[]) => names.map(name => name.replaceAll("|", ","));
  if (b.uuid !== reviewed.uuid || b.title !== reviewed.after.title || b.year !== reviewed.after.year
    || JSON.stringify(authors(JSON.parse(b.authors))) !== JSON.stringify(reviewed.after.authors)) {
    throw new ToolError("The correction was saved, but the refresh did not confirm its metadata. No citekey was pinned; refresh and review the book.");
  }
  const assigned = b.calibre_citekey ?? pinnedByUuid(c.data, b.uuid)?.citekey;
  if (assigned) return `Kept existing citekey ${assigned}.`;
  if (!b.proposed_citekey || JSON.parse(b.citekey_blockers).length || reviewed.after.year === null) return "Citekey needs review: the corrected metadata still has a missing or unresolved field.";
  const key = b.proposed_citekey;
  const conflictingBook = c.db.prepare("SELECT id FROM books WHERE (uuid IS NULL OR uuid<>@uuid) AND (lower(calibre_citekey)=@key OR lower(proposed_citekey)=@key) LIMIT 1").get({uuid:b.uuid,key:key.toLowerCase()});
  const conflictingPin = c.data.prepare("SELECT book_id FROM citekeys WHERE lower(citekey)=? AND calibre_uuid<>? LIMIT 1").get(key.toLowerCase(),b.uuid);
  if (conflictingBook || conflictingPin) return `Citekey needs review: ${key} is also used or proposed for another book. No key was overwritten.`;
  pinCitekey(c, {book_id:b.id,citekey:key}, actor, "admin-job", jobId);
  return `Pinned derived citekey ${key}.`;
}
