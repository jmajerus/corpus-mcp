import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type BookRow, type Corpus, ToolError, getBook } from "./tools.js";
import { recordChanges } from "./data.js";

const normal = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export interface DuplicateSelection { keep: string; remove: string; fingerprint: string; discard_conflicts?: boolean }

export function duplicateReferences(c: Corpus, uuid: string) {
  return Object.fromEntries(["quotes", "anchors", "citekeys", "zotero_links", "tag_proposals"].map(table => [table,
    c.data.prepare(`SELECT count(*) FROM ${table} WHERE calibre_uuid=?`).pluck().get(uuid) as number]));
}

/** Supplement the selected extraction format with the mirrored catalogue's identifiers and format list. */
function catalogue(c: Corpus) {
  const result = new Map<string, { identifiers: Record<string, string>; formats: string[] }>();
  for (const library of c.db.prepare("SELECT DISTINCT library FROM books").pluck().all() as string[]) {
    const file = path.join(c.booksRoot, library, "metadata.db");
    if (!fs.existsSync(file)) continue;
    const db = new Database(fs.readFileSync(file), { readonly: true });
    try {
      for (const r of db.prepare("SELECT book,type,val FROM identifiers ORDER BY type,val").all() as {book:number;type:string;val:string}[]) {
        const key = `${library}:${r.book}`, item = result.get(key) ?? { identifiers: {}, formats: [] };
        item.identifiers[r.type] = r.val; result.set(key, item);
      }
      for (const r of db.prepare("SELECT book,format FROM data ORDER BY format").all() as {book:number;format:string}[]) {
        const key = `${library}:${r.book}`, item = result.get(key) ?? { identifiers: {}, formats: [] };
        item.formats.push(r.format); result.set(key, item);
      }
    } finally { db.close(); }
  }
  return result;
}

export function duplicatePairs(c: Corpus, writableLibrary: string, includeDismissed = false) {
  const metadata = catalogue(c);
  const books = (c.db.prepare("SELECT * FROM books ORDER BY id").all() as BookRow[]).map(b => ({
    id: b.id, uuid: b.uuid, library: b.library, calibre_id: b.calibre_id, title: b.title,
    authors: JSON.parse(b.authors) as string[], year: b.year, format: b.format, status: b.status,
    error: b.error, sha256: b.sha256, file_size: b.file_size, identifiers: metadata.get(b.id)?.identifiers ?? {},
    formats: metadata.get(b.id)?.formats ?? (b.format ? [b.format.toUpperCase()] : []),
    references: b.uuid ? duplicateReferences(c, b.uuid) : {},
  }));
  const decisions = new Map((c.data.prepare("SELECT pair_key,fingerprint FROM duplicate_decisions").all() as {pair_key:string;fingerprint:string}[]).map(r => [r.pair_key,r.fingerprint]));
  const pairs = [];
  for (let i = 0; i < books.length; i++) for (let j = i + 1; j < books.length; j++) {
    const a = books[i], b = books[j], evidence: string[] = [];
    if (a.sha256 && a.sha256 === b.sha256 && a.format === b.format) evidence.push("Identical selected file");
    const identifiers = (x: typeof a) => Object.entries(x.identifiers).filter(([type]) => !["citekey", "calibre"].includes(type)).map(([type, value]) => `${type.includes("asin") ? "asin" : type.toLowerCase()}:${value.replace(/[\s-]/g, "").toLowerCase()}`);
    const ai = identifiers(a), bi = identifiers(b);
    if (ai.some(v => bi.includes(v))) evidence.push("Matching identifier");
    const authors = (x: typeof a) => x.authors.map(normal).sort().join("|");
    if (normal(a.title) && normal(a.title) === normal(b.title) && authors(a) && !a.authors.some(n => normal(n) === "unknown") && authors(a) === authors(b)) evidence.push("Matching title and authors");
    if (!evidence.length) continue;
    const key = JSON.stringify([a.id, b.id]), fingerprint = hash([a, b]);
    const dismissed = decisions.get(key) === fingerprint;
    if (dismissed && !includeDismissed) continue;
    pairs.push({ key, fingerprint, books: [a,b], evidence, dismissed,
      edition_warning: a.year !== b.year ? "Publication years differ; these may be different editions." : null,
      writable: a.library === writableLibrary && b.library === writableLibrary && a.uuid !== null && b.uuid !== null && a.uuid !== b.uuid });
  }
  return { pairs, total: pairs.length };
}

export function duplicatePlan(c: Corpus, library: string, selection: DuplicateSelection) {
  const pair = duplicatePairs(c, library).pairs.find(p => p.books.some(b => b.id === selection.keep) && p.books.some(b => b.id === selection.remove) && selection.keep !== selection.remove);
  if (!pair || pair.fingerprint !== selection.fingerprint) throw new ToolError("This duplicate review changed. Reload and review again.");
  if (!pair.writable) throw new ToolError("Resolve duplicates within the writable Calibre library only.");
  const keep = getBook(c, selection.keep), remove = getBook(c, selection.remove);
  assertDuplicateUnreferenced(c, remove.uuid!);
  return { library, keep: { id: keep.calibre_id, uuid: keep.uuid }, remove: { id: remove.calibre_id, uuid: remove.uuid }, discard_conflicts: selection.discard_conflicts === true };
}
export function assertDuplicateUnreferenced(c: Corpus, uuid: string) {
  const refs = duplicateReferences(c, uuid);
  if (Object.values(refs).some(n => n > 0)) throw new ToolError("The record to trash has saved references or a tag proposal. Resolve those links before trashing it.");
}
export function dismissDuplicate(c: Corpus, library: string, ids: string[], fingerprint: string, reopen: boolean, actor?: string) {
  const pair = duplicatePairs(c, library, true).pairs.find(p => p.books.map(b => b.id).every(id => ids.includes(id)) && ids.length === 2);
  if (!pair || pair.fingerprint !== fingerprint) throw new ToolError("This pair changed. Reload and review again.");
  if (reopen) c.data.prepare("DELETE FROM duplicate_decisions WHERE pair_key=?").run(pair.key);
  else c.data.prepare("INSERT OR REPLACE INTO duplicate_decisions(pair_key,fingerprint,reviewed_at,reviewed_by) VALUES(?,?,?,?)").run(pair.key,fingerprint,new Date().toISOString(),actor ?? null);
  recordChanges(c.data,[{kind:"duplicate_reviewed",source:"review",book_id:pair.books[0].id,detail:JSON.stringify({ids,decision:reopen?"reopened":"keep-both"}),actor}]);
  return { saved: true };
}
