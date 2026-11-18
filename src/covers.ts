/**
 * Covers for books whose cover would be a plain title page. Calibre makes a PDF's cover from its first
 * page; many open textbooks (Pressbooks, LaTeX) start with a white page of text and keep their cover art
 * on the publisher's site instead. A cover is found, in order, from an image saved next to the book in the
 * intake folder, then from the Open Textbook Library (open.umn.edu), whose public catalogue is downloaded
 * and matched here, so OTL only sees which book pages are opened.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import type { BookFormat } from "./extract.js";
import { isbn13, validIsbn } from "./isbn.js";
import { pdfWorkers } from "./pdf-runner.js";
import { type PdfTask, runPdfTask, type Thumbnail } from "./pdf-tasks.js";

export interface CoverLook {
  /** Spread and strength of colour; below GREYSCALE_COVER an image reads as black and white. */
  colour: number;
  /** Mean luminance, 0 (black) to 255 (white). */
  light: number;
}

/** Below this a cover reads as black and white. */
export const GREYSCALE_COVER = 5;
/** A greyscale cover at least this light is a page of text on white, not cover art. */
export const PLAIN_LIGHT = 190;

export const isPlainCover = (look: CoverLook) => look.colour < GREYSCALE_COVER && look.light >= PLAIN_LIGHT;

/** How colourful and how light an image is, sampled on a grid of about 40,000 points. */
export function pixmapLook(source: mupdf.Pixmap): CoverLook {
  let pix = source;
  const colours = () => pix.getNumberOfComponents() - (pix.getAlpha() ? 1 : 0);
  if (colours() !== 1 && colours() !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
  const grey = colours() === 1;
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), stride = pix.getStride(), px = pix.getPixels();
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 40000)));
  let k = 0, light = 0, srg = 0, syb = 0, qrg = 0, qyb = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const o = y * stride + x * n;
    if (grey) { light += px[o]; k++; continue; }
    const r = px[o], g = px[o + 1], b = px[o + 2];
    light += 0.299 * r + 0.587 * g + 0.114 * b;
    const rg = r - g, yb = (r + g) / 2 - b;
    srg += rg; syb += yb; qrg += rg * rg; qyb += yb * yb; k++;
  }
  if (!k) return { colour: 0, light: 255 };
  if (grey) return { colour: 0, light: light / k };
  const mrg = srg / k, myb = syb / k;
  const colour = Math.sqrt(Math.max(0, qrg / k - mrg * mrg) + Math.max(0, qyb / k - myb * myb)) + 0.3 * Math.hypot(mrg, myb);
  return { colour, light: light / k };
}

/** The look of an image file's bytes, or null if MuPDF can't read it. */
export function imageLook(bytes: Uint8Array): CoverLook | null {
  try {
    return pixmapLook(new mupdf.Image(bytes).toPixmap());
  } catch {
    return null;
  }
}

const looks = new Map<string, CoverLook | null>();

/**
 * The look of a book's first page, as Calibre would make its cover, or of an image file (Calibre's
 * cover.jpg). Decoded on the PDF worker when there is one; cached by file identity.
 */
export async function firstPageLook(file: string, format: BookFormat | "image"): Promise<CoverLook | null> {
  let stamp: string;
  try { const st = fs.statSync(file); stamp = `${format}|${file}|${st.size}|${st.mtimeMs}`; } catch { return null; }
  if (looks.has(stamp)) return looks.get(stamp)!;
  const look = await renderLook(file, format);
  looks.set(stamp, look);
  return look;
}

async function renderLook(file: string, format: BookFormat | "image"): Promise<CoverLook | null> {
  const task: PdfTask = { kind: "thumb", file, format, width: 200 };
  try {
    const workers = pdfWorkers();
    const thumb = workers ? await workers.render.run<Thumbnail>(task) : (runPdfTask(task) as Thumbnail);
    return imageLook(Buffer.from(thumb.jpeg, "base64"));
  } catch {
    return null;
  }
}

/** One book in the Open Textbook Library catalogue. */
export interface OtlBook { id: number; title: string; authors: string[]; isbns: string[]; year: number | null; url: string }

const OTL_CATALOGUE = "https://open.umn.edu/opentextbooks/textbooks.json";
const OTL_HEADERS = { "User-Agent": "corpus-mcp cover lookup (+https://open.umn.edu/opentextbooks)" };
/** How long a downloaded catalogue is used before it is downloaded again. */
const CATALOGUE_DAYS = 7;
const MAX_COVER_BYTES = 10 * 1024 * 1024;

/** The HTTP client the lookups use; tests replace it. */
export const coverNet: { fetch: typeof fetch; pause: (ms: number) => Promise<void> } = {
  fetch: (...args) => fetch(...args),
  pause: (ms) => new Promise(r => setTimeout(r, ms)),
};

interface OtlContributor { contribution?: string; first_name?: string | null; middle_name?: string | null; last_name?: string | null; corporate?: boolean; corporate_name?: string | null }
interface OtlRecord { id: number; title: string; isbn13?: string | null; isbn10?: string | null; copyright_year?: number | null; url: string; contributors?: OtlContributor[] }

function otlBook(r: OtlRecord): OtlBook {
  const authors = (r.contributors ?? [])
    .filter(p => !p.contribution || /author|editor/i.test(p.contribution))
    .map(p => p.corporate ? (p.corporate_name ?? "") : [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" "))
    .map(a => a.trim()).filter(Boolean);
  const isbns = [r.isbn13, r.isbn10].map(i => (i ? validIsbn(i) : null)).filter((i): i is string => !!i).map(isbn13);
  return { id: r.id, title: r.title, authors, isbns: [...new Set(isbns)], year: r.copyright_year ?? null, url: r.url };
}

let loading: Promise<OtlBook[]> | null = null;

/**
 * The Open Textbook Library catalogue, kept beside data.db for a week. Downloading it takes about 200
 * requests, made one at a time; while that runs, other callers wait for the same download. If it fails,
 * an older copy is used when there is one.
 */
export async function otlCatalogue(dataDir: string): Promise<OtlBook[]> {
  const file = path.join(dataDir, "otl-catalogue.json");
  let stale: OtlBook[] | null = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { fetched_at: string; books: OtlBook[] };
    if (Date.now() - Date.parse(saved.fetched_at) < CATALOGUE_DAYS * 86400_000) return saved.books;
    stale = saved.books;
  } catch { /* none yet */ }
  loading ??= (async () => {
    try {
      const books: OtlBook[] = [];
      let next: string | null = `${OTL_CATALOGUE}?page=1`;
      for (let pages = 0; next && pages < 1000; pages++) {
        const res = await coverNet.fetch(next, { headers: { ...OTL_HEADERS, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`Open Textbook Library catalogue: HTTP ${res.status}`);
        const body = (await res.json()) as { data?: OtlRecord[]; links?: { next?: string | null } };
        books.push(...(body.data ?? []).map(otlBook));
        next = body.links?.next ?? null;
        if (next) await coverNet.pause(200);
      }
      fs.mkdirSync(dataDir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ fetched_at: new Date().toISOString(), books }));
      fs.renameSync(temp, file);
      return books;
    } catch (error) {
      if (stale) return stale;
      throw error;
    }
  })().finally(() => { loading = null; });
  return loading;
}

const EDITION = /\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|revised|updated)\s+edition\b|\b\d+(?:e|ed)\b|\([^)]*\)/gi;

/** A title for matching: no edition statement, bracketed note, accents, case or punctuation. */
export function titleKey(title: string): string {
  return title.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(EDITION, " ").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The family name, for matching: "Earle, Steven" and "Steven Earle" both give "earle". */
function surname(name: string): string {
  const n = name.includes(",") ? name.split(",")[0] : name.trim().split(/\s+/).at(-1) ?? "";
  return n.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * The catalogue entry for a book, or null. An ISBN shared with exactly one entry decides. Otherwise the
 * title must be the same (ignoring edition statements); where both sides name authors, a surname must be
 * shared and pick out one entry. Without the full title, the part before a colon will do only with a
 * shared surname. Anything weaker matches nothing, so a book never gets another book's cover.
 */
export function matchOtl(books: readonly OtlBook[], want: { title: string; authors: string[]; isbns: string[] }): OtlBook | null {
  const isbns = new Set(want.isbns.map(i => validIsbn(i)).filter((i): i is string => !!i).map(isbn13));
  const byIsbn = isbns.size ? books.filter(b => b.isbns.some(i => isbns.has(i))) : [];
  if (byIsbn.length === 1) return byIsbn[0];
  const surnames = new Set(want.authors.map(surname).filter(s => s.length > 1));
  const sharesAuthor = (b: OtlBook) => b.authors.some(a => surnames.has(surname(a)));
  const pick = (keyOf: (t: string) => string, needAuthor: boolean): OtlBook | null => {
    const key = keyOf(want.title);
    if (key.length < 6) return null;
    const titled = books.filter(b => keyOf(b.title) === key);
    const shared = titled.filter(sharesAuthor);
    if (shared.length === 1) return shared[0];
    if (shared.length || needAuthor) return null;
    return titled.length === 1 && (!surnames.size || !titled[0].authors.length) ? titled[0] : null;
  };
  return pick(titleKey, false) ?? pick(t => titleKey(t.split(":")[0]), true);
}

export interface FoundCover {
  source: "intake" | "otl";
  /** What the cover is: the image's file name, or the OTL entry's title. */
  label: string;
  /** The OTL book page it came from. */
  page_url: string | null;
  bytes: Buffer;
  ext: "jpg" | "png";
}

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

/** JPEG and PNG pass through; anything else MuPDF reads becomes a JPEG. Null if it can't be read. */
function normalImage(bytes: Buffer): { bytes: Buffer; ext: "jpg" | "png" } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return imageLook(bytes) ? { bytes, ext: "jpg" } : null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return imageLook(bytes) ? { bytes, ext: "png" } : null;
  try {
    let pix = new mupdf.Image(bytes).toPixmap();
    if (pix.getNumberOfComponents() - (pix.getAlpha() ? 1 : 0) !== 3 || pix.getAlpha()) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
    return { bytes: Buffer.from(pix.asJPEG(92)), ext: "jpg" };
  } catch {
    return null;
  }
}

/**
 * An image saved next to the book in the intake folder whose name contains the book's title or its file
 * name, such as "OER-Textbook-Cover-General-Microbiology-350x453.png" beside "General Microbiology.pdf".
 */
export function intakeImage(dir: string, bookFile: string, title: string): FoundCover | null {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const keys = [titleKey(title), titleKey(path.parse(bookFile).name)].filter(k => k.length >= 6);
  if (!keys.length) return null;
  const hits = names.filter(n => IMAGE_EXT.test(n) && keys.some(k => titleKey(path.parse(n).name).includes(k))).sort();
  for (const name of hits) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_COVER_BYTES) continue;
      const image = normalImage(fs.readFileSync(file));
      if (image) return { source: "intake", label: name, page_url: null, ...image };
    } catch { continue; }
  }
  return null;
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/**
 * The original of the image a book page shows as its cover. The page's <img class="cover"> is a resized
 * WebP variant (Rails Active Storage, …/representations/redirect/<blob>/<variation>/<name>); the same
 * blob's original is at …/blobs/redirect/<blob>/<name>. Its og:image is no use: a 1200×630 social card
 * with the cover in the middle of a band.
 */
export function otlCoverUrl(html: string, pageUrl: string): URL | null {
  const tag = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]).find(t => /class=["'][^"']*\bcover\b/i.test(t));
  const src = tag?.match(/\ssrc=["']([^"']+)["']/i)?.[1];
  if (!src || /placeholder/i.test(src)) return null;
  const url = new URL(decodeEntities(src), pageUrl);
  if (url.protocol !== "https:") return null;
  const variant = url.pathname.match(/^\/rails\/active_storage\/representations\/(?:redirect|proxy)\/([^/]+)\/[^/]+\/([^/]+)$/);
  if (!variant) return null;
  return new URL(`/rails/active_storage/blobs/redirect/${variant[1]}/${variant[2]}`, url);
}

/** The cover an OTL book page shows, or null if it has only the placeholder. */
export async function otlCover(book: OtlBook): Promise<FoundCover | null> {
  const page = await coverNet.fetch(book.url, { headers: { ...OTL_HEADERS, Accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
  if (!page.ok) throw new Error(`Open Textbook Library page ${book.url}: HTTP ${page.status}`);
  const url = otlCoverUrl(await page.text(), book.url);
  if (!url) return null;
  const res = await coverNet.fetch(url, { headers: OTL_HEADERS, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Open Textbook Library cover for ${book.title}: HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_COVER_BYTES) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_COVER_BYTES) return null;
  const image = normalImage(bytes);
  return image ? { source: "otl", label: book.title, page_url: book.url, ...image } : null;
}

export interface CoverQuery {
  title: string;
  authors: string[];
  isbns: string[];
  /** What the book's cover is now, or would be: an image (Calibre's cover.jpg, which may be missing) or the book's first page. */
  current: { image: string } | { book: string; format: BookFormat };
  /** The intake folder the book came from, searched for a cover image saved next to it. */
  intake?: { dir: string; file: string };
}

export interface CoverResult {
  /** Whether the current cover is a plain title page; null when it wasn't checked or couldn't be read. */
  plain: boolean | null;
  cover: FoundCover | null;
  /** The OTL entry matched, when one was. */
  matched: OtlBook | null;
}

/**
 * A better cover for one book. An image saved beside it in the intake folder is used whatever the current
 * cover looks like, since someone put it there. Otherwise only a plain title page is looked up, and only
 * when `online` (the Open Textbook Library).
 */
export async function findCover(q: CoverQuery, opts: { dataDir: string; online: boolean }): Promise<CoverResult> {
  if (q.intake) {
    const cover = intakeImage(q.intake.dir, q.intake.file, q.title);
    if (cover) return { plain: null, cover, matched: null };
  }
  if (!opts.online) return { plain: null, cover: null, matched: null };
  // A book with no cover at all is as bare as one with a plain title page.
  const look = "image" in q.current
    ? (fs.existsSync(q.current.image) ? await firstPageLook(q.current.image, "image") : { colour: 0, light: 255 })
    : await firstPageLook(q.current.book, q.current.format);
  if (!look) return { plain: null, cover: null, matched: null };
  if (!isPlainCover(look)) return { plain: false, cover: null, matched: null };
  const matched = matchOtl(await otlCatalogue(opts.dataDir), q);
  if (!matched) return { plain: true, cover: null, matched: null };
  return { plain: true, cover: await otlCover(matched), matched };
}

export const coverSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
