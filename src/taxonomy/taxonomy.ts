import type { DataStore } from "../data.js";
import { Vocabulary, type VocabularyFile, type VocabularySource, type VocabularyTerm } from "../vocabulary.js";
import { ACTIVE, Overlay, type OverlayTerm } from "./overlay.js";

/** An active overlay term the merge had to leave out, and why. */
export interface Orphan { id: string; path: string; reason: string }

/**
 * The supplied vocabulary with the overlay merged over it. The supplied vocabulary wins: an overlay term
 * whose path it now has is superseded, and books keep their tag. An overlay term whose parent is gone
 * is left out and reported, never fatal, so a push can't be refused because of corpus-mcp's own terms.
 */
export function mergeOverlay(base: Vocabulary, terms: OverlayTerm[]): { vocabulary: Vocabulary; orphans: Orphan[] } {
  if (!terms.length) return { vocabulary: base, orphans: [] };
  const ids = new Set(base.terms.map((t) => t.tag));
  const added: VocabularyTerm[] = [];
  const orphans: Orphan[] = [];
  const active = terms.filter((t) => ACTIVE.includes(t.status)).sort((a, b) => a.path.split(".").length - b.path.split(".").length || a.path.localeCompare(b.path));
  for (const t of active) {
    const parent = t.path.includes(".") ? t.path.slice(0, t.path.lastIndexOf(".")) : null;
    if (ids.has(t.path)) orphans.push({ id: t.id, path: t.path, reason: "the supplied vocabulary has this path (not yet marked superseded)" });
    else if (parent && !ids.has(parent)) orphans.push({ id: t.id, path: t.path, reason: `parent "${parent}" is not a term` });
    else {
      ids.add(t.path);
      added.push({
        id: t.path, label: t.label, parent, assignable: true, status: t.status as "provisional" | "confirmed",
        ...(t.scope_note ? { scopeNote: t.scope_note } : {}),
      });
    }
  }
  // Moved and retired overlay terms: their old paths re-tag to the new one when there is exactly one.
  const baseRetired = base.file.retired ?? [];
  const retired = new Map(baseRetired.map((r) => [r.id, r.replacedBy]));
  const live = (path: string | null) => (path && ids.has(path) ? [path] : []);
  for (const t of terms) {
    // A superseded term's path is the supplied vocabulary's now, so its old paths still lead there.
    const target = t.status === "retired" ? t.replaced_by : t.path;
    for (const old of t.former_paths) if (!ids.has(old) && !retired.has(old)) retired.set(old, live(target));
    if (t.status === "retired" && !ids.has(t.path) && !retired.has(t.path)) retired.set(t.path, live(t.replaced_by));
  }
  // The supplied version alone while the overlay adds nothing; otherwise it carries the overlay's fingerprint.
  const contributes = added.length > 0 || retired.size > baseRetired.length;
  const file: VocabularyFile = {
    ...base.file,
    version: contributes ? `${base.version ?? "none"}+overlay.${hash(added, retired)}` : base.version ?? undefined,
    terms: [...base.file.terms, ...added],
    retired: [...retired].map(([id, replacedBy]) => ({ id, replacedBy: replacedBy.filter((r) => ids.has(r)) })).filter((r) => !ids.has(r.id)),
  };
  return { vocabulary: new Vocabulary(file), orphans };
}

/** A short, stable fingerprint of the overlay's contribution, so the merged version changes exactly when it does. */
function hash(added: VocabularyTerm[], retired: Map<string, string[]>): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify([added, [...retired].sort()])) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * What corpus-mcp's tools see as the vocabulary: the supplied one (a file, refreshed by its source) with
 * the overlay merged over it, rebuilt when either changes.
 */
export class Taxonomy {
  readonly overlay: Overlay;
  orphans: Orphan[] = [];
  error: string | null = null;
  private cache: { base: Vocabulary; revision: number; merged: Vocabulary } | null = null;

  constructor(data: DataStore, readonly source: VocabularySource, private readonly onChange: (v: Vocabulary) => void = () => {}) {
    this.overlay = new Overlay(data);
  }

  base(): Vocabulary {
    return this.source.current();
  }

  current(): Vocabulary {
    const base = this.base();
    const revision = this.overlay.revision;
    if (this.cache?.base === base && this.cache.revision === revision) return this.cache.merged;
    if (this.cache?.base !== base) {
      // A new supplied vocabulary: overlay terms it now has give way to it.
      const superseded = this.overlay.supersede(new Set(base.terms.map((t) => t.tag)), "vocabulary");
      if (superseded.length) console.error(`superseded ${superseded.length} overlay term(s): ${superseded.map((t) => t.path).join(", ")}`);
    }
    let merged = base;
    try {
      const result = mergeOverlay(base, this.overlay.list());
      merged = result.vocabulary;
      this.orphans = result.orphans;
      this.error = null;
    } catch (error) {
      // Only a bug can get here (the merge checks every term), but the supplied vocabulary must stay usable.
      this.error = `The overlay could not be merged: ${(error as Error).message}`;
      console.error(this.error);
    }
    const changed = this.cache?.merged.version !== merged.version || this.cache?.merged.terms.length !== merged.terms.length;
    this.cache = { base, revision: this.overlay.revision, merged };
    if (changed) this.onChange(merged);
    return merged;
  }
}
