import fs from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import * as mupdf from "mupdf";

/** What a copy's EPUB or PDF holds, to compare duplicates by more than file size. */
export interface ContentProfile {
  words: number;
  /** Table-of-contents entries: the EPUB's NCX or nav document, or the PDF's bookmarks. */
  contents: number;
  /** Links within the book's text (notes, index, cross-references), outside its navigation. */
  links: number;
  /** EPUB only: print pages mapped by a page list, so passages can be cited by printed page. */
  page_list?: number;
  /** Wording that a store's free sample ends with. */
  sample: boolean;
  /** EPUB only: the archive's uncompressed bytes by kind. */
  images?: number; image_bytes?: number; font_bytes?: number; text_bytes?: number;
  /** PDF only: pages, pages carrying a text layer, and whether pages have printed labels. */
  pages?: number; text_pages?: number; page_labels?: boolean;
}
export type BookContents = Partial<Record<"EPUB" | "PDF", ContentProfile | { error: string }>>;

const SAMPLE = /\b(end of (this |the )?(free )?sample|you(’|')ve (been reading|reached the end of) (a|this) (free )?sample|buy (the|this) (full )?book now)\b/i;
const countWords = (text: string) => text.match(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;

/** Visible text of an (X)HTML document, without markup. */
function htmlText(html: string) {
  return html.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|#160|#xa0);/gi, " ").replace(/&[#\w]+;/g, "’");
}

export function epubProfile(data: Uint8Array): ContentProfile {
  const files = unzipSync(data);
  const p = { words: 0, contents: 0, links: 0, sample: false, page_list: 0, images: 0, image_bytes: 0, font_bytes: 0, text_bytes: 0 };
  const count = (source: string, tag: RegExp) => source.match(tag)?.length ?? 0;
  let text = "";
  for (const [name, bytes] of Object.entries(files)) {
    const ext = name.toLowerCase().split(".").pop() ?? "";
    if (/^(jpe?g|png|gif|svg|webp|bmp|tiff?)$/.test(ext)) { p.images++; p.image_bytes += bytes.length; }
    else if (/^(ttf|otf|woff2?)$/.test(ext)) p.font_bytes += bytes.length;
    else if (ext === "ncx") {
      const ncx = strFromU8(bytes);
      p.contents = Math.max(p.contents, count(ncx, /<navPoint\b/g));
      p.page_list = Math.max(p.page_list, count(ncx, /<pageTarget\b/g));
    }
    else if (/^(x?html?)$/.test(ext)) {
      p.text_bytes += bytes.length;
      const html = strFromU8(bytes);
      // The EPUB 3 navigation document: its table of contents and page list, not text.
      const navs = [...html.matchAll(/<nav\b[^>]*epub:type\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/nav>/gi)];
      if (navs.length) {
        for (const [, type, body] of navs) {
          if (/\btoc\b/.test(type)) p.contents = Math.max(p.contents, count(body, /<a\b/gi));
          else if (/\bpage-list\b/.test(type)) p.page_list = Math.max(p.page_list, count(body, /<a\b/gi));
        }
        continue;
      }
      p.links += (html.match(/<a\b[^>]*\bhref\s*=\s*["'](?![a-z][\w+.-]*:)[^"']+["']/gi) ?? []).length;
      const t = htmlText(html);
      p.words += countWords(t);
      text += t.slice(-4000) + " ";
    }
  }
  p.sample = SAMPLE.test(text);
  return p;
}

export function pdfProfile(data: Uint8Array): ContentProfile {
  const doc = mupdf.Document.openDocument(data, "book.pdf");
  try {
    let count = 0;
    const walk = (items: NonNullable<ReturnType<mupdf.Document["loadOutline"]>>) => { for (const i of items) { count++; if (i.down) walk(i.down); } };
    walk(doc.loadOutline() ?? []);
    const p = { words: 0, contents: count, links: 0, sample: false, pages: doc.countPages(), text_pages: 0, page_labels: false };
    let tail = "";
    for (let i = 0; i < p.pages; i++) {
      const page = doc.loadPage(i);
      try {
        const text = page.toStructuredText("preserve-whitespace").asText();
        const words = countWords(text);
        p.words += words;
        if (words >= 10) p.text_pages++;
        if (i >= p.pages - 3) tail += text;
        p.links += page.getLinks().filter(l => !l.isExternal()).length;
        const label = page.getLabel();
        if (label && label !== String(i + 1)) p.page_labels = true;
      } finally { page.destroy(); }
    }
    p.sample = SAMPLE.test(tail);
    return p;
  } finally { doc.destroy(); }
}

/** Profiles cached by file identity, like cover colours: a file changes only when Calibre replaces it. */
const profiles = new Map<string, ContentProfile | { error: string }>();
export function contentProfile(file: string, format: "EPUB" | "PDF"): ContentProfile | { error: string } | null {
  let stamp: string;
  try { const st = fs.statSync(file); stamp = `${file}|${st.size}|${st.mtimeMs}`; } catch { return null; }
  let result = profiles.get(stamp);
  if (!result) {
    try { result = (format === "EPUB" ? epubProfile : pdfProfile)(fs.readFileSync(file)); }
    catch (error) { result = { error: `Could not read the ${format}: ${(error as Error).message}` }; }
    profiles.set(stamp, result);
  }
  return result;
}

const kb = (n: number) => n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

export type Measure = "error" | "sample" | "words" | "pages" | "text_pages" | "contents" | "page_list" | "links" | "images";
export interface ContentWarning { format: "EPUB" | "PDF"; measure: Measure; message: string; against: string[] }

/**
 * Where copies of one book differ in substance, per format, naming the weaker copy. Each warning
 * lists the ids it counts against, which the keeper ranking prefers to avoid. A size gap whose copies
 * agree on text and structure becomes a note that explains it.
 */
export function contentFindings(books: { id: string; contents: BookContents }[], sizeWarnings: string[]) {
  const warnings: ContentWarning[] = [], notes: string[] = [];
  const flagged = new Set<string>();
  for (const format of ["EPUB", "PDF"] as const) {
    const before = warnings.length;
    const warn = (measure: Measure, id: string, message: string) => warnings.push({ format, measure, message, against: [id] });
    const all = books.map(b => ({ id: b.id, p: b.contents[format] })).filter(x => x.p);
    for (const x of all) if ("error" in x.p!) warn("error", x.id, `${x.id}: ${x.p.error}`);
    const copies = all.filter((x): x is { id: string; p: ContentProfile } => !("error" in x.p!));
    for (const c of copies) if (c.p.sample) warn("sample", c.id, `${c.id}’s ${format} ends like a store sample.`);
    if (copies.length < 2 || copies.length < all.length) { flagged.add(format); continue; }
    /** Copies that fall well short of the best copy on one measure. */
    const short = (measure: Measure, value: (p: ContentProfile) => number | undefined, falls: (low: number, high: number) => boolean,
      say: (c: { id: string; n: number }, best: { id: string; n: number }) => string) => {
      const counted = copies.map(c => ({ id: c.id, n: value(c.p) })).filter((c): c is { id: string; n: number } => c.n !== undefined);
      if (counted.length < 2) return;
      const best = counted.reduce((a, b) => b.n > a.n ? b : a);
      for (const c of counted) if (c !== best && falls(c.n, best.n)) warn(measure, c.id, say(c, best));
    };
    const n = (x: number) => x.toLocaleString("en");
    short("words", p => p.words, (a, b) => a < b * 0.95,
      (c, b) => `${c.id}’s ${format} has ${Math.round((1 - c.n / b.n) * 100)}% fewer words than ${b.id}’s (${n(c.n)} vs ${n(b.n)}): it may be missing chapters, be abridged, or be another edition.`);
    short("pages", p => p.pages, (a, b) => a < b * 0.98 && b - a >= 3, (c, b) => `${c.id}’s PDF has ${n(c.n)} pages; ${b.id}’s has ${n(b.n)}.`);
    short("text_pages", p => p.text_pages !== undefined && p.pages ? p.text_pages / p.pages : undefined, (a, b) => a < 0.5 && b >= 0.9,
      (c, b) => `${c.id}’s PDF has text on only ${Math.round(c.n * 100)}% of its pages (${b.id}’s on ${Math.round(b.n * 100)}%): it is mostly scanned images, so it cannot be searched or quoted.`);
    short("contents", p => p.contents, (a, b) => a < b / 2 && b >= 5,
      (c, b) => c.n ? `${c.id}’s ${format} has ${plural(c.n, "contents entry", "contents entries")}; ${b.id}’s has ${n(b.n)}.` : `${c.id}’s ${format} has no table of contents; ${b.id}’s has ${plural(b.n, "entry", "entries")}.`);
    short("page_list", p => p.page_list, (a, b) => a < b / 2 && b >= 20,
      (c, b) => c.n ? `${c.id}’s EPUB maps ${plural(c.n, "print page")}; ${b.id}’s maps ${n(b.n)}.` : `${c.id}’s EPUB has no print page numbers; ${b.id}’s maps ${plural(b.n, "print page")}, so its passages can be cited by printed page.`);
    short("links", p => p.links, (a, b) => a < b / 2 && b >= 50,
      (c, b) => `${c.id}’s ${format} has ${plural(c.n, "internal link")}; ${b.id}’s has ${n(b.n)}: its notes, index or cross-references may not be linked.`);
    short("images", p => p.images, (a, b) => a < b / 2 && b - a >= 5,
      (c, b) => `${c.id}’s EPUB has ${plural(c.n, "image")}; ${b.id}’s has ${n(b.n)}: figures may be missing.`);
    if (warnings.length > before) { flagged.add(format); continue; }
    // Same text and structure: a size gap comes from images, fonts or markup.
    if (sizeWarnings.some(w => w.startsWith(format + " "))) {
      const list = (bytes: (p: ContentProfile) => number | undefined) => copies.map(c => `${c.id} ${kb(bytes(c.p) ?? 0)}`).join(", ");
      notes.push(format === "EPUB"
        ? `EPUB sizes differ, but the text and structure match. Images: ${list(p => p.image_bytes)}${copies.some(c => c.p.font_bytes) ? `; fonts: ${list(p => p.font_bytes)}` : ""}; markup: ${list(p => p.text_bytes)}.`
        : "PDF sizes differ, but the pages, text and bookmarks match: probably different image compression.");
    }
  }
  return { content_warnings: warnings, content_notes: notes,
    // A size gap stays a warning where the contents differ too, or could not be compared.
    size_warnings: sizeWarnings.filter(w => flagged.has(w.split(" ")[0])) };
}
