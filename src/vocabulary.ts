import fs from "node:fs";

/**
 * The Calibre tag vocabulary: a JSON file (format "corpus-vocabulary/1") supplied by whoever owns the
 * taxonomy. Terms form a tree by id: "social-sciences.psychology.social-psychology" is the child of
 * "social-sciences.psychology". Ids are the Calibre tags, so a renamed term leaves Calibre's tags valid,
 * and they hold no commas (Calibre's tag separator). Each term carries its own title as a label; lookups
 * accept an id, a title path, or a unique bare name.
 *
 * corpus-mcp reads the vocabulary and never edits it.
 */

export const VOCABULARY_FORMAT = "corpus-vocabulary/1";

export interface VocabularyTerm {
  id: string;
  label: string;
  parent?: string | null;
  /** false for a term that only groups others; books are not tagged with it. */
  assignable?: boolean;
}

export interface RetiredTerm {
  id: string;
  /** One id: re-tag automatically. Several (a split) or none: a person decides. */
  replacedBy: string[];
}

export interface VocabularyFile {
  format: string;
  version?: string;
  generatedAt?: string;
  terms: VocabularyTerm[];
  retired?: RetiredTerm[];
}

export interface VocabularyTag {
  /** The Calibre tag: the term's id. */
  tag: string;
  /** The title path, the ancestors' labels and its own joined with " › ". */
  label: string;
  /** The term's own label. */
  name: string;
  parent: string | null;
  assignable: boolean;
}

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A title compared loosely: case, commas, and spacing ignored, so "Science, Technology & Society" matches "science technology & society". */
function looseTitle(title: string): string {
  return title.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

/** A tag or title path split into segments, on "." or " › ". */
function segments(value: string): string[] {
  return value.split(/\s*›\s*|\./).map((s) => s.trim()).filter(Boolean);
}

/** Every problem with a vocabulary file; empty when it is valid. */
export function vocabularyProblems(file: VocabularyFile): string[] {
  const problems: string[] = [];
  if (file?.format !== VOCABULARY_FORMAT) problems.push(`format is "${String(file?.format)}", expected "${VOCABULARY_FORMAT}"`);
  if (!Array.isArray(file?.terms)) return [...problems, "terms is not a list"];
  const ids = new Set<string>();
  for (const t of file.terms) {
    if (ids.has(t.id)) problems.push(`duplicate id "${t.id}"`);
    ids.add(t.id);
  }
  for (const t of file.terms) {
    const parts = String(t.id ?? "").split(".");
    const own = parts.at(-1)!;
    if (!SEGMENT.test(own)) problems.push(`"${t.id}": the last segment must be lowercase letters, digits, and single hyphens`);
    const expectedParent = parts.length > 1 ? parts.slice(0, -1).join(".") : null;
    if ((t.parent ?? null) !== expectedParent) problems.push(`"${t.id}": parent is "${t.parent ?? ""}", but the id says "${expectedParent ?? ""}"`);
    else if (expectedParent && !ids.has(expectedParent)) problems.push(`"${t.id}": parent "${expectedParent}" is not a term`);
    if (!t.label?.trim()) problems.push(`"${t.id}": no label`);
    else if (/[.›]/.test(t.label)) problems.push(`"${t.id}": the label "${t.label}" contains "." or "›"`);
  }
  for (const r of file.retired ?? []) {
    if (ids.has(r.id)) problems.push(`retired "${r.id}" is still a term`);
    if (!Array.isArray(r.replacedBy)) problems.push(`retired "${r.id}": replacedBy is not a list`);
    for (const id of r.replacedBy ?? []) if (!ids.has(id)) problems.push(`retired "${r.id}": replacement "${id}" is not a term`);
  }
  return problems;
}

export class Vocabulary {
  /** The terms books can be tagged with, by id. */
  readonly tags: VocabularyTag[];
  /** Every term, grouping terms included. */
  readonly terms: VocabularyTag[];
  readonly version: string | null;
  readonly generatedAt: string | null;
  private readonly byId: Map<string, VocabularyTag>;
  private readonly byTitlePath: Map<string, VocabularyTag>;
  /** Each title (loosely compared) to its id segment, for translating title segments in a filter. */
  private readonly slugByTitle: Map<string, string>;
  private readonly retiredById: Map<string, string[]>;

  constructor(file: VocabularyFile) {
    const problems = vocabularyProblems(file);
    if (problems.length) throw new Error(`Invalid vocabulary: ${problems.slice(0, 10).join("; ")}${problems.length > 10 ? ` (and ${problems.length - 10} more)` : ""}`);
    this.version = file.version ?? null;
    this.generatedAt = file.generatedAt ?? null;
    const raw = new Map(file.terms.map((t) => [t.id, t]));
    const path = (id: string): string => {
      const t = raw.get(id)!;
      return t.parent ? `${path(t.parent)} › ${t.label.trim()}` : t.label.trim();
    };
    this.terms = file.terms
      .map((t) => ({ tag: t.id, label: path(t.id), name: t.label.trim(), parent: t.parent ?? null, assignable: t.assignable !== false }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    this.tags = this.terms.filter((t) => t.assignable);
    this.byId = new Map(this.terms.map((t) => [t.tag, t]));
    this.byTitlePath = new Map(this.tags.map((t) => [segments(t.label).map(looseTitle).join("."), t]));
    this.slugByTitle = new Map();
    for (const t of this.terms) if (!this.slugByTitle.has(looseTitle(t.name))) this.slugByTitle.set(looseTitle(t.name), t.tag.split(".").at(-1)!);
    this.retiredById = new Map((file.retired ?? []).map((r) => [r.id, r.replacedBy]));
  }

  static empty(): Vocabulary {
    return new Vocabulary({ format: VOCABULARY_FORMAT, terms: [] });
  }

  /** The vocabulary in a file; throws when the file is missing or invalid. */
  static load(file: string): Vocabulary {
    return new Vocabulary(JSON.parse(fs.readFileSync(file, "utf8")) as VocabularyFile);
  }

  /**
   * The assignable term for an id ("social-sciences.psychology") or a title path ("Social Sciences ›
   * Psychology", "Social Sciences.Psychology"), case-insensitively; a retired id with a single
   * replacement finds the replacement. Undefined if none.
   */
  find(value: string): VocabularyTag | undefined {
    const tag = value.trim().toLowerCase();
    const replaced = this.retiredById.get(tag);
    if (replaced?.length === 1) return this.byId.get(replaced[0]);
    const exact = this.byId.get(tag) ?? this.byTitlePath.get(segments(value).map(looseTitle).join("."));
    if (exact) return exact.assignable ? exact : undefined;
    // A bare name ("Sociology", "social-change") when exactly one assignable term ends with it.
    const last = looseTitle(value);
    const matches = this.tags.filter((t) => t.tag.split(".").at(-1) === tag || looseTitle(t.name) === last);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** True when a Calibre tag is one of the vocabulary's assignable terms. */
  has(tag: string): boolean {
    return this.byId.get(tag.trim().toLowerCase())?.assignable === true;
  }

  /** What replaces a retired tag (one id: automatic; several or none: a person decides), or undefined if it is not retired. */
  retired(tag: string): string[] | undefined {
    return this.retiredById.get(tag.trim().toLowerCase());
  }

  /** True when an assignable term has assignable terms below it. */
  hasChildren(tag: string): boolean {
    const prefix = `${tag.toLowerCase()}.`;
    return this.tags.some((t) => t.tag.startsWith(prefix));
  }

  /** The title path for a term, grouping terms included, e.g. "social-sciences" → "Social Sciences". */
  labelFor(tag: string): string | undefined {
    return this.byId.get(tag.toLowerCase())?.label;
  }

  /**
   * A filter value in id form: each segment that is a known title becomes its id segment, anything else
   * is kept, so "Psychology" → "psychology", "Media & Information Literacy" → "media-information-literacy",
   * and a free-form tag like "misinformation" passes through.
   */
  toSlugPath(value: string): string {
    return segments(value).map((s) => this.slugByTitle.get(looseTitle(s)) ?? s).join(".");
  }
}

/**
 * The vocabulary file, reloaded when it changes. A missing file means an empty vocabulary; an invalid
 * one is reported and the last good vocabulary stays in use.
 */
export class VocabularySource {
  private vocabulary: Vocabulary = Vocabulary.empty();
  private stamp = "";
  private checkedAt = 0;
  error: string | null = null;

  constructor(readonly file: string, private readonly onChange: (v: Vocabulary) => void = () => {}, private readonly checkEveryMs = 5000) {
    this.refresh();
  }

  current(): Vocabulary {
    if (Date.now() - this.checkedAt >= this.checkEveryMs) this.refresh();
    return this.vocabulary;
  }

  private refresh(): void {
    this.checkedAt = Date.now();
    let stamp = "missing";
    try {
      const s = fs.statSync(this.file);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      // Missing: fall through to the empty vocabulary.
    }
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    try {
      this.vocabulary = stamp === "missing" ? Vocabulary.empty() : Vocabulary.load(this.file);
      this.error = stamp === "missing" ? `No vocabulary file at ${this.file}.` : null;
      if (this.error) console.error(this.error);
      this.onChange(this.vocabulary);
    } catch (error) {
      this.error = `${this.file}: ${(error as Error).message}`;
      console.error(`${this.error} Keeping the previous vocabulary.`);
    }
  }
}
