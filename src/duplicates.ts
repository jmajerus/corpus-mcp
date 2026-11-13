import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as mupdf from "mupdf";
import { type BookRow, type Corpus, ToolError } from "./tools.js";
import { recordChanges } from "./data.js";
import { isbn13, validIsbn } from "./isbn.js";
import { type BookContents, contentFindings, contentProfile } from "./duplicate-contents.js";

const normal = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

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

type CatalogueMetadata = Map<string, { identifiers: Record<string, string>; formats: string[]; sizes: Record<string, number>; files: Record<string, string> }>;
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
            const key = `${library}:${r.book}`, item = metadata.get(key) ?? { identifiers: {}, formats: [], sizes: {}, files: {} };
            item.identifiers[r.type] = r.val; metadata.set(key, item);
          }
          // Calibre records each format's size; an older or hand-made catalogue may lack the column.
          const sized = (db.prepare("SELECT name FROM pragma_table_info('data')").pluck().all() as string[]).includes("uncompressed_size");
          for (const r of db.prepare(`SELECT book,format,name${sized ? ",uncompressed_size AS size" : ""} FROM data ORDER BY format`).all() as {book:number;format:string;name:string;size?:number}[]) {
            const key = `${library}:${r.book}`, item = metadata.get(key) ?? { identifiers: {}, formats: [], sizes: {}, files: {} };
            item.formats.push(r.format); item.files[r.format] = `${r.name}.${r.format.toLowerCase()}`; if (r.size) item.sizes[r.format] = r.size; metadata.set(key, item);
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

/** How colourful a cover is (Hasler–Süsstrunk; 0 for greyscale, typically 15–150 for colour), or
 * null without a readable cover. Cached by file identity: covers change only when Calibre replaces them. */
const coverColours = new Map<string, number | null>();
export function coverColour(file: string): number | null {
  let stamp: string;
  try { const st = fs.statSync(file); stamp = `${file}|${st.size}|${st.mtimeMs}`; } catch { return null; }
  if (coverColours.has(stamp)) return coverColours.get(stamp)!;
  let result: number | null = null;
  try {
    let pix = new mupdf.Image(fs.readFileSync(file)).toPixmap();
    if (pix.getNumberOfComponents() - (pix.getAlpha() ? 1 : 0) === 1) result = 0;
    else {
      if (pix.getNumberOfComponents() - (pix.getAlpha() ? 1 : 0) !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
      const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), stride = pix.getStride(), px = pix.getPixels();
      const step = Math.max(1, Math.round(Math.sqrt((w * h) / 40000)));
      let k = 0, srg = 0, syb = 0, qrg = 0, qyb = 0;
      for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
        const o = y * stride + x * n, r = px[o], g = px[o + 1], b = px[o + 2];
        const rg = r - g, yb = (r + g) / 2 - b;
        srg += rg; syb += yb; qrg += rg * rg; qyb += yb * yb; k++;
      }
      const mrg = srg / k, myb = syb / k;
      result = Math.sqrt(Math.max(0, qrg / k - mrg * mrg) + Math.max(0, qyb / k - myb * myb)) + 0.3 * Math.hypot(mrg, myb);
    }
  } catch { result = null; }
  coverColours.set(stamp, result);
  return result;
}
/** Below this a cover reads as black and white. */
export const GREYSCALE_COVER = 5;

type DuplicateBook = ReturnType<typeof candidateBooks>[number];
function candidateBooks(c: Corpus) {
  const metadata = catalogue(c), references = allReferences(c), shelves = new Map<string, string[]>();
  for (const r of c.db.prepare("SELECT bs.book_id, s.name FROM book_shelves bs JOIN shelves s ON s.id = bs.shelf_id ORDER BY s.name").all() as { book_id: string; name: string }[]) {
    shelves.set(r.book_id, [...(shelves.get(r.book_id) ?? []), r.name]);
  }
  return (c.db.prepare("SELECT * FROM books ORDER BY id").all() as (BookRow & { folder: string })[]).map(b => {
    const book = {
      id: b.id, uuid: b.uuid, library: b.library, calibre_id: b.calibre_id, title: b.title,
      authors: JSON.parse(b.authors) as string[], year: b.year, format: b.format, status: b.status,
      error: b.error, sha256: b.sha256, file_size: b.file_size, identifiers: metadata.get(b.id)?.identifiers ?? {},
      formats: metadata.get(b.id)?.formats ?? (b.format ? [b.format.toUpperCase()] : []),
      references: b.uuid ? references.get(b.uuid) ?? emptyReferences() : {},
    };
    // `added`, shelves, the cover and the contents only rank the suggested keeper; they stay out of
    // the fingerprints, so keep-both decisions hold. Covers and contents are read only for candidates (see below).
    return { ...book, added: b.added ?? null, shelves: shelves.get(b.id) ?? [], cover_colour: null as number | null, folder: b.folder,
      sizes: metadata.get(b.id)?.sizes ?? {}, files: metadata.get(b.id)?.files ?? {}, contents: {} as BookContents, content_flags: 0, fingerprint: hash(book) };
  });
}
const hashed = ({ added: _added, shelves: _shelves, cover_colour: _cover, folder: _folder, sizes: _sizes, files: _files, contents: _contents, content_flags: _flags, fingerprint: _fingerprint, ...book }: DuplicateBook) => book;

/** Copies whose EPUB or PDF sizes differ by this fraction or more are flagged (as in tools/calibre-duplicates.py). */
export const SIZE_DIFFERENCE = 0.1;
const sizeLabel = (n: number) => n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
/** How far apart two sizes are: a percentage under 2×, a factor from there. */
export const sizeGap = (ratio: number) => ratio < 2 ? `by ${Math.round((ratio - 1) * 100)}%` : `${ratio.toFixed(1)}×`;
/** Not a blocker: copies of one book whose EPUB or PDF differ in size suggest one is incomplete,
 * a sample, another edition or a different conversion. */
export function sizeWarnings(books: { id: string; sizes: Record<string, number> }[]) {
  const warnings: string[] = [];
  for (const fmt of ["EPUB", "PDF"]) {
    const sized = books.filter(b => b.sizes[fmt]);
    if (sized.length < 2) continue;
    const values = sized.map(b => b.sizes[fmt]), ratio = Math.max(...values) / Math.min(...values);
    if (ratio >= 1 + SIZE_DIFFERENCE) warnings.push(`${fmt} sizes differ ${sizeGap(ratio)}: ${sized.map(b => `${b.id} ${sizeLabel(b.sizes[fmt])}`).join(", ")}. One copy may be incomplete, a sample, another edition or a different conversion.`);
  }
  return warnings;
}
const referenced = (b: DuplicateBook) => Object.values(b.references).some(n => n > 0);

export function duplicatePairs(c: Corpus, writableLibrary: string, includeDismissed = false) {
  const books = candidateBooks(c);
  const decisions = new Map((c.data.prepare("SELECT pair_key,fingerprint FROM duplicate_decisions").all() as {pair_key:string;fingerprint:string}[]).map(r => [r.pair_key,r.fingerprint]));
  const pairs = [];
  for (const {i,j,evidence} of duplicateCandidates(books)) {
    const a = books[i], b = books[j];
    const key = JSON.stringify([a.id, b.id]), fingerprint = hash([hashed(a), hashed(b)]);
    const dismissed = decisions.get(key) === fingerprint;
    if (dismissed && !includeDismissed) continue;
    pairs.push({ key, fingerprint, books: [a,b], evidence, dismissed,
      edition_warning: a.year !== b.year ? "Publication years differ; these may be different editions." : null,
      writable: a.library === writableLibrary && b.library === writableLibrary && a.uuid !== null && b.uuid !== null && a.uuid !== b.uuid });
  }
  return { pairs, total: pairs.length };
}

/** Books linked by candidate pairs, for review as one group. A record can be trashed only into a
 * keeper it pairs with directly (and not as a reviewed keep-both pair); a chain A–B–C does not let
 * C merge into A. The suggested keeper is a referenced record, then the one whose EPUB or PDF falls
 * short least against its duplicates, then one with a colour cover, then
 * one on a Calibre-Web shelf, then an indexed one, then the one with the most formats, then the one
 * added to Calibre first (by its added date, then its id). */
export function duplicateGroups(c: Corpus, writableLibrary: string, includeDismissed = false) {
  const { pairs } = duplicatePairs(c, writableLibrary, includeDismissed);
  const parent = new Map<string, string>();
  const find = (id: string): string => { const p = parent.get(id) ?? id; if (p === id) return id; const root = find(p); parent.set(id, root); return root; };
  for (const p of pairs) parent.set(find(p.books[0].id), find(p.books[1].id));
  type Group = { books: Map<string, DuplicateBook>; pairs: typeof pairs };
  const groups = new Map<string, Group>();
  for (const p of pairs) {
    const root = find(p.books[0].id), group: Group = groups.get(root) ?? { books: new Map(), pairs: [] };
    for (const b of p.books) group.books.set(b.id, b);
    group.pairs.push(p); groups.set(root, group);
  }
  for (const g of groups.values()) {
    for (const b of g.books.values()) {
      b.cover_colour = coverColour(path.join(c.booksRoot, b.folder, "cover.jpg"));
      for (const fmt of ["EPUB", "PDF"] as const) {
        if (b.files[fmt]) b.contents[fmt] = contentProfile(path.join(c.booksRoot, b.folder, b.files[fmt]), fmt);
      }
    }
    const books = [...g.books.values()];
    for (const w of contentFindings(books, []).content_warnings) for (const id of w.against) g.books.get(id)!.content_flags++;
  }
  const colour = (b: DuplicateBook) => b.cover_colour !== null && b.cover_colour >= GREYSCALE_COVER;
  // Lower is better, in order. A referenced record must be the keeper. The keeper's files and cover are
  // what survive, so the copy whose EPUB or PDF falls short least (missing figures, contents or print
  // pages, fewer words, a scanned PDF) comes first, then a colour cover over a black-and-white or missing
  // one (older MOBI-era records often carry greyscale covers). Shelf links move to the keeper either
  // way, so a shelf only breaks ties.
  const criteria: [string, (b: DuplicateBook) => number][] = [
    ["has saved references", b => referenced(b) ? 0 : 1],
    ["has the most complete contents", b => b.content_flags],
    ["has a colour cover", b => colour(b) ? 0 : 1],
    ["is on a Calibre-Web shelf", b => b.shelves.length ? 0 : 1],
    ["is indexed", b => b.status === "indexed" ? 0 : 1],
    ["has the most formats", b => -b.formats.length],
  ];
  const before = (a: DuplicateBook, b: DuplicateBook) => {
    for (const [, f] of criteria) if (f(a) !== f(b)) return f(a) - f(b);
    // An unknown added date sorts after a known one.
    if (a.added !== b.added) return a.added === null ? 1 : b.added === null ? -1 : a.added < b.added ? -1 : 1;
    return a.calibre_id - b.calibre_id;
  };
  /** The first criterion that set the suggested keeper apart from the rest. */
  const reason = (keep: DuplicateBook, others: DuplicateBook[]) =>
    criteria.find(([, f]) => others.every(o => f(keep) < f(o)))?.[0] ?? (others.every(o => keep.added !== null && (o.added === null || keep.added < o.added)) ? "was added to Calibre first" : "has the lowest Calibre id");
  const result = [...groups.values()].map(g => {
    const books = [...g.books.values()].sort((a, b) => a.calibre_id - b.calibre_id);
    const suggested = [...books].sort(before)[0];
    const findings = contentFindings(books, sizeWarnings(books));
    // The text sketches only serve the comparison; the page gets the profiles without them.
    for (const b of books) b.contents = Object.fromEntries(Object.entries(b.contents).map(([f, p]) => [f, "sketch" in p ? (({ sketch: _sketch, ...rest }) => rest)(p) : p]));
    return {
      key: books.map(b => b.id).join("|"), books, pairs: g.pairs, suggested_keep: suggested.id,
      suggested_because: reason(suggested, books.filter(b => b !== suggested)),
      ...findings,
      identical: g.pairs.every(p => p.evidence.includes("Identical selected file")),
      writable: g.pairs.every(p => p.writable),
    };
  }).sort((a, b) => a.books[0].calibre_id - b.books[0].calibre_id);
  return { groups: result, pairs: pairs.length };
}

/** The content findings of the groups these keepers head, by the keeper's Calibre id, for the preview
 * page: the source helper compares only file sizes. */
export function duplicateContents(c: Corpus, writableLibrary: string, keepers: string[]) {
  const out: Record<number, { warnings: string[]; notes: string[] }> = {};
  // The same groups as the review screen and the plan: reviewed keep-both pairs do not link groups.
  for (const g of duplicateGroups(c, writableLibrary).groups) {
    const keep = g.books.find(b => keepers.includes(b.id));
    if (keep && (g.content_warnings.length || g.content_notes.length)) out[keep.calibre_id] = { warnings: g.content_warnings.map(w => w.message), notes: g.content_notes };
  }
  return out;
}

export interface DuplicateGroupSelection { keep: string; remove: string[]; fingerprints: Record<string, string>; discard_conflicts?: boolean }
export interface DuplicateBatchPlan { library: string; groups: { keep: { id: number; uuid: string }; remove: { id: number; uuid: string }[]; discard_conflicts: boolean }[] }

/** Checks a batch of reviewed groups against the current index: each book unchanged since the
 * page showed it, in one group only, writable, and each trashed record unreferenced and paired
 * directly with its keeper. */
export function duplicateBatchPlan(c: Corpus, library: string, selections: DuplicateGroupSelection[]): DuplicateBatchPlan {
  if (!selections.length) throw new ToolError("Choose at least one duplicate group.");
  const { pairs } = duplicatePairs(c, library);
  const books = new Map(pairs.flatMap(p => p.books.map(b => [b.id, b] as const)));
  const paired = new Map(pairs.map(p => [[p.books[0].id, p.books[1].id].sort().join("|"), p]));
  const used = new Set<string>();
  const groups = selections.map(s => {
    const ids = [s.keep, ...s.remove];
    if (!s.remove.length) throw new ToolError(`Choose at least one record to trash beside keeper ${s.keep}.`);
    for (const id of ids) {
      if (used.has(id)) throw new ToolError(`${id} appears in more than one group. Choose it once.`);
      used.add(id);
      const book = books.get(id);
      if (!book || s.fingerprints[id] !== book.fingerprint) throw new ToolError(`${id} changed or is no longer a duplicate candidate. Reload and review again.`);
    }
    const keep = books.get(s.keep)!;
    const remove = s.remove.map(id => {
      const pair = paired.get([s.keep, id].sort().join("|"));
      if (!pair) throw new ToolError(`${id} is not a duplicate candidate of keeper ${s.keep}. Choose a keeper it matches directly.`);
      if (!pair.writable) throw new ToolError("Resolve duplicates within the writable Calibre library only.");
      const book = books.get(id)!;
      assertDuplicateUnreferenced(c, book.uuid!, id);
      return { id: book.calibre_id, uuid: book.uuid! };
    });
    return { keep: { id: keep.calibre_id, uuid: keep.uuid! }, remove, discard_conflicts: s.discard_conflicts === true };
  });
  return { library, groups };
}
export function assertDuplicateUnreferenced(c: Corpus, uuid: string, label = "The record to trash") {
  const refs = duplicateReferences(c, uuid);
  if (Object.values(refs).some(n => n > 0)) throw new ToolError(`${label} has saved references or a tag proposal. Resolve those links before trashing it.`);
}
export function dismissDuplicate(c: Corpus, library: string, ids: string[], fingerprint: string, reopen: boolean, actor?: string) {
  const pair = duplicatePairs(c, library, true).pairs.find(p => p.books.map(b => b.id).every(id => ids.includes(id)) && ids.length === 2);
  if (!pair || pair.fingerprint !== fingerprint) throw new ToolError("This pair changed. Reload and review again.");
  if (reopen) c.data.prepare("DELETE FROM duplicate_decisions WHERE pair_key=?").run(pair.key);
  else c.data.prepare("INSERT OR REPLACE INTO duplicate_decisions(pair_key,fingerprint,reviewed_at,reviewed_by) VALUES(?,?,?,?)").run(pair.key,fingerprint,new Date().toISOString(),actor ?? null);
  recordChanges(c.data,[{kind:"duplicate_reviewed",source:"review",book_id:pair.books[0].id,detail:JSON.stringify({ids,decision:reopen?"reopened":"keep-both"}),actor}]);
  return { saved: true };
}
