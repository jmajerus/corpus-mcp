import * as mupdf from "mupdf";

/** Formats in order of preference: PDF has citable printed pages, MOBI and AZW3 have no outline in MuPDF. */
export const FORMAT_PREFERENCE = ["pdf", "epub", "mobi", "azw3"] as const;
export type BookFormat = (typeof FORMAT_PREFERENCE)[number];

/**
 * Reflowable books are laid out at one fixed size so location numbers stay stable.
 * Changing this changes every location, so bump EXTRACTOR_VERSION with it.
 */
type OutlineItem = NonNullable<ReturnType<mupdf.Document["loadOutline"]>>[number];

const REFLOW_LAYOUT = { width: 450, height: 600, em: 11 };
export const EXTRACTOR_VERSION = 1;

/** Blocks this close to the top or bottom edge of a PDF page, and this short, are running heads or folios. */
const MARGIN_BAND = 0.08;
const MARGIN_MAX_CHARS = 120;

export interface OutlineEntry {
  ord: number;
  level: number;
  title: string;
  /** Titles from the root down to this entry, joined with " › ". */
  path: string;
  /** 0-based page or location index, or null when the link does not resolve. */
  startPage: number | null;
}

export interface ExtractedPage {
  index: number;
  /** Printed page label (PDF only). */
  label: string | null;
  /** Paragraphs in reading order. */
  paragraphs: string[];
}

export interface ExtractedBook {
  reflowable: boolean;
  outline: OutlineEntry[];
  pages: ExtractedPage[];
}

export function isReflowable(format: BookFormat): boolean {
  return format !== "pdf";
}

export function openBook(data: Uint8Array, format: BookFormat): mupdf.Document {
  const doc = mupdf.Document.openDocument(data, `book.${format}`);
  if (isReflowable(format)) doc.layout(REFLOW_LAYOUT.width, REFLOW_LAYOUT.height, REFLOW_LAYOUT.em);
  return doc;
}

export function extractBook(data: Uint8Array, format: BookFormat): ExtractedBook {
  const reflowable = isReflowable(format);
  const doc = openBook(data, format);
  try {
    const outline = flattenOutline(doc);
    const pages: ExtractedPage[] = [];
    const count = doc.countPages();
    for (let index = 0; index < count; index++) {
      const page = doc.loadPage(index);
      try {
        pages.push({
          index,
          label: reflowable ? null : page.getLabel() || null,
          paragraphs: pageParagraphs(page, !reflowable),
        });
      } finally {
        page.destroy();
      }
    }
    return { reflowable, outline, pages };
  } finally {
    doc.destroy();
  }
}

function flattenOutline(doc: mupdf.Document): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const walk = (items: OutlineItem[], level: number, parents: string[]) => {
    for (const item of items) {
      const title = (item.title ?? "").replace(/\s+/g, " ").trim();
      const trail = title ? [...parents, title] : parents;
      if (title) {
        let startPage: number | null = item.page ?? null;
        if (startPage === null && item.uri) {
          const resolved = doc.resolveLink(item.uri);
          startPage = resolved >= 0 ? resolved : null;
        }
        entries.push({ ord: entries.length, level, title, path: trail.join(" › "), startPage });
      }
      if (item.down) walk(item.down, level + 1, trail);
    }
  };
  walk(doc.loadOutline() ?? [], 0, []);
  return entries;
}

interface StextLine { text: string }
interface StextBlock { type: string; bbox: { y: number; h: number }; lines?: StextLine[] }

function pageParagraphs(page: mupdf.Page, stripMargins: boolean): string[] {
  const stext = page.toStructuredText("preserve-whitespace,dehyphenate");
  const { blocks } = JSON.parse(stext.asJSON()) as { blocks: StextBlock[] };
  stext.destroy();
  const [, top, , bottom] = page.getBounds();
  const band = (bottom - top) * MARGIN_BAND;

  const paragraphs: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text" || !block.lines) continue;
    const text = block.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (stripMargins && text.length <= MARGIN_MAX_CHARS) {
      const inTop = block.bbox.y + block.bbox.h <= top + band;
      const inBottom = block.bbox.y >= bottom - band;
      if (inTop || inBottom) continue;
    }
    paragraphs.push(text);
  }
  return paragraphs;
}

/** The outline path of the deepest entry starting at or before each page, or null before the first entry. */
export function sectionPaths(outline: OutlineEntry[], pageCount: number): (string | null)[] {
  const starts = outline
    .filter((e): e is OutlineEntry & { startPage: number } => e.startPage !== null)
    .sort((a, b) => a.startPage - b.startPage || a.ord - b.ord);
  const result: (string | null)[] = new Array(pageCount).fill(null);
  let next = 0;
  let current: string | null = null;
  for (let page = 0; page < pageCount; page++) {
    while (next < starts.length && starts[next].startPage <= page) current = starts[next++].path;
    result[page] = current;
  }
  return result;
}
