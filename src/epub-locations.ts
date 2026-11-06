import type { ExtractedPage } from "./extract.js";

export interface SourceParagraph {
  text: string;
  pre: boolean;
  whitespace: { start: number; end: number }[];
}
interface Location { index: number; text: string }
interface Point { start: number; end: number; page: number }

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
function comparison(text: string) {
  let normalized = "";
  const offsets: number[] = [], ends: number[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const norm = segment.normalize("NFKC").replace(/[\s\u00ad]/gu, "");
    normalized += norm;
    for (let i = 0; i < norm.length; i++) { offsets.push(index); ends.push(index + segment.length); }
  }
  return { normalized, offsets, ends };
}

function lowerBound(values: number[], target: number): number {
  let left = 0, right = values.length;
  while (left < right) { const middle = (left + right) >>> 1; if (values[middle] < target) left = middle + 1; else right = middle; }
  return left;
}

/** Source characters and significant whitespace must have provable, monotonic location ownership. */
export function mapEpubLocations(paragraphs: SourceParagraph[], locations: Location[], href: string): ExtractedPage[] {
  const sources = paragraphs.map((p) => ({ ...p, ...comparison(p.text) }));
  const expected = sources.map((p) => p.normalized).join("");
  const raw = locations.map((p) => p.text).join(""); // No synthetic page separators can satisfy source whitespace.
  const renderedOffsets: number[] = [], renderedEnds: number[] = [], owners: number[] = [], pageEnds: number[] = [];
  let rawAt = 0, at = 0;
  for (const page of locations) {
    const rendered = comparison(page.text);
    if (!expected.startsWith(rendered.normalized, at)) {
      let mismatch = 0;
      while (mismatch < rendered.normalized.length && expected[at + mismatch] === rendered.normalized[mismatch]) mismatch++;
      throw new Error(`EPUB source/layout mismatch in ${href}, location ${page.index + 1}, character ${at + mismatch}.`);
    }
    rendered.offsets.forEach((offset, i) => {
      renderedOffsets.push(rawAt + offset); renderedEnds.push(rawAt + rendered.ends[i]); owners.push(page.index);
    });
    at += rendered.normalized.length;
    rawAt += page.text.length;
    pageEnds.push(rawAt);
  }
  if (at !== expected.length) throw new Error(`EPUB source has unmatched text in ${href}.`);
  const pageAt = (offset: number) => locations[lowerBound(pageEnds, offset + 1)]?.index;
  const points: Point[][] = sources.map(() => []);
  const gaps = new Map<number, { paragraph: number; start: number; end: number; text: string }[]>();
  at = 0;
  sources.forEach((p, paragraph) => {
    // Multiple comparison code units may come from one source grapheme. They must stay together.
    for (let i = 0; i < p.offsets.length;) {
      let next = i + 1;
      while (next < p.offsets.length && p.offsets[next] === p.offsets[i]) next++;
      if (owners[at + i] !== owners[at + next - 1]) throw new Error(`EPUB location splits a source character in ${href}.`);
      points[paragraph].push({ start: p.offsets[i], end: p.ends[i], page: owners[at + i] });
      i = next;
    }
    for (const span of p.whitespace) {
      const position = at + lowerBound(p.offsets, span.end);
      const parts = gaps.get(position) ?? [];
      parts.push({ paragraph, ...span, text: p.text.slice(span.start, span.end) }); gaps.set(position, parts);
    }
    at += p.normalized.length;
  });
  for (const [position, parts] of gaps) {
    const begin = position === 0 ? 0 : renderedEnds[position - 1];
    const end = position === expected.length ? raw.length : renderedOffsets[position];
    const actual = raw.slice(begin, end);
    const first: number[] = [], last: number[] = [];
    let cursor = 0;
    for (const part of parts) {
      const found = actual.indexOf(part.text, cursor);
      if (found < 0) throw new Error(`Significant EPUB whitespace differs from layout in ${href}.`);
      first.push(found); cursor = found + part.text.length;
    }
    cursor = actual.length;
    for (let i = parts.length - 1; i >= 0; i--) {
      const found = actual.lastIndexOf(parts[i].text, cursor - parts[i].text.length);
      if (found < 0) throw new Error(`Significant EPUB whitespace differs from layout in ${href}.`);
      last[i] = found; cursor = found;
    }
    parts.forEach((part, i) => {
      for (let n = 0; n < part.text.length; n++) {
        const page = pageAt(begin + first[i] + n);
        // Earliest/latest valid placements bound every possible match. Repeated generated line
        // breaks within one location are harmless; competing locations require refusal.
        if (page === undefined || page !== pageAt(begin + last[i] + n)) {
          throw new Error(`Significant EPUB whitespace has ambiguous location ownership in ${href}.`);
        }
        points[part.paragraph].push({ start: part.start + n, end: part.start + n + 1, page });
      }
    });
  }
  const pages: ExtractedPage[] = locations.map((p) => ({ index: p.index, label: null, paragraphs: [], separatorBefore: "" }));
  const byIndex = new Map(pages.map((p) => [p.index, p]));
  const coverage = new Map<number, { start: number; end: number }>();
  const completeSource = sources.map((p) => p.text).join("\n\n");
  let sourceBase = 0;
  sources.forEach((source, paragraph) => {
    const mapped = points[paragraph].sort((a, b) => a.start - b.start);
    if (!mapped.length) throw new Error(`EPUB paragraph has no mapped content in ${href}.`);
    const significant = (offset: number) => source.whitespace.some((s) => offset >= s.start && offset < s.end);
    const emit = (page: number, from: number, to: number) => {
      // Trim only collapsible fragment edges; a preserved inline descendant must not make the
      // unrelated ordinary whitespace at a location boundary significant.
      while (from < to && /[ \t]/.test(source.text[from]) && !significant(from)) from++;
      while (to > from && /[ \t]/.test(source.text[to - 1]) && !significant(to - 1)) to--;
      if (to > from) {
        byIndex.get(page)!.paragraphs.push(source.text.slice(from, to));
        const previous = coverage.get(page);
        coverage.set(page, { start: previous?.start ?? sourceBase + from, end: sourceBase + to });
      }
    };
    let page = mapped[0].page, from = 0, previousEnd = 0;
    for (const point of mapped) {
      if (point.page < page || point.start < previousEnd) throw new Error(`Non-monotonic EPUB location mapping in ${href}.`);
      if (point.page !== page) {
        emit(page, from, previousEnd);
        from = previousEnd; page = point.page;
      }
      previousEnd = point.end;
    }
    emit(page, from, source.text.length);
    sourceBase += source.text.length + 2;
  });
  let end = 0;
  for (const page of pages) {
    const range = coverage.get(page.index);
    if (!range) continue;
    page.separatorBefore = completeSource.slice(end, range.start);
    if (completeSource.slice(range.start, range.end) !== page.paragraphs.join("\n\n")) throw new Error(`Incomplete EPUB source coverage in ${href}.`);
    end = range.end;
  }
  if (end !== completeSource.length) throw new Error(`Incomplete EPUB source coverage in ${href}.`);
  return pages;
}
