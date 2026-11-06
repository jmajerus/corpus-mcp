import { CONTEXT, joinedPageText, locate, normalizeQuote, normalizeWithMap, type PageText, type QuoteAnchor } from "./quotes.js";

export type AnchorMigration = { status: "unchanged" | "remapped"; anchor: QuoteAnchor }
  | { status: "review"; reason: string };

/** Pandoc relocates blocks. Only migrate a verified, globally unique wording; repeated passages
 * need review rather than choosing an occurrence. Build the searchable book once per candidate. */
export function relocatedAnchorPlanner(before: PageText[], after: PageText[]): (old: QuoteAnchor) => AnchorMigration {
  let searchable: { text: string; starts: number[] } | undefined;
  return (old) => {
    const review = (reason: string): AnchorMigration => ({ status: "review", reason });
    // Reuse the old-profile validation, including exact text and complete grapheme boundaries.
    const valid = planAnchorMigration(before, before, old);
    if (valid.status === "review") return valid;
    if (!searchable) {
      let text = "";
      const starts: number[] = [];
      for (const page of after) {
        if (text) text += " "; // Pandoc locations are separated by paragraph breaks.
        starts.push(text.length);
        text += normalizeQuote(page.text);
      }
      searchable = { text, starts };
    }
    const want = normalizeQuote(old.text), at = searchable.text.indexOf(want);
    if (!want || at < 0) return review("wording-not-found");
    if (searchable.text.indexOf(want, at + 1) >= 0) return review("ambiguous-wording");
    const first = searchable.starts.findLastIndex((start) => start <= at);
    const last = searchable.starts.findLastIndex((start) => start <= at + want.length - 1);
    const anchor = locate(after.slice(first, last + 1), old.text);
    if (!anchor || normalizeQuote(anchor.text) !== want) return review("mapped-wording-changed");
    return { status: (Object.keys(anchor) as (keyof QuoteAnchor)[]).every((key) => anchor[key] === old[key]) ? "unchanged" : "remapped", anchor };
  };
}

/**
 * Dry-run mapping for a text-only re-extraction with stable locations. Equal normalized page streams
 * identify the same occurrence by position, even when its wording repeats. Never search for the first
 * matching quote: if a page's characters changed, or the old anchor is stale, require review.
 */
export function planAnchorMigration(before: PageText[], after: PageText[], old: QuoteAnchor): AnchorMigration {
  const review = (reason: string): AnchorMigration => ({ status: "review", reason });
  if (![old.start_page, old.end_page, old.start_offset, old.end_offset].every((n) => Number.isSafeInteger(n) && n >= 0)
    || old.end_page < old.start_page || (old.start_page === old.end_page && old.end_offset <= old.start_offset)) return review("invalid-anchor");
  const oldPages = new Map(before.map((p) => [p.page_index, p]));
  const newPages = new Map(after.map((p) => [p.page_index, p]));
  const previous: PageText[] = [], next: PageText[] = [];
  for (let index = old.start_page; index <= old.end_page; index++) {
    const a = oldPages.get(index), b = newPages.get(index);
    if (!a || !b) return review("missing-location");
    previous.push(a); next.push(b);
  }
  if (old.start_offset >= previous[0].text.length || old.end_offset > previous.at(-1)!.text.length) return review("invalid-offsets");
  const oldText = joinedPageText(previous, old.start_offset, old.end_offset).trim();
  if (!old.text || oldText !== old.text) return review("stale-old-anchor");
  const normalized = previous.map((p, i) => ({ before: normalizeWithMap(p.text), after: normalizeWithMap(next[i].text) }));
  if (normalized.some((p) => p.before.norm.trimEnd() !== p.after.norm.trimEnd())) return review("location-text-changed");
  const first = normalized[0], last = normalized.at(-1)!;
  const startIndex = first.before.map.findIndex((offset) => offset >= old.start_offset);
  const endIndex = last.before.map.findLastIndex((offset) => offset < old.end_offset);
  if (startIndex < 0 || endIndex < 0 || first.before.map[startIndex] !== old.start_offset
    || last.before.ends[endIndex] !== old.end_offset) return review("non-character-boundary");
  const start = first.after.map[startIndex], end = last.after.ends[endIndex];
  if (start === undefined || !Number.isFinite(end)) return review("unmappable-offsets");
  const text = joinedPageText(next, start, end).trim();
  if (normalizeWithMap(text).norm.trim() !== normalizeWithMap(old.text).norm.trim()) return review("mapped-wording-changed");
  const anchor: QuoteAnchor = {
    start_page: old.start_page, end_page: old.end_page, start_offset: start, end_offset: end, text,
    prefix: next[0].text.slice(Math.max(0, start - CONTEXT), start), suffix: next.at(-1)!.text.slice(end, end + CONTEXT),
  };
  return { status: (Object.keys(anchor) as (keyof QuoteAnchor)[]).every((key) => anchor[key] === old[key]) ? "unchanged" : "remapped", anchor };
}
