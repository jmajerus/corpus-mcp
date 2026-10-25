import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Calibre tag vocabulary: Concept Clusters' taxonomy (data/cc-taxonomy.json, from its
 * authoring:taxonomy:export) as hierarchical tags "Domain.Category.Subcategory". Commas are dropped
 * from names because Calibre and Calibre-Web split tags on commas; each tag keeps its slugs, so a
 * tag is never mapped back by parsing a name.
 */

interface TaxonomySnapshot {
  domains: { slug: string; name: string }[];
  categories: { slug: string; name: string; domain: string | null; subcategories?: { id: string; title: string }[] }[];
}

export interface VocabularyTag {
  tag: string;
  domain: string | null;
  category: string;
  subcategory: string | null;
}

export const DEFAULT_VOCABULARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "cc-taxonomy.json");

/** A name as one tag segment: no commas (Calibre's separator) and no dots (its hierarchy marker). */
export function tagSegment(name: string): string {
  return name.replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
}

export function buildVocabulary(snapshot: TaxonomySnapshot): VocabularyTag[] {
  const domains = new Map(snapshot.domains.map((d) => [d.slug, d.name]));
  const tags: VocabularyTag[] = [];
  for (const c of snapshot.categories) {
    const domain = c.domain ? domains.get(c.domain) : undefined;
    const base = [domain, c.name].filter((x): x is string => Boolean(x)).map(tagSegment).join(".");
    tags.push({ tag: base, domain: c.domain, category: c.slug, subcategory: null });
    for (const s of c.subcategories ?? []) {
      tags.push({ tag: `${base}.${tagSegment(s.title)}`, domain: c.domain, category: c.slug, subcategory: s.id });
    }
  }
  return tags.sort((a, b) => a.tag.localeCompare(b.tag));
}

export class Vocabulary {
  readonly tags: VocabularyTag[];
  private readonly byLower: Map<string, VocabularyTag>;

  constructor(snapshot: TaxonomySnapshot) {
    this.tags = buildVocabulary(snapshot);
    this.byLower = new Map(this.tags.map((t) => [t.tag.toLowerCase(), t]));
  }

  static load(file = DEFAULT_VOCABULARY): Vocabulary {
    return new Vocabulary(JSON.parse(fs.readFileSync(file, "utf8")) as TaxonomySnapshot);
  }

  /** The canonical vocabulary tag for a case-insensitive match, or undefined. */
  find(tag: string): VocabularyTag | undefined {
    return this.byLower.get(tag.trim().toLowerCase());
  }

  /** True when a Calibre tag is one of the vocabulary's tags. */
  has(tag: string): boolean {
    return this.byLower.has(tag.trim().toLowerCase());
  }
}
