import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { recordChange } from "./anchors.js";
import { type DataStore, recordChanges, resolveUuid } from "./data.js";
import type { DB } from "./db.js";
import { type BookRow, type Corpus, ToolError, getBook, getBookOutline } from "./tools.js";

/**
 * What a PDF's own pages say about themselves, beyond its metadata: how clean its extracted text is, the
 * contents it prints, and the page numbers it prints. A PDF with no page-label metadata gets its file
 * positions as labels, which are wrong whenever the printed numbering doesn't start on the first page, so
 * the printed numbers are inferred from the contents and the folios the text kept, and a person (or an
 * agent) can pin the numbering. Pins live in data.db, keyed by Calibre UUID, and the refresh writes them
 * into the index and into quote-mcp's anchors, since the server reads the index read-only.
 */

interface PageText { page_index: number; label: string | null; text: string }

// --- Text quality --------------------------------------------------------------------------------

/**
 * Words a PDF's text spells wrongly when its font maps a ligature glyph to too few letters, by ligature,
 * with the words spelled rightly to compare: a healthy text has many of these and almost none of those.
 */
const LIGATURE_FAMILIES: { ligature: string; lost: RegExp; intact: RegExp }[] = [
  {
    ligature: "Th",
    lost: /\b(?:Te|Tis|Tat|Tey|Teir|Tere|Tese|Tose|Tough|Tus|Terefore|Temselves|Ten,)\b/g,
    intact: /\b(?:The|This|That|They|Their|There|These|Those|Though|Thus|Therefore|Themselves)\b/g,
  },
  { ligature: "ft", lost: /\b(?:afer|aferwards?|ofen|sofware|crafsman\w*|lefover)\b/gi, intact: /\b(?:after|afterwards?|often|software|craftsman\w*|leftover)\b/gi },
  {
    ligature: "fi/ff/fl (whole run lost)",
    lost: /\b(?:dierent|dierence|eect|eects|dicult|diculty|rst|nally|oce|ocial|signicant|inuence)\b/gi,
    intact: /\b(?:different|difference|effect|effects|difficult|difficulty|first|finally|office|official|significant|influence)\b/gi,
  },
  {
    ligature: "fi/ff/fl (second letter lost)",
    lost: /\b(?:frst|fnd|fnally|signifcant|difcult|efect|efects|diferent|ofce|ofcial|infuence)\b/gi,
    intact: /\b(?:first|find|finally|significant|difficult|effect|effects|different|office|official|influence)\b/gi,
  },
];

export interface TextQuality {
  /** Ligatures whose letters the extracted text drops, with examples as the text spells them. */
  dropped_ligatures: { ligature: string; words_affected: number; words_intact: number; examples: string[] }[];
  /** U+FFFD replacement characters: glyphs the PDF gives no text for. */
  unreadable_chars: number;
  unreadable_pages: number[];
  note?: string;
}

/** How clean a book's extracted text is: dropped ligatures and unreadable characters. */
export function textQuality(pages: PageText[]): TextQuality {
  const all = pages.map((p) => p.text).join("\n");
  const dropped: TextQuality["dropped_ligatures"] = [];
  for (const family of LIGATURE_FAMILIES) {
    const lost = all.match(family.lost) ?? [];
    const intact = (all.match(family.intact) ?? []).length;
    // Some of each is normal (a Spanish "Te", an abbreviation); a fifth or more lost is a damaged text.
    if (lost.length >= 3 && lost.length * 4 >= lost.length + intact) {
      dropped.push({ ligature: family.ligature, words_affected: lost.length, words_intact: intact, examples: [...new Set(lost)].slice(0, 5) });
    }
  }
  const unreadablePages = pages.filter((p) => p.text.includes("�"));
  const unreadable = (all.match(/�/g) ?? []).length;
  const notes: string[] = [];
  if (dropped.length) {
    notes.push(`This PDF's text drops letters set as ligatures (${dropped.flatMap((d) => d.examples.slice(0, 2)).map((e) => `"${e}"`).join(", ")}). Quote the words as printed: add_quote matches across the missing letters and saves the printed reading. Searches need the damaged spelling, or other words.`);
  }
  if (unreadable) notes.push(`${unreadable} characters on ${unreadablePages.length} page(s) have no text (shown as �). Use render_page to read them.`);
  return {
    dropped_ligatures: dropped, unreadable_chars: unreadable, unreadable_pages: unreadablePages.map((p) => p.page_index + 1).slice(0, 20),
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

// --- Printed contents and page numbers -----------------------------------------------------------

export interface PrintedContentsEntry {
  title: string;
  /** The page number the contents prints. */
  printed_page: string;
  /** Where the entry's heading starts, when found (found: true), or where the inferred numbering puts it. */
  file_page: number | null;
  found: boolean;
}

/** An entry with a dot leader: "1.1 Te Course of the Research . . . . . .17". */
const LEADER_ENTRY = /\s*(.+?)\s*(?:\.\s?){3,}\s*(\d{1,4}|[ivxlc]{1,7})(?![\p{L}\p{N}])/giu;

/** The contents pages and their entries, from the front of the book: pages with at least three leader entries. */
export function printedContents(pages: PageText[]): { pages: number[]; entries: { title: string; printed_page: string }[] } {
  const found: { pages: number[]; entries: { title: string; printed_page: string }[] } = { pages: [], entries: [] };
  const front = pages.slice(0, Math.max(12, Math.min(40, Math.ceil(pages.length * 0.15))));
  for (const page of front) {
    const entries = [...page.text.matchAll(LEADER_ENTRY)]
      .map((m) => ({ title: m[1].replace(/^\d{1,4}\s*\n+/, "").replace(/\s+/g, " ").trim(), printed_page: m[2] }))
      .filter((e) => /\p{L}{2}/u.test(e.title));
    if (entries.length >= 3) {
      found.pages.push(page.page_index);
      found.entries.push(...entries);
    } else if (found.pages.length) break;
  }
  return found;
}

/**
 * Shorter forms of a contents title to look for as a heading: as printed, then from its last section
 * number on ("PART I: The Theories 1. Introduction" → "1. Introduction"), since a part's heading often
 * runs into its first chapter's entry.
 */
function headingCandidates(title: string): string[] {
  const numbered = title.match(/(?:^|\s)((?:\d+\.)*\d+\.?\s+\D.*)$/)?.[1];
  return [...new Set([title, ...(numbered ? [numbered] : [])])];
}

/** Text with every ligature run cut to its first letter, so "The" and a damaged "Te" compare equal. */
const foldLigatures = (text: string) => text.replace(/ff[il]?|f[ilt]|th/gi, (run) => run[0]);

/** What may number a heading: "Chapter 3", "1.2", "IV", as words after normalizing. */
const HEADING_NUMBER = /^(?:(?:chapter|part|section|book) )?(?:\d+(?: \d+)*|[ivxlcdm]+ )?/;

/** A heading or paragraph opening for comparing: ligatures folded, lower case, words joined by single spaces, numbering dropped. */
function headingKey(text: string): string {
  return foldLigatures(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(HEADING_NUMBER, "").trim();
}

/** What follows each paragraph start on a page, across line breaks (a long heading wraps), as headingKey gives it. */
function paragraphKeys(text: string): string[] {
  const starts = [0, ...[...text.matchAll(/\n+/g)].map((m) => m.index! + m[0].length)];
  return starts.map((at) => headingKey(text.slice(at, at + 300))).filter(Boolean);
}

/** Whether a paragraph on the page starts with the title, as a whole-word prefix. */
function headingOn(keys: string[], titles: string[]): boolean {
  return titles.some((t) => t && keys.some((k) => k.startsWith(t) && (k.length === t.length || k[t.length] === " ")));
}

/** The offset (file page = printed page + offset) that most agree on, with how many agree. */
function vote(offsets: number[][]): { offset: number; agree: number } | null {
  const counts = new Map<number, number>();
  for (const options of offsets) for (const k of new Set(options)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0];
  return best ? { offset: best[0], agree: best[1] } : null;
}

export interface PrintedNumbering {
  /** file_page = printed page + offset, for the arabic numbering. */
  offset: number;
  evidence: { contents_entries: number; contents_entries_checked: number; folios: number; folios_checked: number };
  /** The pin that would apply it (pin_page_labels). */
  suggested_pin: { file_page: number; page_label: string };
}

/**
 * The printed numbering, inferred from two kinds of evidence: where the printed contents' headings start
 * (an entry printed at 15 whose heading starts on file page 16 says +1), and folios the text kept (a page
 * whose first or last paragraph is only its number). Null without enough agreement: three contents
 * entries, or two folios, and more for than against.
 */
export function inferNumbering(pages: PageText[], contents = printedContents(pages)): { numbering: PrintedNumbering | null; entries: PrintedContentsEntry[] } {
  const contentsPages = new Set(contents.pages);
  const keys = new Map(pages.filter((p) => !contentsPages.has(p.page_index)).map((p) => [p.page_index, paragraphKeys(p.text)]));
  const arabic = contents.entries.filter((e) => /^\d+$/.test(e.printed_page));
  const entryOffsets = arabic.map((e) => {
    const printed = Number(e.printed_page);
    const titles = [...new Set(headingCandidates(e.title).map(headingKey))];
    const ks: number[] = [];
    for (let k = -10; k <= 40; k++) {
      const page = keys.get(printed + k - 1);
      if (page && headingOn(page, titles)) ks.push(k);
    }
    return ks;
  });
  const folioOffsets: number[][] = [];
  for (const page of pages) {
    const paragraphs = page.text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (const para of [paragraphs[0], paragraphs.at(-1)]) {
      if (para && /^\d{1,4}$/.test(para)) {
        const k = page.page_index + 1 - Number(para);
        if (k >= -10 && k <= 40) { folioOffsets.push([k]); break; }
      }
    }
  }
  const fromContents = vote(entryOffsets.filter((ks) => ks.length));
  const best = vote([...entryOffsets.filter((ks) => ks.length), ...folioOffsets]);
  let numbering: PrintedNumbering | null = null;
  if (best) {
    const contentsAgree = entryOffsets.filter((ks) => ks.includes(best.offset)).length;
    const contentsChecked = entryOffsets.filter((ks) => ks.length).length;
    const foliosAgree = folioOffsets.filter(([k]) => k === best.offset).length;
    const enough = contentsAgree >= 3 || foliosAgree >= 2 || (contentsAgree >= 1 && foliosAgree >= 1);
    const against = (contentsChecked - contentsAgree) + (folioOffsets.length - foliosAgree);
    if (enough && contentsAgree + foliosAgree > against && (!fromContents || fromContents.offset === best.offset || contentsAgree * 2 > contentsChecked)) {
      const first = Math.max(1, 1 + best.offset);
      numbering = {
        offset: best.offset,
        evidence: { contents_entries: contentsAgree, contents_entries_checked: contentsChecked, folios: foliosAgree, folios_checked: folioOffsets.length },
        suggested_pin: { file_page: first, page_label: String(first - best.offset) },
      };
    }
  }
  const entries = contents.entries.map((e) => {
    const n = arabic.indexOf(e);
    const ks = n >= 0 ? entryOffsets[n] : [];
    const found = numbering ? ks.includes(numbering.offset) : ks.length === 1;
    const k = numbering ? numbering.offset : ks.length === 1 ? ks[0] : null;
    const filePage = n >= 0 && k !== null ? Number(e.printed_page) + k : null;
    return { title: e.title, printed_page: e.printed_page, file_page: filePage !== null && filePage >= 1 && filePage <= pages.length ? filePage : null, found };
  });
  return { numbering, entries };
}

// --- Pinned page labels --------------------------------------------------------------------------

export interface LabelRange {
  /** 1-based file page where this numbering starts. */
  file_page: number;
  /** The number printed on that page: arabic ("15") or roman ("xii", "XII"). */
  page_label: string;
}

export interface PageLabelPin {
  calibre_uuid: string; book_id: string; title: string; ranges: LabelRange[]; sha256: string | null;
  pinned_at: string; pinned_by: string | null;
}

const ROMAN: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];

function toRoman(n: number): string {
  let out = "";
  for (const [value, letters] of ROMAN) while (n >= value) { out += letters; n -= value; }
  return out;
}

function fromRoman(text: string): number | null {
  const s = text.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(s)) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN.find(([, l]) => l === s[i])![0];
    const next = i + 1 < s.length ? ROMAN.find(([, l]) => l === s[i + 1])![0] : 0;
    n += v < next ? -v : v;
  }
  return toRoman(n) === s ? n : null;
}

/** How a range's first label counts on: its number and style; null when it is neither arabic nor roman. */
export function labelStyle(label: string): { start: number; style: "arabic" | "roman" | "ROMAN" } | null {
  const t = label.trim();
  if (/^\d{1,5}$/.test(t)) return { start: Number(t), style: "arabic" };
  const n = fromRoman(t);
  if (n === null) return null;
  return { start: n, style: t === t.toUpperCase() ? "ROMAN" : "roman" };
}

/** The label every page gets under the pinned ranges; pages before the first range get none. */
export function pinnedLabels(ranges: LabelRange[], pageCount: number): (string | null)[] {
  const sorted = [...ranges].sort((a, b) => a.file_page - b.file_page);
  const labels: (string | null)[] = new Array(pageCount).fill(null);
  sorted.forEach((r, i) => {
    const style = labelStyle(r.page_label)!;
    const end = i + 1 < sorted.length ? sorted[i + 1].file_page - 1 : pageCount;
    for (let page = r.file_page; page <= end && page <= pageCount; page++) {
      const n = style.start + (page - r.file_page);
      labels[page - 1] = style.style === "arabic" ? String(n) : style.style === "roman" ? toRoman(n) : toRoman(n).toUpperCase();
    }
  });
  return labels;
}

export function pageLabelPin(data: DataStore, uuid: string | null): PageLabelPin | undefined {
  if (!uuid) return undefined;
  const row = data.prepare("SELECT * FROM page_label_pins WHERE calibre_uuid = ?").get(resolveUuid(data, uuid)) as (Omit<PageLabelPin, "ranges"> & { ranges: string }) | undefined;
  return row ? { ...row, ranges: JSON.parse(row.ranges) as LabelRange[] } : undefined;
}

interface PinnedBook { id: string; uuid: string; title: string; sha256: string | null; file_path: string | null; page_count: number; reflowable: number | null }

/**
 * The refresh's step: writes each pin's labels into the index, and the labels of quote-mcp's anchors on
 * those books, each a change quote-mcp follows. A pin made against another file of the book (its sha256
 * differs) is left alone: the numbering may differ. A cleared pin (no ranges) gets the PDF's own labels
 * back, read from the file, and is then removed.
 */
export function applyPageLabelPins(db: DB, data: DataStore, booksRoot: string): { books: number; pages: number; anchors: number; stale: string[] } {
  const counts = { books: 0, pages: 0, anchors: 0, stale: [] as string[] };
  const pins = (data.prepare("SELECT * FROM page_label_pins").all() as (Omit<PageLabelPin, "ranges"> & { ranges: string })[])
    .map((r) => ({ ...r, ranges: JSON.parse(r.ranges) as LabelRange[] }));
  const books = db.prepare<[string], PinnedBook>("SELECT id, uuid, title, sha256, file_path, page_count, reflowable FROM books WHERE uuid = ? COLLATE NOCASE AND status = 'indexed' AND NOT reflowable");
  const current = db.prepare<[string], { page_index: number; label: string | null }>("SELECT page_index, label FROM pages WHERE book_id = ? ORDER BY page_index");
  const setLabel = db.prepare("UPDATE pages SET label = ? WHERE book_id = ? AND page_index = ?");
  for (const pin of pins) {
    for (const book of books.all(pin.calibre_uuid)) {
      if (pin.ranges.length && pin.sha256 && book.sha256 !== pin.sha256) { counts.stale.push(book.id); continue; }
      let wanted: (string | null)[];
      if (pin.ranges.length) wanted = pinnedLabels(pin.ranges, book.page_count);
      else {
        const labels = pdfLabels(booksRoot, book);
        if (!labels) continue;
        wanted = labels;
      }
      const changed = current.all(book.id).filter((p) => (wanted[p.page_index] ?? null) !== p.label);
      if (changed.length) {
        db.transaction(() => { for (const p of changed) setLabel.run(wanted[p.page_index] ?? null, book.id, p.page_index); })();
        counts.books++;
        counts.pages += changed.length;
        recordChanges(data, [{ kind: "page_labels_applied", source: "cli", book_id: book.id, calibre_uuid: book.uuid, title: book.title,
          detail: pin.ranges.length ? pin.ranges.map((r) => `file_page ${r.file_page} = ${r.page_label}`).join("; ") : "cleared: the PDF's own labels" }]);
      }
      counts.anchors += relabelAnchors(db, data, book);
    }
    if (!pin.ranges.length) data.prepare("DELETE FROM page_label_pins WHERE calibre_uuid = ? AND ranges = '[]'").run(pin.calibre_uuid);
  }
  return counts;
}

/** The PDF's own page labels, read from its file; null when it can't be read. */
function pdfLabels(booksRoot: string, book: PinnedBook): (string | null)[] | null {
  if (!book.file_path) return null;
  try {
    const doc = mupdf.Document.openDocument(fs.readFileSync(path.join(booksRoot, book.file_path)), "book.pdf");
    try {
      const labels: (string | null)[] = [];
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.loadPage(i);
        try { labels.push(page.getLabel() || null); } finally { page.destroy(); }
      }
      return labels;
    } finally {
      doc.destroy();
    }
  } catch {
    return null;
  }
}

/** Gives a book's verified anchors the labels their pages now have, logging each change for quote-mcp. */
function relabelAnchors(db: DB, data: DataStore, book: PinnedBook): number {
  const label = db.prepare<[string, number], string | null>("SELECT label FROM pages WHERE book_id = ? AND page_index = ?").pluck();
  const rows = data.prepare("SELECT * FROM anchors WHERE calibre_uuid = ? COLLATE NOCASE AND status = 'verified' AND sha256 IS ?").all(book.uuid, book.sha256) as
    { quote_id: number; calibre_uuid: string; sha256: string | null; start_page: number; start_offset: number; end_page: number; end_offset: number;
      page_label: string | null; end_page_label: string | null; section_path: string | null; prefix: string; suffix: string; text: string }[];
  let n = 0;
  for (const r of rows) {
    const start = label.get(book.id, r.start_page) ?? null;
    const end = label.get(book.id, r.end_page) ?? null;
    if (start === r.page_label && end === r.end_page_label) continue;
    const at = new Date().toISOString();
    const anchor = {
      calibre_uuid: r.calibre_uuid, sha256: r.sha256, start_page: r.start_page, start_offset: r.start_offset, end_page: r.end_page, end_offset: r.end_offset,
      page_label: start, end_page_label: end, section: r.section_path, prefix: r.prefix, suffix: r.suffix, text: r.text,
    };
    data.transaction(() => {
      data.prepare("UPDATE anchors SET page_label = ?, end_page_label = ?, updated_at = ? WHERE quote_id = ?").run(start, end, at, r.quote_id);
      recordChange(data, r.quote_id, "reanchored", "verified", anchor, at);
    })();
    n++;
  }
  return n;
}

// --- The tools' side -----------------------------------------------------------------------------

function allPages(c: Corpus, bookId: string): PageText[] {
  return c.db.prepare("SELECT page_index, label, text FROM pages WHERE book_id = ? ORDER BY page_index").all(bookId) as PageText[];
}

/** Labels that are only file positions ("1", "2", …, or none): a PDF with no page-label metadata. */
const positionsOnly = (pages: PageText[]) => pages.every((p) => p.label === null || p.label === String(p.page_index + 1));

export interface PageLabelsReport {
  /**
   * pdf: the PDF's own page labels. file_position: the PDF has none, so page_label is the file position.
   * pinned: a pinned numbering, in effect. pin_pending: pinned, applied by the next refresh.
   * pin_for_other_file: pinned against another file of this book, so not applied.
   */
  source: "pdf" | "file_position" | "pinned" | "pin_pending" | "pin_for_other_file";
  pin?: { ranges: LabelRange[]; pinned_at: string; pinned_by: string | null };
  /** The printed numbering read from the book's contents and folios, when it can be. */
  inferred?: PrintedNumbering;
  note?: string;
}

function labelsReport(c: Corpus, book: BookRow, pages: PageText[], numbering: PrintedNumbering | null): PageLabelsReport {
  const pin = pageLabelPin(c.data, book.uuid);
  const inferred = numbering ? { inferred: numbering } : {};
  if (pin && pin.ranges.length) {
    const pinInfo = { pin: { ranges: pin.ranges, pinned_at: pin.pinned_at, pinned_by: pin.pinned_by } };
    if (pin.sha256 && pin.sha256 !== book.sha256) {
      return { source: "pin_for_other_file", ...pinInfo, ...inferred, note: "The numbering was pinned for another file of this book, so it isn't applied. Check the printed numbers and pin again with pin_page_labels." };
    }
    const wanted = pinnedLabels(pin.ranges, pages.length);
    if (pages.every((p) => p.label === wanted[p.page_index])) return { source: "pinned", ...pinInfo };
    return { source: "pin_pending", ...pinInfo, note: "The pinned numbering is applied by the next refresh, within about ten minutes; until then page_label is the old one." };
  }
  if (positionsOnly(pages)) {
    if (numbering && numbering.offset !== 0) {
      const { file_page, page_label } = numbering.suggested_pin;
      const shift = numbering.offset > 0 ? `${numbering.offset} lower` : `${-numbering.offset} higher`;
      return {
        source: "file_position", ...inferred,
        note: `This PDF has no page-label metadata, so page_label is the file position. The printed page numbers run ${shift} (file_page = printed page ${numbering.offset > 0 ? "+" : "−"} ${Math.abs(numbering.offset)}; evidence in inferred). Until they are pinned, cite by checking the number printed on the page (render_page). To fix every page_label and the quotes saved from this book: pin_page_labels with file_page ${file_page} and page_label "${page_label}", after checking one page.`,
      };
    }
    return {
      source: "file_position", ...inferred,
      note: numbering ? "This PDF has no page-label metadata; page_label is the file position, and the printed numbers it shows agree." : "This PDF has no page-label metadata, so page_label is the file position, which may not be the printed number. Check a page with render_page; if they differ, pin the numbering with pin_page_labels.",
    };
  }
  return { source: "pdf" };
}

/**
 * get_book_outline: the outline, and for a PDF, how far its text and page numbers can be trusted: text
 * quality, where page_label comes from (with the inferred printed numbering), and, when the PDF has no
 * outline, the contents the book prints, each entry with the file page its heading starts on.
 */
export function bookOutline(c: Corpus, bookId: string) {
  const base = getBookOutline(c, bookId);
  const book = getBook(c, bookId);
  if (book.reflowable) return base;
  const pages = allPages(c, book.id);
  const contents = printedContents(pages);
  const { numbering, entries } = inferNumbering(pages, contents);
  const page_labels = labelsReport(c, book, pages, numbering);
  const text_quality = textQuality(pages);
  if (base.outline.length || !entries.length) return { ...base, page_labels, text_quality };
  // With a pinned numbering in effect, a printed page names its file page directly.
  const byLabel = new Map<string, number[]>();
  if (page_labels.source === "pinned") for (const p of pages) if (p.label) byLabel.set(p.label, [...(byLabel.get(p.label) ?? []), p.page_index + 1]);
  const printed_contents = entries.map((e) => {
    const labelled = byLabel.get(e.printed_page);
    return labelled?.length === 1 ? { ...e, file_page: labelled[0] } : e;
  });
  return {
    ...base, page_labels, text_quality, printed_contents,
    note: `This PDF has no outline, so printed_contents is read from the contents it prints (file_page ${contents.pages.map((p) => p + 1).join(", ")}): each entry's printed page, and the file_page its heading starts on (found: true) or where the printed numbering puts it. Read a section with read_book from its file_page to the next entry's; skim: true gives a page range's headings and first sentences.`,
  };
}

export interface PinPageLabelsArgs { book_id: string; file_page?: number; page_label?: string; ranges?: LabelRange[]; clear?: boolean }

/**
 * pin_page_labels: records a PDF's printed page numbering against its Calibre UUID and the file it was
 * checked on. The refresh writes it into the index and quote-mcp's anchors (applyPageLabelPins).
 */
export function pinPageLabels(c: Corpus, args: PinPageLabelsArgs, pinnedBy?: string, source: "agent" | "admin" = "agent") {
  if (c.writesPaused) throw new ToolError(c.writesPaused);
  const book = getBook(c, args.book_id);
  if (book.status !== "indexed" || !book.page_count) throw new ToolError(`${book.id} has no indexed text, so it has no pages to number.`);
  if (book.reflowable) throw new ToolError(`${book.id} is ${book.format?.toUpperCase()}: its file pages are reading locations with no printed numbers. Cite it by chapter.`);
  if (!book.uuid) throw new ToolError(`${book.id} has no Calibre UUID, so its numbering can't be pinned.`);
  const existing = pageLabelPin(c.data, book.uuid);
  const at = new Date().toISOString();
  const log = (detail: string) => recordChanges(c.data, [{ kind: "page_labels_pinned", source, book_id: book.id, calibre_uuid: book.uuid, title: book.title, detail, actor: pinnedBy ?? null }]);
  if (args.clear) {
    if (!existing || !existing.ranges.length) return { status: "unchanged", book_id: book.id, note: "No numbering is pinned for this book." };
    c.data.prepare("UPDATE page_label_pins SET ranges = '[]', pinned_at = ?, pinned_by = ? WHERE calibre_uuid = ?").run(at, pinnedBy ?? null, existing.calibre_uuid);
    log("cleared");
    return { status: "cleared", book_id: book.id, note: "The next refresh (within about ten minutes) gives the pages the PDF's own labels again, and updates the quotes saved from this book." };
  }
  if (args.ranges && (args.file_page !== undefined || args.page_label !== undefined)) throw new ToolError("Pass ranges, or file_page with page_label, not both.");
  const ranges = args.ranges ?? (args.file_page !== undefined && args.page_label !== undefined ? [{ file_page: args.file_page, page_label: args.page_label }] : null);
  if (!ranges?.length) throw new ToolError("Pass file_page and page_label (the number printed on that page), or ranges, or clear: true.");
  const seen = new Set<number>();
  for (const r of ranges) {
    if (!Number.isInteger(r.file_page) || r.file_page < 1 || r.file_page > book.page_count) throw new ToolError(`file_page ${r.file_page} is outside ${book.id}, which has file pages 1–${book.page_count}.`);
    if (!labelStyle(r.page_label)) throw new ToolError(`page_label "${r.page_label}" is neither an arabic number ("15") nor a roman one ("xii").`);
    if (seen.has(r.file_page)) throw new ToolError(`Two ranges start at file_page ${r.file_page}.`);
    seen.add(r.file_page);
  }
  const sorted = ranges.map((r) => ({ file_page: r.file_page, page_label: r.page_label.trim() })).sort((a, b) => a.file_page - b.file_page);
  const labels = pinnedLabels(sorted, book.page_count);
  const warnings: string[] = [];
  const repeated = [...new Set(labels.filter((l, i) => l !== null && labels.indexOf(l) !== i))];
  if (repeated.length) warnings.push(`Some labels are on more than one page (${repeated.slice(0, 5).join(", ")}), so citing by those page_labels will be refused; cite those pages by file_page.`);
  const pages = allPages(c, book.id);
  const { numbering } = inferNumbering(pages);
  if (numbering) {
    const arabic = sorted.filter((r) => labelStyle(r.page_label)!.style === "arabic");
    const disagree = arabic.filter((r) => r.file_page - Number(r.page_label) !== numbering.offset);
    if (disagree.length) warnings.push(`The book's contents and folios suggest file_page = printed page ${numbering.offset >= 0 ? "+" : "−"} ${Math.abs(numbering.offset)}, which ${disagree.map((r) => `file_page ${r.file_page} = "${r.page_label}"`).join(", ")} doesn't match. Check with render_page.`);
  }
  if (sorted[0].file_page > 1) warnings.push(`File pages 1–${sorted[0].file_page - 1} get no page_label. Pin another range for numbered front matter.`);
  const json = JSON.stringify(sorted);
  if (existing && JSON.stringify(existing.ranges) === json && existing.sha256 === book.sha256) {
    return { status: "unchanged", book_id: book.id, ranges: sorted, pinned_at: existing.pinned_at, warnings };
  }
  c.data.prepare(`INSERT INTO page_label_pins (calibre_uuid, book_id, title, ranges, sha256, pinned_at, pinned_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (calibre_uuid) DO UPDATE SET book_id = excluded.book_id, title = excluded.title, ranges = excluded.ranges, sha256 = excluded.sha256,
      pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by`).run(resolveUuid(c.data, book.uuid), book.id, book.title, json, book.sha256, at, pinnedBy ?? null);
  log(sorted.map((r) => `file_page ${r.file_page} = ${r.page_label}`).join("; "));
  const anchors = c.data.prepare("SELECT start_page, end_page, page_label, end_page_label FROM anchors WHERE calibre_uuid = ? COLLATE NOCASE AND status = 'verified'")
    .all(book.uuid) as { start_page: number; end_page: number; page_label: string | null; end_page_label: string | null }[];
  const relabelled = anchors.filter((a) => labels[a.start_page] !== a.page_label || labels[a.end_page] !== a.end_page_label).length;
  const sample = [...new Set([sorted[0].file_page, ...sorted.map((r) => r.file_page), Math.min(book.page_count, sorted[0].file_page + 10), book.page_count])]
    .sort((a, b) => a - b).map((p) => ({ file_page: p, page_label: labels[p - 1] }));
  return {
    status: existing?.ranges.length ? "replaced" : "pinned", book_id: book.id, ranges: sorted, sample,
    quotes_relabelled: relabelled,
    note: `Applied by the next refresh, within about ten minutes: then every page_label (search, read_book, cite_passage) follows this numbering, and ${relabelled} quote${relabelled === 1 ? "" : "s"} saved from this book get${relabelled === 1 ? "s" : ""} the new printed page, as anchor changes quote-mcp follows.`,
    warnings,
  };
}
