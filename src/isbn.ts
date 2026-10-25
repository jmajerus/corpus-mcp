/**
 * ISBN checking, and finding the ISBNs a book prints on its copyright page (isbnlib's
 * get_isbnlike + canonical, without the Python dependency).
 */

/** Strips hyphens, spaces, and an "ISBN" prefix; returns the digits if the ISBN-10 or ISBN-13 check digit holds. */
export function validIsbn(raw: string): string | null {
  const isbn = raw.replace(/^isbn(-1[03])?:?/i, "").replace(/[\s\-‐‑–]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((total, c, i) => total + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? isbn : null;
  }
  if (/^\d{13}$/.test(isbn)) {
    const sum = [...isbn].reduce((total, c, i) => total + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? isbn : null;
  }
  return null;
}

/** The ISBN-13 form of a valid ISBN-10 or ISBN-13. */
export function isbn13(isbn: string): string {
  if (isbn.length === 13) return isbn;
  const body = `978${isbn.slice(0, 9)}`;
  const sum = [...body].reduce((total, c, i) => total + Number(c) * (i % 2 ? 3 : 1), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

export type IsbnFormat = "hardcover" | "paperback" | "ebook";

const FORMAT_WORDS: [IsbnFormat, RegExp][] = [
  ["ebook", /\b(?:e-?book|ebk|epub|e-?pub|electronic|digital|kindle|mobi|pdf|online)\b/i],
  ["hardcover", /\b(?:hardcover|hardback|hbk|cloth|casebound)\b/i],
  ["paperback", /\b(?:paperback|softcover|pbk)\b/i],
];

export interface IsbnCandidate {
  /** As printed, with separators removed. */
  isbn: string;
  isbn13: string;
  /** The binding or edition printed next to it, when there is one. */
  format: IsbnFormat | null;
  /** 1-based page or location where it was found. */
  page: number;
  /** Front matter, or the last pages, where ISBNs are often adverts for other books. */
  position: "front" | "back";
  page_label: string | null;
  /** The printed line around it. */
  context: string;
}

// A whole run of digits joined by single separators; isbnInRun finds the ISBN inside it.
const ISBN_LIKE = /(?<![\dX])\d(?:[ \-‐‑–]?[\dXx])+/g;

/**
 * The longest valid ISBN within a digit run, made of whole separator groups, for runs that swallowed
 * a neighbouring number: "ISBN 0-19-512345-6 2019", or "ISBN-13 978-0-306-40615-7" (which starts at "13").
 */
function isbnInRun(run: string): { isbn: string; offset: number; length: number } | null {
  const groups = run.split(/(?<=[ \-‐‑–])/);
  for (let size = groups.length; size > 0; size--) {
    for (let first = 0; first + size <= groups.length; first++) {
      const part = groups.slice(first, first + size).join("").replace(/[ \-‐‑–]$/, "");
      const isbn = validIsbn(part);
      if (isbn) return { isbn, offset: groups.slice(0, first).join("").length, length: part.length };
    }
  }
  return null;
}

/** Bump when findPrintedIsbns changes, so the indexer recomputes stored candidates (no re-extraction). */
export const ISBN_SCAN_VERSION = 2;

/**
 * The binding printed for one ISBN, checked in this order: a parenthetical right after it
 * ("978… (hardback)"); the text right before it, back to the previous number ("eBook ISBN 978…",
 * "Hardcover print edition ISBN 978…"); then the text after it, up to the next ISBN ("978… paperback").
 */
function formatNear(text: string, start: number, end: number): IsbnFormat | null {
  const rest = text.slice(end, end + 40);
  const parenthetical = rest.match(/^\s*\(([^)]*)\)/)?.[1] ?? "";
  const before = text.slice(Math.max(0, start - 40), start).split(/\d|\n/).at(-1) ?? "";
  const after = rest.split(/\d|\n|ISBN/i)[0];
  for (const part of [parenthetical, before, after]) {
    const format = FORMAT_WORDS.find(([, words]) => words.test(part))?.[0];
    if (format) return format;
  }
  return null;
}

/** The text on the same line as a match, trimmed to about `width` characters around it. */
function lineAround(text: string, start: number, end: number, width = 90): string {
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const lineEndAt = text.indexOf("\n", end);
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
  const from = Math.max(lineStart, start - width / 2);
  const to = Math.min(lineEnd, end + width / 2);
  return `${from > lineStart ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < lineEnd ? "…" : ""}`;
}

/**
 * Every valid ISBN printed in the given pages, once each (ISBN-10 and -13 forms merged), in page order.
 * A match counts when "ISBN" precedes it nearby, or when it is 13 digits starting 978/979; bare 10-digit
 * runs that merely pass the checksum (one in eleven do) are ignored.
 */
export function findPrintedIsbns(
  pages: { page_index: number; label: string | null; text: string }[],
  pageCount = Number.POSITIVE_INFINITY,
  backPages = 5,
): IsbnCandidate[] {
  const found = new Map<string, IsbnCandidate>();
  for (const page of pages) {
    for (const match of page.text.matchAll(ISBN_LIKE)) {
      const hit = isbnInRun(match[0]);
      if (!hit) continue;
      const { isbn } = hit;
      const start = match.index! + hit.offset;
      const before = page.text.slice(Math.max(0, start - 40), start);
      const labelled = /ISBN[\s\-‐‑–:(]*(?:1[03])?[\s\-‐‑–:)]*(?:\([^)]*\)[\s:]*)?[^\d\n]{0,25}$/i.test(before);
      if (!labelled && !(isbn.length === 13 && /^97[89]/.test(isbn))) continue;
      const key = isbn13(isbn);
      if (found.has(key)) continue;
      const end = start + hit.length;
      found.set(key, {
        isbn,
        isbn13: key,
        format: formatNear(page.text, start, end),
        page: page.page_index + 1,
        position: page.page_index >= pageCount - backPages ? "back" : "front",
        page_label: page.label,
        context: lineAround(page.text, start, end),
      });
    }
  }
  return [...found.values()];
}
