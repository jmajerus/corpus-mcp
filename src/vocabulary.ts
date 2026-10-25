import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Calibre tag vocabulary: Concept Clusters' taxonomy (data/cc-taxonomy.json, from its
 * authoring:taxonomy:export) as hierarchical tags of slugs, "domain.category.subcategory", such as
 * "social-sciences.psychology.social-psychology". Slugs are Concept Clusters' stable ids, so a renamed
 * category leaves Calibre's tags valid, and they hold no commas (Calibre's tag separator). Each tag
 * carries its title path as a label, and lookups accept either form.
 */

interface TaxonomySnapshot {
  domains: { slug: string; name: string }[];
  categories: { slug: string; name: string; domain: string | null; subcategories?: { id: string; title: string }[] }[];
}

export interface VocabularyTag {
  /** The Calibre tag: slugs joined with ".". */
  tag: string;
  /** The same path in display titles, joined with " › ". */
  label: string;
  domain: string | null;
  category: string;
  subcategory: string | null;
}

export const DEFAULT_VOCABULARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "cc-taxonomy.json");

/** A title compared loosely: case, commas, and spacing ignored, so "Science, Technology & Society" matches "science technology & society". */
function looseTitle(title: string): string {
  return title.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

/** A tag or title path split into segments, on "." or " › ". */
function segments(value: string): string[] {
  return value.split(/\s*›\s*|\./).map((s) => s.trim()).filter(Boolean);
}

export function buildVocabulary(snapshot: TaxonomySnapshot): VocabularyTag[] {
  const domains = new Map(snapshot.domains.map((d) => [d.slug, d.name]));
  const tags: VocabularyTag[] = [];
  for (const c of snapshot.categories) {
    const domainName = c.domain ? domains.get(c.domain) : undefined;
    const slugs = [c.domain && domainName ? c.domain : null, c.slug].filter((x): x is string => Boolean(x));
    const titles = [domainName, c.name].filter((x): x is string => Boolean(x));
    tags.push({ tag: slugs.join("."), label: titles.join(" › "), domain: c.domain, category: c.slug, subcategory: null });
    for (const s of c.subcategories ?? []) {
      tags.push({
        tag: [...slugs, s.id].join("."), label: [...titles, s.title].join(" › "),
        domain: c.domain, category: c.slug, subcategory: s.id,
      });
    }
  }
  return tags.sort((a, b) => a.tag.localeCompare(b.tag));
}

export class Vocabulary {
  readonly tags: VocabularyTag[];
  private readonly byTag: Map<string, VocabularyTag>;
  private readonly byTitlePath: Map<string, VocabularyTag>;
  /** Each title (loosely compared) to its slug, for translating title segments in a filter. */
  private readonly slugByTitle: Map<string, string>;

  constructor(snapshot: TaxonomySnapshot) {
    this.tags = buildVocabulary(snapshot);
    this.byTag = new Map(this.tags.map((t) => [t.tag, t]));
    this.byTitlePath = new Map(this.tags.map((t) => [segments(t.label).map(looseTitle).join("."), t]));
    this.slugByTitle = new Map();
    for (const t of this.tags) {
      const slugs = t.tag.split(".");
      segments(t.label).forEach((title, i) => {
        if (!this.slugByTitle.has(looseTitle(title))) this.slugByTitle.set(looseTitle(title), slugs[i]);
      });
    }
  }

  static load(file = DEFAULT_VOCABULARY): Vocabulary {
    return new Vocabulary(JSON.parse(fs.readFileSync(file, "utf8")) as TaxonomySnapshot);
  }

  /**
   * The vocabulary entry for a slug tag ("social-sciences.psychology") or a title path ("Social
   * Sciences › Psychology", "Social Sciences.Psychology"), case-insensitively; undefined if neither.
   */
  find(value: string): VocabularyTag | undefined {
    const tag = value.trim().toLowerCase();
    const exact = this.byTag.get(tag) ?? this.byTitlePath.get(segments(value).map(looseTitle).join("."));
    if (exact) return exact;
    // A bare category or subcategory ("Sociology", "social-change") when exactly one tag ends with it.
    const last = looseTitle(value);
    const matches = this.tags.filter((t) => t.tag.split(".").at(-1) === tag || looseTitle(segments(t.label).at(-1) ?? "") === last);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** True when a Calibre tag is one of the vocabulary's slug tags. */
  has(tag: string): boolean {
    return this.byTag.has(tag.trim().toLowerCase());
  }

  /** The title path for a slug tag or any prefix of one, e.g. "social-sciences" → "Social Sciences". */
  labelFor(tag: string): string | undefined {
    const exact = this.byTag.get(tag.toLowerCase());
    if (exact) return exact.label;
    const prefix = this.tags.find((t) => t.tag.startsWith(`${tag.toLowerCase()}.`));
    return prefix ? segments(prefix.label).slice(0, tag.split(".").length).join(" › ") : undefined;
  }

  /**
   * A filter value in slug form: each segment that is a known title becomes its slug, anything else
   * is kept, so "Psychology" → "psychology", "Media & Information Literacy" → "media-information-literacy",
   * and a free-form tag like "misinformation" passes through.
   */
  toSlugPath(value: string): string {
    return segments(value).map((s) => this.slugByTitle.get(looseTitle(s)) ?? s).join(".");
  }
}
