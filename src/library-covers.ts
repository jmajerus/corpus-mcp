/**
 * The "covers" admin job: books in the writable library whose cover is a plain title page (or missing)
 * get the cover the Open Textbook Library shows for them. The preview looks each one up here and keeps
 * the covers it found beside data.db; the apply sends exactly those to the Calibre-Web host
 * (tools/calibre-covers.py), which sets each one only if the book's cover is still the one judged plain.
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { coverSha256, findCover } from "./covers.js";
import { type IsbnCandidate, ownPrintedIsbns } from "./isbn.js";
import { type Corpus, ToolError } from "./tools.js";

/** A cover the preview found for one book, as its job item carries it. */
export interface CoverFound {
  source: "otl";
  label: string;
  page_url: string | null;
  sha256: string;
  ext: "jpg" | "png";
  /** The book's cover.jpg when it was judged plain (null: it had none); the apply skips the book if it changed. */
  old_cover_sha256: string | null;
}

export interface CoverPlanBook { calibre_id: number; uuid: string; title: string; cover: CoverFound }
export interface CoverPlan { library: string; books: CoverPlanBook[] }

/** Where previewed covers are kept until applied, named by their checksum. */
export const coverCacheDir = (config: Pick<Config, "dataDbPath">) => path.join(path.dirname(config.dataDbPath), "covers");

interface CoverRow { id: string; uuid: string; calibre_id: number; title: string; authors: string; isbn: string | null; printed_isbns: string | null; folder: string }

/**
 * Looks at every book's cover and, for each plain one the Open Textbook Library lists, saves the cover it
 * shows and prints an "@@change" line for it (the job's items). Prints a summary at the end.
 */
export async function previewLibraryCovers(c: Corpus, config: Config, log: (text: string) => void): Promise<void> {
  if (!config.coverLookup) throw new ToolError("Cover lookup is off (CORPUS_COVER_LOOKUP=off).");
  const library = config.shelvesLibrary;
  const rows = c.db.prepare(`SELECT id, uuid, calibre_id, title, authors, isbn, printed_isbns, folder FROM books
    WHERE library = ? AND uuid IS NOT NULL ORDER BY calibre_id`).all(library) as CoverRow[];
  const dir = coverCacheDir(config);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dataDir = path.dirname(config.dataDbPath);
  let plain = 0, found = 0, failed = 0;
  const keep = new Set<string>();
  log(`Checking the covers of ${rows.length} books in ${library}…\n`);
  for (const b of rows) {
    const coverFile = path.join(c.booksRoot, b.folder, "cover.jpg");
    const printed = b.printed_isbns ? ownPrintedIsbns(JSON.parse(b.printed_isbns) as IsbnCandidate[]).map(x => x.isbn13 ?? x.isbn) : [];
    let result;
    try {
      result = await findCover({ title: b.title, authors: JSON.parse(b.authors) as string[], isbns: [b.isbn, ...printed].filter((i): i is string => !!i), current: { image: coverFile } },
        { dataDir, online: true });
    } catch (error) {
      failed++;
      log(`${b.id} ${b.title}: lookup failed (${(error as Error).message})\n`);
      continue;
    }
    if (result.plain) plain++;
    if (!result.cover) continue;
    found++;
    const sha256 = coverSha256(result.cover.bytes);
    const name = `${sha256}.${result.cover.ext}`;
    fs.writeFileSync(path.join(dir, name), result.cover.bytes, { mode: 0o600 });
    keep.add(name);
    const old = fs.existsSync(coverFile) ? coverSha256(fs.readFileSync(coverFile)) : null;
    const item: CoverFound = { source: "otl", label: result.cover.label, page_url: result.cover.page_url, sha256, ext: result.cover.ext, old_cover_sha256: old };
    log(`${b.id} ${b.title} ← Open Textbook Library: ${result.cover.label}\n`);
    log(`@@change ${JSON.stringify({ calibre_id: b.calibre_id, uuid: b.uuid, title: b.title, cover_found: item })}\n`);
  }
  // Covers from earlier previews that this one didn't find again are no longer needed.
  for (const f of fs.readdirSync(dir)) if (!keep.has(f) && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 86400_000) fs.rmSync(path.join(dir, f), { force: true });
  log(`${plain} book${plain === 1 ? " has a plain or missing cover" : "s have plain or missing covers"}; the Open Textbook Library has a cover for ${found}.` +
    (failed ? ` ${failed} couldn't be looked up.` : "") + "\n");
}

/** The apply's plan with each cover's bytes, read back from the cache and checked. */
export function attachCoverPayloads(config: Config, plan: CoverPlan) {
  const dir = coverCacheDir(config);
  return {
    library: plan.library,
    books: plan.books.map(b => {
      const file = path.join(dir, `${b.cover.sha256}.${b.cover.ext}`);
      const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (!bytes || coverSha256(bytes) !== b.cover.sha256) throw new ToolError(`The cover found for ${b.title} is no longer saved. Preview again.`);
      return { ...b, cover_base64: bytes.toString("base64") };
    }),
  };
}

/** A previewed cover, for the job page. */
export function cachedCoverFile(config: Config, name: string): { file: string; type: string } | null {
  if (!/^[0-9a-f]{64}\.(jpg|png)$/.test(name)) return null;
  const file = path.join(coverCacheDir(config), name);
  return fs.existsSync(file) ? { file, type: name.endsWith(".png") ? "image/png" : "image/jpeg" } : null;
}
