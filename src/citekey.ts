/**
 * Citekeys for Calibre books: Calibre's metadata as a CSL JSON item, given to @jmajerus/citekey's rule
 * (packages/citekey) under the configured preset, plus what in the metadata blocks a usable key.
 */
import { type CslItem, type CslName, type PresetName, citekeyWellFormed, presets, proposeCitekey as ruleKey } from "@jmajerus/citekey";
import type { BookMetadata } from "./calibre.js";

export type { PresetName };

export const DEFAULT_PRESET: PresetName = "author-year-word";

export function isPreset(name: string): name is PresetName {
  return Object.hasOwn(presets, name);
}

/**
 * A Calibre author as a CSL name ("Unknown" means none). Calibre writes a person's sort form surname
 * first ("Gough, James") and leaves organizations and single names without a comma, so a comma means
 * family and given, and no comma means a literal name.
 */
export function calibreName(name: string, sort: string | undefined): CslName | null {
  if (!name || name === "Unknown") return null;
  if (sort?.includes(",")) {
    const [family, ...rest] = sort.split(",");
    const given = rest.join(",").trim();
    return given ? { family: family.trim(), given } : { family: family.trim() };
  }
  return { literal: name };
}

export function calibreNames(authors: string[], sorts: string[]): CslName[] {
  return authors.map((name, i) => calibreName(name, sorts[i])).filter((n): n is CslName => n !== null);
}

/** The fields the citekey rule reads, from Calibre's metadata. */
export function calibreCsl(m: Pick<BookMetadata, "title" | "authors" | "authorSorts" | "publisher" | "year">): CslItem {
  const author = calibreNames(m.authors, m.authorSorts);
  return {
    title: m.title,
    ...(author.length ? { author } : {}),
    ...(m.publisher ? { publisher: m.publisher } : {}),
    ...(m.year ? { issued: { "date-parts": [[m.year]] } } : {}),
  };
}

/**
 * One Calibre author record naming several people: Calibre stores a comma inside a name as "|", so a
 * pasted author list becomes "James Gough| Daniel Bryant". "Rousseau| Jean-Jacques| 1712-1778" is one
 * person in the same shape, so these are flagged for a fix in Calibre rather than guessed at.
 */
export function mergedAuthorName(name: string): boolean {
  return /\||;|\s(?:and|&)\s/i.test(name);
}

export type CitekeyBlocker = "unknown_author" | "merged_authors" | "no_year" | "malformed";

/** The proposed key, and what keeps it from being a usable key (empty when it is ready). */
export function proposeCitekey(m: BookMetadata, preset: PresetName = DEFAULT_PRESET): { key: string; blockers: CitekeyBlocker[] } {
  const item = calibreCsl(m);
  const key = ruleKey(item, preset);
  const blockers: CitekeyBlocker[] = [];
  if (!item.author?.length) blockers.push("unknown_author");
  else if (m.authors.some(mergedAuthorName)) blockers.push("merged_authors");
  if (!m.year) blockers.push("no_year");
  if (!blockers.length && !citekeyWellFormed(key, item, preset)) blockers.push("malformed");
  return { key, blockers };
}

/** True when a key (perhaps with an a–z suffix) follows the preset's rule for this book. */
export function followsRule(key: string, m: Pick<BookMetadata, "title" | "authors" | "authorSorts" | "publisher" | "year">, preset: PresetName = DEFAULT_PRESET): boolean {
  return citekeyWellFormed(key, calibreCsl(m), preset);
}
