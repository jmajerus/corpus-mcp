import { proposeCitekey, DEFAULT_PRESET } from "./citekey.js";
import { personName } from "./titlepage.js";
import { pinnedByUuid } from "./data.js";
import { getBook, ToolError, type Corpus } from "./tools.js";

export interface MetadataValues { title: string; authors: string[]; year: number | null }
export interface MetadataCorrection { book_id: string; title: unknown; authors: unknown; year: unknown; before: unknown }

/** Only the fields reviewed on the book page. The source verifies identity and these before-values again. */
export function metadataRepairPlan(c: Corpus, library: string, correction: MetadataCorrection, allowUnchanged = false) {
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
  if (!allowUnchanged && JSON.stringify(before) === JSON.stringify(after)) throw new ToolError("The title, authors, and publication year are unchanged.");
  return { library, books: [{ calibre_id: b.calibre_id, uuid: b.uuid, title: b.title, before, after }] };
}


/** A draft is provisional when new names have not yet been sorted by Calibre. */
export function metadataCitekeyPreview(c: Corpus, library: string, correction: MetadataCorrection) {
  const plan = metadataRepairPlan(c, library, correction, true);
  const b = getBook(c, correction.book_id), after = plan.books[0].after;
  const names = (JSON.parse(b.authors) as string[]).map(n => n.replaceAll("|", ","));
  const sorts = JSON.parse(b.author_sorts) as string[];
  let provisional = false;
  const authorSorts = after.authors.map(name => {
    const index = names.indexOf(name);
    if (index >= 0 && sorts[index]) return sorts[index];
    provisional = true;
    if (!personName(name)) return name;
    const suffix = name.match(/,\s*(?:Jr\.?|Sr\.?|II|III|IV)$/i)?.[0] ?? "";
    const words = name.slice(0, suffix ? -suffix.length : undefined).trim().split(/\s+/);
    let start = words.length - 1;
    while (start > 0 && /^(?:de|da|di|del|della|der|den|van|von|la|le|du|dos|das|bin|ibn|al|el)$/i.test(words[start-1])) start--;
    return `${words.slice(start).join(" ")}, ${words.slice(0,start).join(" ")}${suffix}`;
  });
  const proposal = proposeCitekey({title:after.title,authors:after.authors,authorSorts,publisher:b.publisher,year:after.year},c.citekeyPreset ?? DEFAULT_PRESET);
  return { generated: proposal.key, blockers: proposal.blockers, provisional,
    assigned: b.calibre_citekey ?? pinnedByUuid(c.data,b.uuid)?.citekey ?? null };
}
