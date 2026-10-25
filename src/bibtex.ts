/** BibTeX for filing a Calibre book in Zotero from its own metadata (no ISBN lookup). */
import { validIsbn } from "./isbn.js";

const SPECIAL = /[\\{}&%$#_~^]/g;
const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_",
  "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
};

export function escapeBibtex(value: string): string {
  return value.replace(SPECIAL, (c) => ESCAPES[c]).replace(/\s+/g, " ").trim();
}

/** "Gough, James" for a person (Calibre's sort form), "{Apple Inc.}" for an organization. */
export function bibtexName(name: string, sort: string | undefined): string {
  return sort?.includes(",") ? escapeBibtex(sort) : `{${escapeBibtex(name)}}`;
}

export interface BibtexBook {
  citekey: string;
  title: string;
  authors: string[];
  authorSorts: string[];
  publisher: string | null;
  year: number | null;
  isbn: string | null;
  calibreUuid: string | null;
}

export function bookBibtex(b: BibtexBook): string {
  const names = b.authors
    .map((name, i) => (name && name !== "Unknown" ? bibtexName(name, b.authorSorts[i]) : null))
    .filter((n): n is string => n !== null);
  const fields: [string, string | null][] = [
    ["title", escapeBibtex(b.title)],
    ["author", names.length ? names.join(" and ") : null],
    ["publisher", b.publisher ? escapeBibtex(b.publisher) : null],
    ["year", b.year ? String(b.year) : null],
    // Concept Clusters rejects an entry whose ISBN fails its check digit, so an invalid one is left out.
    ["isbn", b.isbn ? validIsbn(b.isbn) : null],
    ["note", b.calibreUuid ? `Calibre UUID: ${b.calibreUuid}` : null],
  ];
  const body = fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}},`).join("\n");
  return `@book{${b.citekey},\n${body}\n}`;
}
