import { ToolError, type Corpus } from "../tools.js";
import type { VocabularyFile } from "../vocabulary.js";
import { type OverlayTerm, slugify } from "./overlay.js";
import type { Taxonomy } from "./taxonomy.js";

/**
 * The taxonomy's operations for the MCP tools, the admin page, and the intake. The only part of
 * src/taxonomy/ that knows about books.
 */

function taxonomyOf(c: Corpus): Taxonomy {
  if (!c.taxonomy) throw new ToolError("This server has no taxonomy overlay.");
  return c.taxonomy;
}

/** Any term (a grouping one too) by id or title path, as its id. */
function existingPath(c: Corpus, value: string, what: string): string {
  const path = c.vocabulary.toSlugPath(value.trim()).toLowerCase();
  if (!c.vocabulary.labelFor(path)) throw new ToolError(`${what} "${value}" is not a term. Use get_tag_vocabulary for the terms.`);
  return path;
}

/** Overlay failures are the caller's to fix (a taken path, a bad slug), so they surface as tool errors. */
function attempt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw error instanceof ToolError ? error : new ToolError((error as Error).message);
  }
}

function freePath(c: Corpus, parent: string | null, segment: string): void {
  const path = parent ? `${parent}.${segment}` : segment;
  if (c.vocabulary.labelFor(path)) throw new ToolError(`"${path}" is already a term (${c.vocabulary.labelFor(path)}).`);
}

export interface AddTermArgs { parent?: string | null; label: string; slug?: string; scope_note?: string; alt_labels?: string[]; status?: "provisional" | "confirmed" }

/** A new overlay term, usable for tagging at once. */
export function addTerm(c: Corpus, args: AddTermArgs, actor: string | null) {
  const taxonomy = taxonomyOf(c);
  const parent = args.parent ? existingPath(c, args.parent, "Parent") : null;
  const slug = args.slug?.trim() || slugify(args.label);
  freePath(c, parent, slug);
  return attempt(() => {
    const term = taxonomy.overlay.add({ parent, label: args.label, slug, scopeNote: args.scope_note, altLabels: args.alt_labels, status: args.status }, actor);
    return { term: withLabel(c, term), note: noteFor(term) };
  });
}

export type TermAction =
  | { action: "edit"; label?: string; scope_note?: string | null; alt_labels?: string[] }
  | { action: "confirm" }
  | { action: "move"; parent?: string | null; slug?: string }
  | { action: "retire"; replaced_by?: string | null };

/** Edits, confirms, moves, or retires an overlay term. */
export function changeTerm(c: Corpus, id: string, change: TermAction, actor: string | null) {
  const overlay = taxonomyOf(c).overlay;
  const term = overlay.get(id);
  if (!term) throw new ToolError(`No overlay term "${id}".`);
  const result = attempt(() => {
    switch (change.action) {
      case "edit": return overlay.edit(id, { label: change.label, scopeNote: change.scope_note, altLabels: change.alt_labels }, actor);
      case "confirm": return overlay.confirm(id, actor);
      case "move": {
        const parent = change.parent === undefined ? parentOf(term.path) : change.parent ? existingPath(c, change.parent, "Parent") : null;
        const segment = change.slug?.trim() || term.path.split(".").at(-1)!;
        const to = parent ? `${parent}.${segment}` : segment;
        if (to === term.path) return term;
        if (parent === term.path || parent?.startsWith(`${term.path}.`)) throw new ToolError("A term cannot move below itself.");
        freePath(c, parent, segment);
        return overlay.move(id, to, actor);
      }
      case "retire": {
        const replacement = change.replaced_by ? c.vocabulary.find(change.replaced_by)?.tag : null;
        if (change.replaced_by && !replacement) throw new ToolError(`Replacement "${change.replaced_by}" is not an assignable term.`);
        return overlay.retire(id, replacement ?? null, actor);
      }
      default: throw new ToolError("action is one of edit, confirm, move, retire.");
    }
  });
  return { term: withLabel(c, result) };
}

/**
 * The intake: a vocabulary pushed by its owner, installed when valid. The response follows the agreed
 * contract (PLAN.md, "Living taxonomy"): 200 with the version and term count, unchanged when that
 * version is already installed, 422 with problems when invalid.
 */
export function installVocabulary(c: Corpus, body: unknown, actor: string | null): { status: number; body: Record<string, unknown> } {
  const taxonomy = taxonomyOf(c);
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 422, body: { problems: ["the body is not a vocabulary object"] } };
  const result = taxonomy.source.install(body as VocabularyFile);
  if ("problems" in result) return { status: 422, body: { problems: result.problems } };
  const { vocabulary, unchanged } = result;
  if (!unchanged) taxonomy.overlay.baseInstalled(vocabulary.version, vocabulary.terms.length, actor);
  const merged = c.vocabulary;
  return {
    status: 200,
    body: {
      version: vocabulary.version, terms: vocabulary.terms.length, ...(unchanged ? { unchanged: true } : {}),
      overlay: { terms: merged.terms.length - vocabulary.terms.length, orphans: taxonomy.orphans.length },
    },
  };
}

/** Everything the admin page shows: the supplied vocabulary, the overlay with book counts, and the history. */
export function taxonomyOverview(c: Corpus) {
  const taxonomy = taxonomyOf(c);
  const base = taxonomy.base();
  const merged = c.vocabulary;
  const install = taxonomy.overlay.lastBaseInstall();
  const booksWith = c.db.prepare<[string], { n: number }>("SELECT COUNT(DISTINCT b.id) AS n FROM books b, json_each(b.tags) j WHERE j.value = ?");
  const terms = taxonomy.overlay.list().map((t) => ({ ...withLabel(c, t), books: booksWith.get(t.path)?.n ?? 0 }));
  return {
    base: {
      version: base.version, generated_at: base.generatedAt, terms: base.terms.length, assignable: base.tags.length,
      error: taxonomy.source.error, installed: install ? { at: install.at, by: install.actor, detail: install.detail && JSON.parse(install.detail) } : null,
    },
    merged: { version: merged.version, terms: merged.terms.length, assignable: merged.tags.length, error: taxonomy.error },
    counts: Object.fromEntries(["provisional", "confirmed", "superseded", "retired"].map((s) => [s, terms.filter((t) => t.status === s).length])),
    terms,
    orphans: taxonomy.orphans,
    events: taxonomy.overlay.events({ limit: 50 }).map((e) => ({ ...e, detail: e.detail && JSON.parse(e.detail) })),
  };
}

/** Overlay counts for vocabulary_report. */
export function overlaySummary(c: Corpus) {
  if (!c.taxonomy) return null;
  const terms = c.taxonomy.overlay.list();
  return {
    provisional: terms.filter((t) => t.status === "provisional").map((t) => t.path),
    confirmed: terms.filter((t) => t.status === "confirmed").length,
    superseded: terms.filter((t) => t.status === "superseded").map((t) => t.path),
    orphans: c.taxonomy.orphans,
  };
}

function parentOf(path: string): string | null {
  return path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : null;
}

function withLabel(c: Corpus, t: OverlayTerm) {
  return { ...t, title_path: c.vocabulary.labelFor(t.path) ?? null };
}

function noteFor(t: OverlayTerm): string {
  return `"${t.path}" is a ${t.status} overlay term: use it with propose_tags now. If the vocabulary's owner later publishes a term at the same path, theirs takes over and books keep the tag; to make it a subcategory there, create it with the same slug ("${t.path.split(".").at(-1)}") under the same parent.`;
}
