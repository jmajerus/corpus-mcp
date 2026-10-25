/**
 * Citekeys from CSL JSON items, by a configurable rule in the manner of Better BibTeX: an author part, a
 * year, and significant title words. A key from here is a proposal; the project that files the work
 * decides the final key (and any a–z suffix that keeps keys unique).
 *
 * cases.json holds the rule's test cases, each tagged with the preset it runs under.
 */

export interface CslName { family?: string; given?: string; literal?: string }

export interface CslItem {
  title?: string;
  author?: CslName[];
  editor?: CslName[];
  publisher?: string;
  issued?: { "date-parts"?: (number | string)[][]; raw?: string; literal?: string };
}

export interface CitekeyOptions {
  /** Which parts make the key, in order. */
  order: ("author" | "year" | "title")[];
  /**
   * An organization as author: "acronym" is its acronym when that stays at four letters or fewer
   * ("U.S. Geological Survey" → "usgs"), else its first two significant words; "words" is always the
   * first two words. With "acronym", an all-capitals publisher (2–6 letters) is taken as the
   * organization's usual short name.
   */
  institution: "acronym" | "words";
  /** With no author or editor, use the publisher (its acronym or first two words, less a trailing "University" or "Press"). */
  publisherFallback: boolean;
  /** Significant title words to use; 0 for none. */
  titleWords: number;
  /** "lower" ("future"), or "capitalize" each word ("FuturePower"). */
  titleCase: "lower" | "capitalize";
  /** Title words to skip: Better BibTeX's list, or your own (lowercase). */
  skipWords: "bbt" | string[];
  /** Skip a title word that equals the author part ("Feynman" in The Feynman Lectures by Feynman). */
  skipAuthorWord: boolean;
  /** Between parts. */
  separator: string;
}

export type PresetName = "author-year-word" | "bbt-default";

export const presets: Record<PresetName, CitekeyOptions> = {
  /** Author, year, and the first significant title word, all lowercase: "nye2011future". */
  "author-year-word": {
    order: ["author", "year", "title"], institution: "acronym", publisherFallback: true, titleWords: 1, titleCase: "lower",
    skipWords: "bbt", skipAuthorWord: true, separator: "",
  },
  /**
   * Close to Better BibTeX's default formula, auth.lower + shorttitle(3,3) + year: "nyeFuturePower2011".
   * Better BibTeX's own author and title handling has cases this does not reproduce; use a key Better
   * BibTeX assigned when you have one.
   */
  "bbt-default": {
    order: ["author", "title", "year"], institution: "words", publisherFallback: false, titleWords: 3, titleCase: "capitalize",
    skipWords: "bbt", skipAuthorWord: false, separator: "",
  },
};

// Better BibTeX's default skipwords, so title words match the keys it makes.
const BBT_SKIP_WORDS = (
  "a,ab,aboard,about,above,across,after,against,al,along,amid,among,an,and,anti,around,as,at,"
  + "before,behind,below,beneath,beside,besides,between,beyond,but,by,d,da,das,de,del,dell,dello,"
  + "dei,degli,della,dell,delle,dem,den,der,des,despite,die,do,down,du,during,ein,eine,einem,einen,"
  + "einer,eines,el,en,et,except,for,from,gli,i,il,in,inside,into,is,l,la,las,le,les,like,lo,los,"
  + "near,nor,of,off,on,onto,or,over,past,per,plus,round,save,since,so,some,sur,than,the,through,"
  + "to,toward,towards,un,una,unas,uno,unos,under,underneath,une,unlike,until,up,upon,versus,via,"
  + "von,while,with,within,without,yet,zu,zum"
).split(",");
const INSTITUTION_EXTRA_SKIP_WORDS = ["committee", "department", "office"];

// Letters NFKD does not decompose, written out as Better BibTeX does ("Philosophiæ" -> "philosophiae").
const LIGATURES: Record<string, string> = { "æ": "ae", "œ": "oe", "ø": "o", "ß": "ss", "ł": "l", "đ": "d", "ð": "d", "þ": "th" };

function ascii(value: unknown): string {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[æœøßłđðþ]/g, (letter) => LIGATURES[letter]);
}

function letters(value: string): string {
  return ascii(value).replace(/[^a-z]/g, "");
}

function resolve(options?: PresetName | Partial<CitekeyOptions>): CitekeyOptions {
  if (options === undefined) return presets["author-year-word"];
  if (typeof options === "string") {
    const preset = presets[options];
    if (!preset) throw new Error(`Unknown citekey preset "${options}". Presets: ${Object.keys(presets).join(", ")}.`);
    return preset;
  }
  return { ...presets["author-year-word"], ...options };
}

function skipSet(options: CitekeyOptions, extra: string[] = []): Set<string> {
  return new Set([...(options.skipWords === "bbt" ? BBT_SKIP_WORDS : options.skipWords), ...extra]);
}

/**
 * An organization's key part: its acronym when that stays at four letters or fewer ("U.S. Geological
 * Survey" -> "usgs"), else its first two significant words ("U.S. Senate Committee on Armed Services" ->
 * "ussenate"). Dotted abbreviations count as one word.
 */
export function institutionKey(name: string, options?: PresetName | Partial<CitekeyOptions>): string {
  const o = resolve(options);
  const skip = skipSet(o, INSTITUTION_EXTRA_SKIP_WORDS);
  const words = String(name ?? "").split(/\s+/)
    .map((word) => ({ dotted: /^(?:[A-Za-z]\.){2,}$/.test(word), text: letters(word) }))
    .filter((word) => word.text && !skip.has(word.text));
  const acronym = words.map((word) => (word.dotted ? word.text : word.text[0])).join("");
  if (o.institution === "acronym" && words.length >= 3 && acronym.length <= 4) return acronym;
  return words.slice(0, 2).map((word) => word.text).join("");
}

function authorPart(item: CslItem, o: CitekeyOptions): string {
  const first = item.author?.[0] ?? item.editor?.[0];
  // "Gennep, Arnold van" files under Gennep; "Kets de Vries" keeps its words; "Koefoed-Johnsen" keeps its hyphen.
  if (first?.family) return ascii(first.family).replace(/[^a-z-]/g, "");
  if (first?.literal) {
    // An organization's acronym in the publisher field is its usual short name.
    if (o.institution === "acronym" && /^[A-Z]{2,6}$/.test(item.publisher ?? "")) return item.publisher!.toLowerCase();
    return institutionKey(first.literal, o);
  }
  if (o.publisherFallback && item.publisher) return institutionKey(item.publisher, o).replace(/(?<=.)(university|press)$/, "");
  return "";
}

function yearPart(item: CslItem): string {
  const parts = item.issued?.["date-parts"]?.[0]?.[0];
  const text = parts !== undefined ? String(parts) : item.issued?.raw ?? item.issued?.literal ?? "";
  return String(text).match(/\b(\d{4})\b/)?.[1] ?? "";
}

function titlePart(item: CslItem, o: CitekeyOptions, auth: string): string {
  if (o.titleWords <= 0) return "";
  const skip = skipSet(o);
  // Hyphenated words stay whole ("Test-Enhanced" -> "testenhanced").
  const words = String(item.title ?? "").split(/[\s–—/:]+/)
    .map(letters)
    .filter((w) => w && !skip.has(w) && !(o.skipAuthorWord && w === auth))
    .slice(0, o.titleWords);
  return words.map((w) => (o.titleCase === "capitalize" ? w[0].toUpperCase() + w.slice(1) : w)).join("");
}

/** The proposed citekey for a CSL item, by a preset (default "author-year-word") or options. */
export function proposeCitekey(item: CslItem, options?: PresetName | Partial<CitekeyOptions>): string {
  const o = resolve(options);
  const auth = authorPart(item, o);
  const parts = { author: auth, year: yearPart(item), title: titlePart(item, o, auth) };
  return o.order.map((p) => parts[p]).filter(Boolean).join(o.separator);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when a key has the rule's shape for this item: an author part, a year when the item has one,
 * and title letters, in the rule's order. An a–z suffix (added for uniqueness) is allowed.
 */
export function citekeyWellFormed(key: string, item: CslItem, options?: PresetName | Partial<CitekeyOptions>): boolean {
  const o = resolve(options);
  const hasYear = Boolean(yearPart(item));
  const shapes = { author: "[a-z][a-z-]*", year: hasYear ? "\\d{4}" : "", title: o.titleWords > 0 ? (o.titleCase === "lower" ? "[a-z]+" : "[A-Za-z]+") : "" };
  const body = o.order.map((p) => shapes[p]).filter(Boolean).join(escapeRegExp(o.separator));
  return new RegExp(`^${body}[a-z]?$`).test(key);
}
