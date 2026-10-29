/**
 * Finding the publication year a book prints on its copyright page, for books Calibre has no year for:
 * "Copyright 2016 by Kelly Oliver", "© Kit Eason 2022", "First published 1998", "This edition published
 * 2005". Read from the front matter only (or the last pages, when the front has none), since a book's
 * body can say "copyright" with any year at all.
 */

/** What a year was printed with. Reprints don't make a new edition, so they never give the year. */
export type YearKind = "copyright" | "edition" | "first_published" | "published" | "reprint";

export interface YearCandidate {
  year: number;
  kind: YearKind;
  /** 1-based page or location where it was found. */
  page: number;
  position: "front" | "back";
  page_label: string | null;
  /** The printed line around it. */
  context: string;
}

/** Bump when findPrintedYears or printedYear changes, so the indexer recomputes stored years (no re-extraction). */
export const YEAR_SCAN_VERSION = 2;

/**
 * Words that say what the year after them is. Each year takes the marker that ends closest before it;
 * of two ending at the same place, the one that starts first, so "This edition first published 2005"
 * is an edition year, not a first-published one.
 */
const MARKERS: [YearKind, RegExp][] = [
  ["reprint", /\b(?:reprinted|reprint(?:ed)? edition|reissued|\d+(?:st|nd|rd|th)? printing|printing)\b/gi],
  ["first_published", /\bfirst (?:published|edition|printed|appeared|issued)\b|\boriginally published\b/gi],
  ["edition", /\b(?:this|second|third|fourth|fifth|sixth|revised|new|updated|expanded|paperback|\d+(?:st|nd|rd|th)) edition\b(?: (?:first )?published)?|\bthis (?:paperback )?(?:edition|translation) (?:first )?published\b|\btranslation (?:©|copyright)/gi],
  ["copyright", /\bcopyright\b|©|\(c\)(?=\s*\d)|\bcopr\./gi],
  ["published", /\bpublished\b/gi],
];

/** A year on its own: not part of an ISBN, a DOI, a phone number, or a longer number. */
const YEAR = /(?<![\d./\-])(1[4-9]\d\d|20\d\d)(?![\d/\-]|\.\d)/g;

/** A range of years joined by a hyphen, "2016-2022" or "2016-22", which YEAR's guard against ISBNs would skip. */
const RANGE = /(?<![\d./\-])(1[4-9]\d\d|20\d\d)\s?-\s?(1[4-9]\d\d|20\d\d|\d\d)(?![\d/\-]|\.\d)/g;

/** An identifier: ten or more digits joined by single spaces or hyphens, as an ISBN is printed ("978 1 2019 5555 9"). */
const IDENTIFIER = /\d(?:[ \-‐‑–]?[\dXx]){9,}/g;

/** Every year in a line, with where it starts: years in ranges, then years on their own, never inside an identifier. */
function yearsIn(line: string): { year: number; start: number }[] {
  const masked = line.replace(IDENTIFIER, (m) => " ".repeat(m.length));
  const hits: { year: number; start: number }[] = [];
  const covered: [number, number][] = [];
  for (const m of masked.matchAll(RANGE)) {
    const first = Number(m[1]);
    const second = m[2].length === 2 ? Math.floor(first / 100) * 100 + Number(m[2]) : Number(m[2]);
    if (second < first) continue;
    hits.push({ year: first, start: m.index! }, { year: second, start: m.index! + m[0].length - m[2].length });
    covered.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of masked.matchAll(YEAR)) {
    if (!covered.some(([a, b]) => m.index! >= a && m.index! < b)) hits.push({ year: Number(m[1]), start: m.index! });
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** How far before a year its marker may be, on the same line. */
const REACH = 100;

function lineAround(line: string, start: number, end: number, width = 90): string {
  const from = Math.max(0, start - width / 2);
  const to = Math.min(line.length, end + width / 2);
  return `${from > 0 ? "…" : ""}${line.slice(from, to).replace(/\s+/g, " ").trim()}${to < line.length ? "…" : ""}`;
}

/**
 * Every year printed with a marker in the given pages (in page order, once per page, year, and kind). A
 * year with no marker before it on its line is ignored: it's a date in the text, not a publication year.
 */
export function findPrintedYears(
  pages: { page_index: number; label: string | null; text: string }[],
  pageCount = Number.POSITIVE_INFINITY,
  backPages = 5,
  latest = new Date().getFullYear() + 1,
): YearCandidate[] {
  const found: YearCandidate[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const line of page.text.split("\n")) {
      if (!/\d{4}/.test(line)) continue;
      const marks = MARKERS.flatMap(([kind, re]) => [...line.matchAll(re)].map((m) => ({ kind, start: m.index!, end: m.index! + m[0].length })));
      if (!marks.length) continue;
      for (const { year, start } of yearsIn(line)) {
        if (year > latest) continue;
        const near = marks.filter((x) => x.end <= start && start - x.end <= REACH).sort((a, b) => b.end - a.end || a.start - b.start)[0];
        if (!near) continue;
        const key = `${page.page_index}:${year}:${near.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          year, kind: near.kind, page: page.page_index + 1, position: page.page_index >= pageCount - backPages ? "back" : "front",
          page_label: page.label, context: lineAround(line, start, start + 4),
        });
      }
    }
  }
  return found;
}

/**
 * The year to cite: the year of the edition in hand, which is the latest copyright, edition, or
 * publication year printed (a reissue's "© 1949 … this edition © 2003" is the 2003 edition, and a
 * translation's © is later than the original's). A "first published" year counts only when nothing
 * else is printed, and reprint years never do. Front matter is preferred; the last pages are used only
 * when the front has nothing. Null when there's no year to give.
 *
 * Only the copyright page counts, with the pages before it and the one after (where a long copyright
 * page continues): the first page printing a copyright or edition year. Later pages can be the first
 * chapters, where a code example's "Copyright 2006" is no publication year.
 */
export function printedYear(candidates: YearCandidate[]): YearCandidate | null {
  for (const position of ["front", "back"] as const) {
    const all = candidates.filter((c) => c.position === position && c.kind !== "reprint");
    const anchor = (all.find((c) => c.kind === "copyright" || c.kind === "edition") ?? all[0])?.page;
    const here = all.filter((c) => c.page <= anchor + 1);
    const edition = here.filter((c) => c.kind !== "first_published");
    const pool = edition.length ? edition : here;
    if (pool.length) return pool.reduce((best, c) => (c.year > best.year ? c : best));
  }
  return null;
}
