import { getBook, ToolError, type Corpus } from "./tools.js";

export interface MetadataValues { title: string; authors: string[] }
export interface MetadataCorrection { book_id: string; title: unknown; authors: unknown; before: unknown }

/** Only the fields reviewed on the book page. The source verifies identity and these before-values again. */
export function metadataRepairPlan(c: Corpus, library: string, correction: MetadataCorrection) {
  const b = getBook(c, correction.book_id);
  if (b.library !== library || !b.uuid) throw new ToolError("This book is not in the writable Calibre library.");
  if (typeof correction.title !== "string" || !correction.title.trim() || correction.title.length > 1000 || /[\x00-\x1f]/.test(correction.title)) throw new ToolError("Enter a title.");
  if (!Array.isArray(correction.authors) || !correction.authors.length || correction.authors.length > 100
    || correction.authors.some(a => typeof a !== "string" || !a.trim() || a.length > 300 || /[\x00-\x1f|]/.test(a))) throw new ToolError("Enter each author on a separate line.");
  if (correction.authors.some(a => (a as string).includes("&"))) throw new ToolError("Enter each author on a separate line. Within one name, use ‘and’ instead of Calibre’s reserved & separator.");
  const after: MetadataValues = { title: correction.title.trim(), authors: correction.authors.map(a => (a as string).trim()) };
  if (new Set(after.authors.map(a => a.toLowerCase())).size !== after.authors.length) throw new ToolError("An author is listed more than once.");
  const before: MetadataValues = { title: b.title, authors: JSON.parse(b.authors) as string[] };
  if (!correction.before || typeof correction.before !== "object" || (correction.before as MetadataValues).title !== before.title || JSON.stringify((correction.before as MetadataValues).authors) !== JSON.stringify(before.authors)) throw new ToolError("This book's metadata changed. Reload it and review the correction again.");
  if (JSON.stringify(before) === JSON.stringify(after)) throw new ToolError("The title and authors are unchanged.");
  return { library, books: [{ calibre_id: b.calibre_id, uuid: b.uuid, title: b.title, before, after }] };
}
