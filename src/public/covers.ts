import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BookFormat } from "../extract.js";
import { pdfWorkers } from "../pdf-runner.js";
import { type PdfTask, type Thumbnail, runPdfTask } from "../pdf-tasks.js";

/**
 * Cover thumbnails for the public catalogue (CORPUS_PUBLIC_COVERS): a small JPEG of each public book's
 * cover, from Calibre's cover.jpg in the book's folder, or the first page of a PDF that has none, as the
 * admin pages' covers are.
 *
 * Thumbnails are cached in covers/ beside the snapshot, each named by a stamp: a hash of its source file's
 * identity (path, size, modification time) and of how it's made. Calibre replaces cover.jpg when a cover
 * changes, so a new stamp means a new cover. The snapshot gives each book its stamp; the drain ships the
 * thumbnail to R2 when the stamp changes, and the pages add it to the cover's URL so browsers fetch the new one.
 * A source MuPDF can't read is remembered (<stamp>.failed) and not tried again until the file changes.
 */

/** Thumbnails are this many pixels wide, shown at half that, for high-density screens. */
export const COVER_WIDTH = 240;
/** Changing how thumbnails are made changes every stamp, so each is made and shipped again. */
const COVER_VERSION = 1;

/** The thumbnail cache beside the snapshot. */
export function coversDir(snapshotFile: string): string {
  return path.join(path.dirname(snapshotFile), "covers");
}

export const coverFile = (dir: string, stamp: string) => path.join(dir, `${stamp}.jpg`);

export interface CoverBook { id: string; folder: string | null; format: BookFormat | null; file_path: string | null }

/** Where a book's cover comes from: its cover.jpg, else a PDF's first page; null when it has neither. */
function coverSource(booksRoot: string, b: CoverBook): { file: string; format: BookFormat | "image" } | null {
  const root = path.resolve(booksRoot);
  const inside = (f: string) => f.startsWith(root + path.sep);
  if (b.folder) {
    const file = path.resolve(root, b.folder, "cover.jpg");
    if (inside(file) && fs.existsSync(file)) return { file, format: "image" };
  }
  if (b.format === "pdf" && b.file_path) {
    const file = path.resolve(root, b.file_path);
    if (inside(file) && fs.existsSync(file)) return { file, format: "pdf" };
  }
  return null;
}

/**
 * Makes the thumbnails the books need that aren't cached, in the background MuPDF worker when the server
 * runs one, and removes cached ones no book needs any more. Returns each book's stamp; a book without a
 * readable cover has none.
 */
export async function prepareCovers(booksRoot: string, books: CoverBook[], dir: string, log: (line: string) => void = () => {}): Promise<Map<string, string>> {
  fs.mkdirSync(dir, { recursive: true });
  const stamps = new Map<string, string>();
  const keep = new Set<string>();
  const workers = pdfWorkers();
  let made = 0;
  let failed = 0;
  for (const b of books) {
    const source = coverSource(booksRoot, b);
    if (!source) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(source.file);
    } catch {
      continue;
    }
    const stamp = createHash("sha256").update(`${COVER_VERSION}|${COVER_WIDTH}|${source.file}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
    const jpeg = coverFile(dir, stamp);
    const failure = path.join(dir, `${stamp}.failed`);
    keep.add(path.basename(jpeg));
    keep.add(path.basename(failure));
    if (fs.existsSync(failure)) continue;
    if (!fs.existsSync(jpeg)) {
      const task: PdfTask = { kind: "thumb", file: source.file, format: source.format, width: COVER_WIDTH };
      try {
        const thumb = workers ? await workers.profile.run<Thumbnail>(task) : (runPdfTask(task) as Thumbnail);
        const temp = `${jpeg}.${process.pid}.tmp`;
        fs.writeFileSync(temp, Buffer.from(thumb.jpeg, "base64"));
        fs.renameSync(temp, jpeg);
        made++;
      } catch (error) {
        fs.writeFileSync(failure, `${(error as Error).message}\n`);
        failed++;
        continue;
      }
    }
    stamps.set(b.id, stamp);
  }
  for (const f of fs.readdirSync(dir)) {
    if (!keep.has(f) && !f.endsWith(".tmp")) fs.rmSync(path.join(dir, f), { force: true });
  }
  if (made || failed) log(`covers: ${made} made${failed ? `, ${failed} couldn't be read` : ""}`);
  return stamps;
}
