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
export const YEAR_SCAN_VERSION = 1;

/**
 * Words that say what the year after them is, nearest first wins. Order matters within a line only in
 * that each year takes the closest of these before it.
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
      const marks = MARKERS.flatMap(([kind, re]) => [...line.matchAll(re)].map((m) => ({ kind, end: m.index! + m[0].length })));
      if (!marks.length) continue;
      for (const m of line.matchAll(YEAR)) {
        const year = Number(m[1]);
        if (year > latest) continue;
        const start = m.index!;
        const near = marks.filter((x) => x.end <= start && start - x.end <= REACH).sort((a, b) => b.end - a.end)[0];
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
 */
export function printedYear(candidates: YearCandidate[]): YearCandidate | null {
  for (const position of ["front", "back"] as const) {
    const here = candidates.filter((c) => c.position === position && c.kind !== "reprint");
    const edition = here.filter((c) => c.kind !== "first_published");
    const pool = edition.length ? edition : here;
    if (pool.length) return pool.reduce((best, c) => (c.year > best.year ? c : best));
  }
  return null;
}
