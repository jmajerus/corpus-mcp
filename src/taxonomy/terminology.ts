import type { DataStore } from "../data.js";
import { ToolError } from "../tools.js";
import { VOCABULARY_FORMAT, type VocabularyFile, type VocabularySource, type VocabularyTerm } from "../vocabulary.js";

/**
 * terminology-mcp's `cc-subjects` scheme, followed as corpus-mcp's tag vocabulary (PLAN.md, "Living
 * taxonomy", stage 3; terminology-mcp's docs/following-changes.md). The follower bootstraps from
 * /api/state, then applies /api/changes from its cursor, and installs the vocabulary it builds through
 * the VocabularySource, so tagging, the report, and the tags job read it as they read any vocabulary.
 *
 * A Calibre tag is the term's slug chain along `broader` ("earth-environment.geography.hydrology"), never
 * terminology-mcp's `path`, which is built from labels. A change that alters a tag retires the old one:
 * with one replacement the tags job re-tags books; a split, or a retire with none, waits for a person on
 * the vocabulary report. Nothing is held: the cursor always moves on.
 */

export const SCHEME = "cc-subjects";
export const SUBSCRIBER = "corpus-mcp";

export interface TerminologyConfig {
  url: string;
  intervalSeconds: number;
}

/** A term as terminology-mcp serves it, the fields this follower uses. */
export interface TerminologyTerm {
  id: string; scheme: string; slug: string; label: string; status: string; broader: string[];
  scopeNote?: string; altLabels?: string[]; formerSlugs?: string[]; replacedBy?: string[];
}

interface Change {
  n: number; kind: string; after?: TerminologyTerm | null; afterTerms?: TerminologyTerm[];
}

const SCHEMA = `
-- terminology-mcp's cc-subjects terms, as last applied: the source of the vocabulary file.
CREATE TABLE IF NOT EXISTS terminology_terms (
  id TEXT PRIMARY KEY,
  record TEXT NOT NULL              -- JSON: the term as terminology-mcp served it
);
-- Tags a change took away, and what replaces each (one: re-tagged automatically; several or none: a person decides).
CREATE TABLE IF NOT EXISTS terminology_retired (
  tag TEXT PRIMARY KEY,
  replaced_by TEXT NOT NULL,        -- JSON array of term ids
  at TEXT NOT NULL
);`;

/** Each live term's Calibre tag: its slug chain. A term whose chain is broken (a retired or missing parent) has none. */
export function tagsOf(terms: Iterable<TerminologyTerm>): Map<string, string> {
  const byId = new Map([...terms].map((t) => [t.id, t]));
  const tags = new Map<string, string>();
  const tagOf = (t: TerminologyTerm, seen: Set<string>): string | undefined => {
    if (tags.has(t.id)) return tags.get(t.id);
    if (t.status === "retired" || seen.has(t.id)) return undefined;
    seen.add(t.id);
    const parent = t.broader[0] ? byId.get(t.broader[0]) : undefined;
    if (t.broader[0] && !parent) return undefined;
    const above = parent ? tagOf(parent, seen) : "";
    if (above === undefined) return undefined;
    const tag = above ? `${above}.${t.slug}` : t.slug;
    tags.set(t.id, tag);
    return tag;
  };
  for (const t of byId.values()) tagOf(t, new Set());
  return tags;
}

/**
 * The tags each term had under its former slugs (and its ancestors'), for a first bootstrap: those are
 * the old tags terminology-mcp itself records, so they retire in favour of the term.
 */
function formerTags(terms: TerminologyTerm[], tags: Map<string, string>): Map<string, string> {
  const byId = new Map(terms.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const t of terms) {
    if (!tags.has(t.id)) continue;
    let variants = [""];
    const chain: TerminologyTerm[] = [];
    for (let x: TerminologyTerm | undefined = t; x; x = x.broader[0] ? byId.get(x.broader[0]) : undefined) chain.unshift(x);
    for (const x of chain) variants = variants.flatMap((v) => [x.slug, ...(x.formerSlugs ?? [])].map((s) => (v ? `${v}.${s}` : s)));
    for (const v of variants) if (v !== tags.get(t.id)) out.set(v, t.id);
  }
  return out;
}

/** A short, stable fingerprint, so the vocabulary's version changes exactly when its content does. */
function fnv(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of text) h = BigInt.asUintN(64, (h ^ BigInt(ch.codePointAt(0)!)) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0");
}

/**
 * The vocabulary file for a set of terms and retired tags. Domains (top terms) group, and are not
 * assignable. A retired tag's replacements are resolved to live tags; one that is live again is dropped.
 */
export function buildVocabulary(terms: TerminologyTerm[], retired: Map<string, string[]>): VocabularyFile {
  const tags = tagsOf(terms);
  const out: VocabularyTerm[] = [];
  for (const t of terms) {
    const tag = tags.get(t.id);
    if (!tag) continue;
    const parent = t.broader[0] ? tags.get(t.broader[0])! : null;
    out.push({
      id: tag, label: t.label.trim(), parent, ...(parent ? {} : { assignable: false }),
      ...(t.scopeNote?.trim() ? { scopeNote: t.scopeNote.trim() } : {}), ...(t.status === "provisional" ? { status: "provisional" as const } : {}),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  const live = new Set(out.map((t) => t.id));
  const byId = new Map(terms.map((t) => [t.id, t]));
  // A replacement that was itself retired leads on to its own replacements.
  const resolve = (id: string, seen = new Set<string>()): string[] => {
    if (tags.has(id)) return [tags.get(id)!];
    const t = byId.get(id);
    if (!t || seen.has(id)) return [];
    seen.add(id);
    return [...new Set((t.replacedBy ?? []).flatMap((r) => resolve(r, seen)))];
  };
  const gone = [...retired]
    .filter(([tag]) => !live.has(tag))
    .map(([id, replacedBy]) => ({ id, replacedBy: [...new Set(replacedBy.flatMap((r) => resolve(r)))].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const body = { terms: out, retired: gone };
  return { format: VOCABULARY_FORMAT, version: `terminology:${fnv(JSON.stringify(body))}`, generatedAt: new Date().toISOString(), ...body };
}

export class TerminologyError extends Error {
  constructor(readonly status: number, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

async function call(base: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new TerminologyError(502, `terminology-mcp can't be reached (${(error as Error).message}).`);
  }
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const { error, ...details } = answer;
    throw new TerminologyError(res.status, typeof error === "string" ? error : `terminology-mcp answered ${res.status} for ${path}.`, details);
  }
  return answer;
}

export interface FollowStatus {
  url: string; log: string | null; through: number | null; synced_at: string | null; error: string | null;
  reported_at: string | null; terms: number; retired: number; every_seconds: number;
}

/** Follows cc-subjects into the vocabulary file. One tick at a time; a tick during a tick joins it. */
export class TerminologyFollower {
  private current: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reported: { through: number; at: number } | null = null;

  constructor(private readonly data: DataStore, private readonly source: VocabularySource, readonly config: TerminologyConfig) {
    data.exec(SCHEMA);
  }

  sync(): Promise<void> {
    if (!this.current) this.current = this.tick().finally(() => { this.current = null; });
    return this.current;
  }

  /** Syncs now and every intervalSeconds; failures are kept in the status, not thrown. */
  start(): void {
    const tick = () => this.sync().catch((error) => console.error(`terminology: ${(error as Error).message}`));
    void tick();
    this.timer = setInterval(tick, this.config.intervalSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The stored terms' tags and ids, for resolving a proposal's parent. */
  termIdForTag(tag: string): string | undefined {
    for (const [id, t] of tagsOf(this.terms())) if (t === tag) return id;
    return undefined;
  }

  status(): FollowStatus {
    return {
      url: this.config.url, log: this.meta("terminology_log"), through: Number(this.meta("terminology_through") ?? "") || null,
      synced_at: this.meta("terminology_synced_at"), error: this.meta("terminology_error"), reported_at: this.meta("terminology_reported_at"),
      terms: this.data.prepare("SELECT COUNT(*) FROM terminology_terms").pluck().get() as number,
      retired: this.data.prepare("SELECT COUNT(*) FROM terminology_retired").pluck().get() as number,
      every_seconds: this.config.intervalSeconds,
    };
  }

  private async tick(): Promise<void> {
    try {
      const log = this.meta("terminology_log");
      const through = Number(this.meta("terminology_through") ?? 0);
      let reset = false;
      if (!log) await this.bootstrap();
      else {
        const answer = await call(this.config.url, "GET", `/api/changes?since=${through}&scheme=${SCHEME}`);
        if (answer.log !== log) {
          // The store was rebuilt: its numbers mean another history, so start over from its state.
          await this.bootstrap();
          reset = true;
        } else this.apply(answer.changes as Change[], Number(answer.version));
      }
      this.install();
      this.setMeta("terminology_synced_at", new Date().toISOString());
      this.setMeta("terminology_error", null);
      await this.report(reset);
    } catch (error) {
      this.setMeta("terminology_error", `${new Date().toISOString()} ${(error as Error).message}`);
      throw error;
    }
  }

  private async bootstrap(): Promise<void> {
    const state = await call(this.config.url, "GET", `/api/state?scheme=${SCHEME}`);
    const terms = (state.terms as TerminologyTerm[]).filter((t) => t.scheme === SCHEME);
    const before = tagsOf(this.terms());
    const now = new Date().toISOString();
    this.data.transaction(() => {
      this.data.prepare("DELETE FROM terminology_terms").run();
      const put = this.data.prepare("INSERT INTO terminology_terms (id, record) VALUES (?, ?)");
      for (const t of terms) put.run(t.id, JSON.stringify(t));
      const tags = tagsOf(terms);
      // Old tags terminology-mcp records (former slugs, retired terms), and on a rebuild, tags of terms that kept their id.
      const retire = this.data.prepare("INSERT OR IGNORE INTO terminology_retired (tag, replaced_by, at) VALUES (?, ?, ?)");
      for (const [tag, id] of formerTags(terms, tags)) retire.run(tag, JSON.stringify([id]), now);
      for (const t of terms) {
        if (t.status !== "retired") continue;
        const tag = before.get(t.id);
        if (tag) retire.run(tag, JSON.stringify(t.replacedBy ?? []), now);
      }
      for (const [id, tag] of before) if (tags.has(id) && tags.get(id) !== tag) retire.run(tag, JSON.stringify([id]), now);
      this.setMeta("terminology_log", String(state.log));
      this.setMeta("terminology_through", String(state.version));
    })();
  }

  /** Applies changes in order: each touched term is replaced by its snapshot, and tags that changed retire. */
  private apply(changes: Change[], version: number): void {
    const now = new Date().toISOString();
    this.data.transaction(() => {
      const before = tagsOf(this.terms());
      const put = this.data.prepare("INSERT OR REPLACE INTO terminology_terms (id, record) VALUES (?, ?)");
      for (const change of changes) {
        const snapshots = change.afterTerms ?? (change.after && "id" in change.after ? [change.after] : []);
        for (const t of snapshots) if (t.scheme === SCHEME) put.run(t.id, JSON.stringify(t));
      }
      const terms = this.terms();
      const after = tagsOf(terms);
      const byId = new Map(terms.map((t) => [t.id, t]));
      const retire = this.data.prepare("INSERT OR REPLACE INTO terminology_retired (tag, replaced_by, at) VALUES (?, ?, ?)");
      for (const [id, tag] of before) {
        const now_ = after.get(id);
        if (now_ === tag) continue;
        retire.run(tag, JSON.stringify(now_ ? [id] : (byId.get(id)?.replacedBy ?? [])), now);
      }
      this.setMeta("terminology_through", String(version));
    })();
  }

  private install(): void {
    const retired = new Map((this.data.prepare("SELECT tag, replaced_by FROM terminology_retired").all() as { tag: string; replaced_by: string }[])
      .map((r) => [r.tag, JSON.parse(r.replaced_by) as string[]]));
    const file = buildVocabulary(this.terms(), retired);
    const result = this.source.install(file);
    if ("problems" in result) throw new Error(`The vocabulary built from terminology-mcp is invalid: ${result.problems.slice(0, 5).join("; ")}`);
  }

  /** Tells terminology-mcp how far corpus-mcp has got: when that changes, and every five minutes as a heartbeat. */
  private async report(reset: boolean): Promise<void> {
    const through = Number(this.meta("terminology_through"));
    if (!reset && this.reported?.through === through && Date.now() - this.reported.at < 5 * 60_000) return;
    try {
      await call(this.config.url, "POST", `/api/subscribers/${SUBSCRIBER}/progress`, {
        log: this.meta("terminology_log"), through, label: "corpus-mcp", schemes: [SCHEME], ...(reset ? { reset: true } : {}),
      });
      this.reported = { through, at: Date.now() };
      this.setMeta("terminology_reported_at", new Date().toISOString());
    } catch (error) {
      // A report that fails changes nothing here; the next tick tries again.
      console.error(`terminology: progress report failed: ${(error as Error).message}`);
    }
  }

  private terms(): TerminologyTerm[] {
    return (this.data.prepare("SELECT record FROM terminology_terms").pluck().all() as string[]).map((r) => JSON.parse(r) as TerminologyTerm);
  }

  private meta(key: string): string | null {
    return (this.data.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined) ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.data.prepare("DELETE FROM meta WHERE key = ?").run(key);
    else this.data.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }
}

export interface ProposeArgs {
  parent: string; label: string; scope_note: string; slug?: string; alt_labels?: string[];
  source?: string; match?: "closeMatch" | "broadMatch" | "narrowMatch" | "exactMatch" | "relatedMatch"; request_id?: string;
}

/**
 * A new term proposed to terminology-mcp under `parentId`. It is provisional and usable at once; the
 * owner confirms, merges, or retires it there. A refusal (no source, a duplicate, too deep) comes back
 * as a ToolError carrying terminology-mcp's message and details, such as the existing term or a hint.
 */
export async function proposeTerm(url: string, parentId: string, args: ProposeArgs, proposer: string) {
  try {
    return await call(url, "POST", "/api/proposals", {
      scheme: SCHEME, broader: parentId, label: args.label, scopeNote: args.scope_note,
      ...(args.slug ? { slug: args.slug } : {}), ...(args.alt_labels?.length ? { altLabels: args.alt_labels } : {}),
      ...(args.source ? { source: args.source, match: args.match ?? "closeMatch" } : {}),
      ...(args.request_id ? { requestId: args.request_id } : {}), proposer,
    });
  } catch (error) {
    if (!(error instanceof TerminologyError)) throw error;
    const details = Object.keys(error.details).length ? ` ${JSON.stringify(error.details)}` : "";
    throw new ToolError(`terminology-mcp refused the proposal (${error.status}): ${error.message}${details}`);
  }
}
