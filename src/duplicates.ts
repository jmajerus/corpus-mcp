import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type BookRow, type Corpus, ToolError, getBook } from "./tools.js";
import { recordChanges } from "./data.js";
import { isbn13, validIsbn } from "./isbn.js";

const normal = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export interface DuplicateSelection { keep: string; remove: string; fingerprint: string; discard_conflicts?: boolean }

const REFERENCE_TABLES = ["quotes", "anchors", "citekeys", "zotero_links", "zotero_items", "tag_proposals"] as const;
const emptyReferences = () => Object.fromEntries(REFERENCE_TABLES.map(table => [table, 0]));

export function duplicateReferences(c: Corpus, uuid: string) {
  // Include filed Zotero items even when trashed: an active merged survivor can
  // still inherit the relationship through the old item's Calibre UUID.
  return Object.fromEntries(REFERENCE_TABLES.map(table => [table,
    c.data.prepare(`SELECT count(*) FROM ${table} WHERE calibre_uuid=?`).pluck().get(uuid) as number]));
}

function allReferences(c: Corpus) {
  const result = new Map<string, Record<string, number>>();
  for (const table of REFERENCE_TABLES) {
    for (const row of c.data.prepare(`SELECT calibre_uuid, count(*) AS n FROM ${table} WHERE calibre_uuid IS NOT NULL GROUP BY calibre_uuid`).all() as {calibre_uuid:string;n:number}[]) {
      const counts = result.get(row.calibre_uuid) ?? emptyReferences();
      counts[table] = row.n;
      result.set(row.calibre_uuid, counts);
    }
  }
  return result;
}

type CatalogueMetadata = Map<string, { identifiers: Record<string, string>; formats: string[] }>;
const catalogues = new WeakMap<Corpus, Map<string, { signature: string; metadata: CatalogueMetadata }>>();
function signature(file: string) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Re-read only catalogues changed by refresh (including atomic replacements).
 * Reference counts, indexed books and review decisions are deliberately not cached.
 */
function catalogue(c: Corpus) {
  const result: CatalogueMetadata = new Map();
  const cache = catalogues.get(c) ?? new Map();
  catalogues.set(c, cache);
  const libraries = c.db.prepare("SELECT DISTINCT library FROM books").pluck().all() as string[];
  for (const old of cache.keys()) if (!libraries.includes(old)) cache.delete(old);
  for (const library of libraries) {
    const file = path.join(c.booksRoot, library, "metadata.db");
    const mainStamp = signature(file);
    if (mainStamp === null) { cache.delete(library); continue; }
    const stamp = mainStamp + "|" + (signature(file + "-wal") ?? "");
    let entry = cache.get(library);
    if (entry?.signature !== stamp) {
      const metadata: CatalogueMetadata = new Map();
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        db.transaction(() => {
          for (const r of db.prepare("SELECT book,type,val FROM identifiers ORDER BY type,val").all() as {book:number;type:string;val:string}[]) {
            const key = `${library}:${r.book}`, item = metadata.get(key) ?? { identifiers: {}, formats: [] };
            item.identifiers[r.type] = r.val; metadata.set(key, item);
          }
          for (const r of db.prepare("SELECT book,format FROM data ORDER BY format").all() as {book:number;format:string}[]) {
            const key = `${library}:${r.book}`, item = metadata.get(key) ?? { identifiers: {}, formats: [] };
            item.formats.push(r.format); metadata.set(key, item);
          }
        })();
      } finally { db.close(); }
      entry = { signature: stamp, metadata };
      cache.set(library, entry);
    }
    for (const [key, item] of entry.metadata) result.set(key, item);
  }
  return result;
}

interface DuplicateCandidate {
  title: string; authors: string[]; format: string | null; sha256: string | null; identifiers: Record<string, string>;
}
const EVIDENCE = ["Identical selected file", "Matching identifier", "Matching title and authors"] as const;

/** One key per real-world identifier, whichever Calibre field holds it: a KFX import stores
 * the ASIN as bookid "urn:asin:…" where a MOBI import wrote mobi-asin, and ISBNs arrive as
 * isbn, EbookISBN or isbn-id, in ISBN-10 or ISBN-13 form. */
export function identifierKey(type: string, value: string): string[] | null {
  const t = type.toLowerCase();
  if (t === "citekey" || t === "calibre") return null;
  const urn = /^urn:(asin|isbn):(.+)$/i.exec(value.trim());
  const kind = urn ? urn[1].toLowerCase() : t.includes("asin") || t.startsWith("amazon") ? "asin" : t.includes("isbn") ? "isbn" : t;
  const id = (urn ? urn[2] : value).replace(/[\s-]/g, "").toLowerCase();
  if (!id) return null;
  const isbn = kind === "isbn" ? validIsbn(id) : null;
  return ["identifier", kind, isbn ? isbn13(isbn) : id];
}

/** Normalize each book once; enumerate only pairs that share a candidate key.
 * Large true-duplicate groups still need one result for each matching pair.
 */
export function duplicateCandidates(books: DuplicateCandidate[]) {
  const buckets = new Map<string, { evidence: typeof EVIDENCE[number]; members: Set<number> }>();
  const add = (key: unknown[], evidence: typeof EVIDENCE[number], index: number) => {
    const encoded = JSON.stringify(key);
    const bucket = buckets.get(encoded) ?? { evidence, members: new Set<number>() };
    bucket.members.add(index);
    buckets.set(encoded, bucket);
  };
  books.forEach((book, index) => {
    if (book.sha256) add(["file", book.format, book.sha256], EVIDENCE[0], index);
    for (const [type, value] of Object.entries(book.identifiers)) {
      const key = identifierKey(type, value);
      if (key) add(key, EVIDENCE[1], index);
    }
    const title = normal(book.title), authors = book.authors.map(normal).sort();
    if (title && authors.join("|") && !authors.includes("unknown")) add(["title-authors", title, authors], EVIDENCE[2], index);
  });
  const matches = new Map<string, { i: number; j: number; evidence: Set<typeof EVIDENCE[number]> }>();
  for (const { evidence, members } of buckets.values()) {
    const indexes = [...members];
    for (let a = 0; a < indexes.length; a++) for (let b = a + 1; b < indexes.length; b++) {
      const i = indexes[a], j = indexes[b], key = `${i}:${j}`;
      const match = matches.get(key) ?? { i, j, evidence: new Set<typeof EVIDENCE[number]>() };
      match.evidence.add(evidence); matches.set(key, match);
    }
  }
  return [...matches.values()].sort((a,b) => a.i - b.i || a.j - b.j).map(({i,j,evidence}) => ({i,j,evidence:EVIDENCE.filter(reason=>evidence.has(reason))}));
}

export function duplicatePairs(c: Corpus, writableLibrary: string, includeDismissed = false) {
  const metadata = catalogue(c), references = allReferences(c);
  const books = (c.db.prepare("SELECT * FROM books ORDER BY id").all() as BookRow[]).map(b => ({
    id: b.id, uuid: b.uuid, library: b.library, calibre_id: b.calibre_id, title: b.title,
    authors: JSON.parse(b.authors) as string[], year: b.year, format: b.format, status: b.status,
    error: b.error, sha256: b.sha256, file_size: b.file_size, identifiers: metadata.get(b.id)?.identifiers ?? {},
    formats: metadata.get(b.id)?.formats ?? (b.format ? [b.format.toUpperCase()] : []),
    references: b.uuid ? references.get(b.uuid) ?? emptyReferences() : {},
  }));
  const decisions = new Map((c.data.prepare("SELECT pair_key,fingerprint FROM duplicate_decisions").all() as {pair_key:string;fingerprint:string}[]).map(r => [r.pair_key,r.fingerprint]));
  const pairs = [];
  for (const {i,j,evidence} of duplicateCandidates(books)) {
    const a = books[i], b = books[j];
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
