import crypto from "node:crypto";
import type { DataStore } from "../data.js";

/**
 * The taxonomy overlay: corpus-mcp's own terms, coined during research and usable for tagging at once,
 * without waiting for the supplied vocabulary to gain them. Built to the master taxonomy's model so
 * nothing migrates when that server exists (PLAN.md, "Living taxonomy"): opaque ids that survive a move,
 * the path (the Calibre tag) as an alias, a scope note per term, and every change logged as an event.
 * It keeps its own tables in data.db (backed up nightly) and touches no other table.
 */

export type TermStatus = "provisional" | "confirmed" | "superseded" | "retired";
export const ACTIVE: readonly TermStatus[] = ["provisional", "confirmed"];

export interface OverlayTerm {
  id: string;
  /** The Calibre tag: "parent.child", like a vocabulary id. */
  path: string;
  label: string;
  scope_note: string | null;
  alt_labels: string[];
  status: TermStatus;
  /** Paths the term had before a move; the merged vocabulary retires them in favour of the current one. */
  former_paths: string[];
  /** For a retired term: the path that replaces it, if one does. */
  replaced_by: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export type EventKind = "added" | "relabeled" | "scope_changed" | "moved" | "confirmed" | "superseded" | "retired" | "base_installed";

export interface TaxonomyEvent {
  id: number; at: string; kind: EventKind; term_id: string | null; path: string | null; detail: string | null; actor: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS taxonomy_terms (
  id TEXT PRIMARY KEY,               -- opaque and stable: survives relabels and moves
  path TEXT NOT NULL,                -- the Calibre tag; unique among active terms
  label TEXT NOT NULL,
  scope_note TEXT,
  alt_labels TEXT NOT NULL DEFAULT '[]',   -- JSON array
  status TEXT NOT NULL CHECK (status IN ('provisional', 'confirmed', 'superseded', 'retired')),
  former_paths TEXT NOT NULL DEFAULT '[]', -- JSON array, oldest first
  replaced_by TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS taxonomy_terms_path ON taxonomy_terms(path);
-- Every change, in order: the overlay's history now and the master taxonomy's changelog later.
CREATE TABLE IF NOT EXISTS taxonomy_events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  term_id TEXT,                      -- null for base_installed
  path TEXT,
  detail TEXT,                       -- JSON: what changed
  actor TEXT
);
CREATE INDEX IF NOT EXISTS taxonomy_events_term ON taxonomy_events(term_id, id);`;

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A label as an id segment: "Media & Information Literacy" → "media-information-literacy". */
export function slugify(label: string): string {
  return label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface TermRow extends Omit<OverlayTerm, "alt_labels" | "former_paths"> { alt_labels: string; former_paths: string }

const toTerm = (r: TermRow): OverlayTerm => ({ ...r, alt_labels: JSON.parse(r.alt_labels), former_paths: JSON.parse(r.former_paths) });

export class Overlay {
  constructor(readonly data: DataStore) {
    data.exec(SCHEMA);
  }

  /**
   * The latest event's id: it changes on every write, so a merged vocabulary knows when to rebuild. Read
   * from the database, since the stdio and HTTP servers are separate processes sharing data.db.
   */
  get revision(): number {
    return this.data.prepare("SELECT COALESCE(MAX(id), 0) FROM taxonomy_events").pluck().get() as number;
  }

  list(statuses?: readonly TermStatus[]): OverlayTerm[] {
    const rows = this.data.prepare("SELECT * FROM taxonomy_terms ORDER BY path, created_at").all() as TermRow[];
    return rows.map(toTerm).filter((t) => !statuses || statuses.includes(t.status));
  }

  get(id: string): OverlayTerm | undefined {
    const row = this.data.prepare<[string], TermRow>("SELECT * FROM taxonomy_terms WHERE id = ?").get(id);
    return row && toTerm(row);
  }

  /** The active term at a path, if any. */
  atPath(path: string): OverlayTerm | undefined {
    return this.list(ACTIVE).find((t) => t.path === path);
  }

  events(opts: { term?: string; limit?: number } = {}): TaxonomyEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    return (opts.term
      ? this.data.prepare("SELECT * FROM taxonomy_events WHERE term_id = ? ORDER BY id DESC LIMIT ?").all(opts.term, limit)
      : this.data.prepare("SELECT * FROM taxonomy_events ORDER BY id DESC LIMIT ?").all(limit)) as TaxonomyEvent[];
  }

  /**
   * A new term under `parent`, an existing path (checked by the caller against the merged vocabulary).
   * The segment is the slug given, or one made from the label.
   */
  add(args: { parent: string | null; label: string; slug?: string; scopeNote?: string; altLabels?: string[]; status?: "provisional" | "confirmed" },
    actor: string | null): OverlayTerm {
    const label = cleanLabel(args.label);
    const segment = args.slug?.trim() || slugify(label);
    if (!SEGMENT.test(segment)) throw new Error(`"${segment}" is not a valid id segment: lowercase letters, digits, and single hyphens.`);
    const path = args.parent ? `${args.parent}.${segment}` : segment;
    if (this.atPath(path)) throw new Error(`The overlay already has "${path}".`);
    const now = new Date().toISOString();
    const term: OverlayTerm = {
      id: `t_${crypto.randomBytes(8).toString("base64url")}`, path, label, scope_note: args.scopeNote?.trim() || null,
      alt_labels: cleanAltLabels(args.altLabels), status: args.status ?? "provisional", former_paths: [], replaced_by: null,
      created_at: now, created_by: actor, updated_at: now, updated_by: actor,
    };
    this.data.transaction(() => {
      this.data.prepare(`INSERT INTO taxonomy_terms (id, path, label, scope_note, alt_labels, status, former_paths, replaced_by, created_at, created_by, updated_at, updated_by)
        VALUES (@id, @path, @label, @scope_note, @alt_labels, @status, @former_paths, @replaced_by, @created_at, @created_by, @updated_at, @updated_by)`)
        .run({ ...term, alt_labels: JSON.stringify(term.alt_labels), former_paths: "[]" });
      this.log("added", term.id, path, { label, status: term.status }, actor);
    })();
    return term;
  }

  /** Label, scope note, and alternative labels; the id and path stay. */
  edit(id: string, args: { label?: string; scopeNote?: string | null; altLabels?: string[] }, actor: string | null): OverlayTerm {
    const term = this.active(id);
    const next = {
      label: args.label === undefined ? term.label : cleanLabel(args.label),
      scope_note: args.scopeNote === undefined ? term.scope_note : args.scopeNote?.trim() || null,
      alt_labels: args.altLabels === undefined ? term.alt_labels : cleanAltLabels(args.altLabels),
    };
    this.data.transaction(() => {
      this.update(id, { ...next, alt_labels: JSON.stringify(next.alt_labels) }, actor);
      if (next.label !== term.label) this.log("relabeled", id, term.path, { from: term.label, to: next.label }, actor);
      if (next.scope_note !== term.scope_note || JSON.stringify(next.alt_labels) !== JSON.stringify(term.alt_labels)) {
        this.log("scope_changed", id, term.path, { scope_note: next.scope_note, alt_labels: next.alt_labels }, actor);
      }
    })();
    return this.get(id)!;
  }

  /** A person's judgement that a provisional term should stay. */
  confirm(id: string, actor: string | null): OverlayTerm {
    const term = this.active(id);
    if (term.status === "confirmed") return term;
    this.data.transaction(() => {
      this.update(id, { status: "confirmed" }, actor);
      this.log("confirmed", id, term.path, null, actor);
    })();
    return this.get(id)!;
  }

  /**
   * A new path (another parent, another segment, or both), checked by the caller. The old path is kept,
   * so the merged vocabulary retires it with the new one as its single replacement and the tags job
   * re-tags books automatically.
   */
  move(id: string, to: string, actor: string | null): OverlayTerm {
    const term = this.active(id);
    if (to === term.path) return term;
    if (this.atPath(to)) throw new Error(`The overlay already has "${to}".`);
    if (this.children(term.path).length) throw new Error(`"${term.path}" has overlay terms below it; move or retire those first.`);
    this.data.transaction(() => {
      this.update(id, { path: to, former_paths: JSON.stringify([...term.former_paths, term.path]) }, actor);
      this.log("moved", id, to, { from: term.path, to }, actor);
    })();
    return this.get(id)!;
  }

  /** Withdrawn, optionally in favour of another path (books tagged with it are then re-tagged). */
  retire(id: string, replacedBy: string | null, actor: string | null): OverlayTerm {
    const term = this.active(id);
    if (this.children(term.path).length) throw new Error(`"${term.path}" has overlay terms below it; move or retire those first.`);
    if (replacedBy === term.path) throw new Error("A term cannot replace itself.");
    this.data.transaction(() => {
      this.update(id, { status: "retired", replaced_by: replacedBy }, actor);
      this.log("retired", id, term.path, { replaced_by: replacedBy }, actor);
    })();
    return this.get(id)!;
  }

  /**
   * Marks active terms superseded when the supplied vocabulary now has their path: its term wins, and
   * books keep their tag. Returns the terms that changed.
   */
  supersede(basePaths: Set<string>, actor: string | null): OverlayTerm[] {
    const changed = this.list(ACTIVE).filter((t) => basePaths.has(t.path));
    if (!changed.length) return [];
    this.data.transaction(() => {
      for (const t of changed) {
        this.update(t.id, { status: "superseded" }, actor);
        this.log("superseded", t.id, t.path, null, actor);
      }
    })();
    return changed;
  }

  /** Records a vocabulary installed through the intake. */
  baseInstalled(version: string | null, terms: number, actor: string | null): void {
    this.log("base_installed", null, null, { version, terms }, actor);
  }

  lastBaseInstall(): TaxonomyEvent | undefined {
    return this.data.prepare("SELECT * FROM taxonomy_events WHERE kind = 'base_installed' ORDER BY id DESC LIMIT 1").get() as TaxonomyEvent | undefined;
  }

  private children(path: string): OverlayTerm[] {
    return this.list(ACTIVE).filter((t) => t.path.startsWith(`${path}.`));
  }

  private active(id: string): OverlayTerm {
    const term = this.get(id);
    if (!term) throw new Error(`No overlay term "${id}".`);
    if (!ACTIVE.includes(term.status)) throw new Error(`"${term.path}" is ${term.status}; only provisional and confirmed terms change.`);
    return term;
  }

  private update(id: string, fields: Record<string, string | null>, actor: string | null): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(", ");
    this.data.prepare(`UPDATE taxonomy_terms SET ${sets}, updated_at = @updated_at, updated_by = @updated_by WHERE id = @id`)
      .run({ ...fields, id, updated_at: new Date().toISOString(), updated_by: actor });
  }

  private log(kind: EventKind, termId: string | null, path: string | null, detail: unknown, actor: string | null): void {
    this.data.prepare("INSERT INTO taxonomy_events (at, kind, term_id, path, detail, actor) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), kind, termId, path, detail === null ? null : JSON.stringify(detail), actor);
  }
}

function cleanLabel(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("A term needs a label.");
  if (/[.›]/.test(clean)) throw new Error(`The label "${clean}" contains "." or "›".`);
  return clean;
}

function cleanAltLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean))];
}
