/**
 * Citekeys by Concept Clusters' rule (modules/citationKeys.js there), Better BibTeX's
 * auth.lower + year + title.skipwords.select(1, 1).lower with its fallbacks for institutions,
 * missing authors, and a title word that repeats the author. tests/citekey-cases.json is
 * shared with Concept Clusters; keep both copies identical so the two ports cannot drift.
 */
import type { BookMetadata } from "./calibre.js";

export interface Creator { creatorType: string; lastName?: string; firstName?: string; name?: string }

/** Zotero's item shape, the input the shared rule is written against. */
export interface CitationData { title?: string; date?: string; publisher?: string; creators?: Creator[] }

// Better BibTeX's default skipwords, so title words match the keys it makes.
const SKIP_WORDS = new Set((
  "a,ab,aboard,about,above,across,after,against,al,along,amid,among,an,and,anti,around,as,at,"
  + "before,behind,below,beneath,beside,besides,between,beyond,but,by,d,da,das,de,del,dell,dello,"
  + "dei,degli,della,dell,delle,dem,den,der,des,despite,die,do,down,du,during,ein,eine,einem,einen,"
  + "einer,eines,el,en,et,except,for,from,gli,i,il,in,inside,into,is,l,la,las,le,les,like,lo,los,"
  + "near,nor,of,off,on,onto,or,over,past,per,plus,round,save,since,so,some,sur,than,the,through,"
  + "to,toward,towards,un,una,unas,uno,unos,under,underneath,une,unlike,until,up,upon,versus,via,"
  + "von,while,with,within,without,yet,zu,zum"
).split(","));
const INSTITUTION_SKIP_WORDS = new Set([...SKIP_WORDS, "committee", "department", "office"]);

// Letters NFKD does not decompose, written out as Better BibTeX does ("Philosophiæ" -> "philosophiae").
const LIGATURES: Record<string, string> = { "æ": "ae", "œ": "oe", "ø": "o", "ß": "ss", "ł": "l", "đ": "d", "ð": "d", "þ": "th" };

function ascii(value: unknown): string {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[æœøßłđðþ]/g, (letter) => LIGATURES[letter]);
}

function letters(value: string): string {
  return ascii(value).replace(/[^a-z]/g, "");
}

/**
 * An acronym when it stays short ("U.S. Geological Survey" -> "usgs"), else the first two
 * significant words ("U.S. Senate Committee on Armed Services" -> "ussenate").
 */
export function institutionKey(name: string): string {
  const words = String(name ?? "").split(/\s+/)
    .map((word) => ({ dotted: /^(?:[A-Za-z]\.){2,}$/.test(word), text: ascii(word).replace(/[^a-z]/g, "") }))
    .filter((word) => word.text && !INSTITUTION_SKIP_WORDS.has(word.text));
  const acronym = words.map((word) => (word.dotted ? word.text : word.text[0])).join("");
  if (words.length >= 3 && acronym.length <= 4) return acronym;
  return words.slice(0, 2).map((word) => word.text).join("");
}

export function authorPart(data: CitationData): string {
  const creators = data.creators ?? [];
  const first = creators.find((c) => c.creatorType === "author")
    ?? creators.find((c) => c.creatorType === "editor")
    ?? creators[0];
  // "Gennep, Arnold van" files under Gennep; "Kets de Vries" keeps its words; "Koefoed-Johnsen" keeps its hyphen.
  if (first?.lastName) return ascii(first.lastName).replace(/[^a-z-]/g, "");
  // An institution's acronym in the publisher field is its usual short name.
  if (first?.name) return /^[A-Z]{2,6}$/.test(data.publisher ?? "") ? data.publisher!.toLowerCase() : institutionKey(first.name);
  return data.publisher ? institutionKey(data.publisher).replace(/(?<=.)(university|press)$/, "") : "";
}

export function proposedCitationKey(data: CitationData): string {
  const auth = authorPart(data);
  const year = String(data.date ?? "").match(/\b(\d{4})\b/)?.[1] ?? "";
  // Hyphenated words stay whole ("Test-Enhanced" -> "testenhanced").
  const word = String(data.title ?? "").split(/[\s–—/:]+/)
    .map(letters)
    .find((candidate) => candidate && !SKIP_WORDS.has(candidate) && candidate !== auth) ?? "";
  return `${auth}${year}${word}`;
}

/** Author, then a year when the work has one, then a title word. */
export function citationKeyWellFormed(key: string, data: CitationData): boolean {
  const hasYear = /\b\d{4}\b/.test(String(data.date ?? ""));
  return hasYear ? /^[a-z][a-z-]*\d{4}[a-z]+$/.test(key) : /^[a-z][a-z-]*$/.test(key);
}

/** A key as Concept Clusters may assign it: the well-formed shape plus an optional a–z suffix. */
export const CITEKEY_PATTERN = /^[a-z][a-z-]*(?:\d{4})?[a-z]+$/;

/**
 * Calibre's author ("Unknown" means none) as a Zotero creator. Calibre writes a person's sort form
 * surname first ("Gough, James") and leaves organizations and single names without a comma, the
 * same split as Zotero's two-field and single-field creators.
 */
export function calibreCreator(name: string, sort: string | undefined): Creator | null {
  if (!name || name === "Unknown") return null;
  if (sort?.includes(",")) {
    const [lastName, ...rest] = sort.split(",");
    return { creatorType: "author", lastName: lastName.trim(), firstName: rest.join(",").trim() };
  }
  return { creatorType: "author", name };
}

export function calibreCitationData(m: BookMetadata): CitationData {
  return {
    title: m.title,
    date: m.year ? String(m.year) : "",
    publisher: m.publisher ?? "",
    creators: m.authors.map((name, i) => calibreCreator(name, m.authorSorts[i])).filter((c): c is Creator => c !== null),
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
export function proposeCitekey(m: BookMetadata): { key: string; blockers: CitekeyBlocker[] } {
  const data = calibreCitationData(m);
  const key = proposedCitationKey(data);
  const blockers: CitekeyBlocker[] = [];
  if (!data.creators?.length) blockers.push("unknown_author");
  else if (m.authors.some(mergedAuthorName)) blockers.push("merged_authors");
  if (!m.year) blockers.push("no_year");
  if (!blockers.length && !citationKeyWellFormed(key, data)) blockers.push("malformed");
  return { key, blockers };
}
