import { spawn } from "node:child_process";
import fs from "node:fs";
import type { AdminConfig, Config } from "./config.js";
import { type Change, backupDataStore, pinnedByUuid, recordChanges } from "./data.js";
import { metadataRepairPlan, type MetadataCorrection, type MetadataValues } from "./metadata-repair.js";
import { duplicateBatchPlan, assertDuplicateUnreferenced, type DuplicateBatchPlan, type DuplicateGroupSelection } from "./duplicates.js";
import { assertNoBookQuotes } from "./quoteMcp.js";
import { tagPlan } from "./tagging.js";
import { type Corpus, getBook, ToolError, tagCleanupPlan } from "./tools.js";

/**
 * Admin jobs launched from /admin: one at a time, logged to data.db, and for anything that changes
 * Calibre, a preview first whose plan the apply reuses verbatim. Metadata corrections
 * are reviewed in their editable form and run that preview and apply within one job. Calibre changes run on the Calibre-Web
 * host as named commands of the sync key's forced command (deploy/corpus-source.sh), never as a shell.
 */

export type JobKind = "refresh" | "backup" | "tags" | "cleanup" | "convert" | "zotero" | "metadata" | "duplicates";
export type JobMode = "preview" | "apply";

interface JobSpec { title: string; calibre: boolean; previewable: boolean }

export const JOB_KINDS: Record<JobKind, JobSpec> = {
  duplicates: { title: "Resolve reviewed duplicate groups", calibre: true, previewable: true },
  metadata: { title: "Correct title, authors, and year in Calibre", calibre: true, previewable: false },
  refresh: { title: "Refresh now (pull from Calibre-Web, then index)", calibre: false, previewable: false },
  backup: { title: "Back up data.db", calibre: false, previewable: false },
  tags: { title: "Apply approved tags to Calibre", calibre: true, previewable: true },
  cleanup: { title: "Remove non-subject tags from Calibre", calibre: true, previewable: true },
  convert: { title: "Add EPUBs for MOBI/AZW3/KFX-only books", calibre: true, previewable: true },
  zotero: { title: "Sync from Zotero now", calibre: false, previewable: false },
};

export interface JobRow {
  id: number; kind: JobKind; mode: JobMode; params: string; status: "running" | "succeeded" | "failed" | "interrupted";
  requested_by: string | null; preview_of: number | null; created_at: string; finished_at: string | null; log: string;
  items: string | null;
}

/**
 * One book's change, as the Calibre scripts print it on an "@@change {json}" line: tags added and
 * removed, or a format added. A preview's items are what would change; an apply's, what did.
 */
export interface JobItem {
  calibre_id: number; uuid?: string; title: string;
  metadata?: { before: MetadataValues; after: MetadataValues; partial?: boolean };
  duplicate_review?: { plan: DuplicateBatchPlan["groups"][number] & { reviewed?: string }; blockers:string[]; [key:string]: unknown };
  duplicate_skipped?: { message: string };
  duplicate_partial?: {backup:string;message:string};
  duplicate_resolved?: { removed_id:number; removed_uuid:string; backup:string; trash:boolean };
  added?: string[]; removed?: string[]; added_format?: string; source_format?: string;
}

const MAX_LOG = 256 * 1024;

/** The processes jobs run; tests replace them. */
export interface JobCommands {
  /** Starts the refresh unit and streams its log until it finishes; rejects if it fails. */
  refresh(log: (text: string) => void): Promise<void>;
  /** Runs a named command on the Calibre-Web host with optional stdin; rejects on a non-zero exit. */
  calibre(command: string, stdin: string | undefined, log: (text: string) => void): Promise<void>;
  /** Syncs the Zotero mirror; absent when Zotero is not configured. */
  zotero?(log: (text: string) => void): Promise<void>;
}

function run(cmd: string, args: string[], log: (text: string) => void, stdin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (d) => log(String(d)));
    child.stderr.on("data", (d) => log(String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.end(stdin ?? "");
  });
}

async function capture(cmd: string, args: string[]): Promise<string> {
  let out = "";
  await run(cmd, args, (t) => (out += t));
  return out.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function systemCommands(admin: AdminConfig): JobCommands {
  return {
    async refresh(log) {
      // Starting the unit is allowed to the service user by a polkit rule (deploy/provision.sh), so the
      // pull and index keep their own systemd sandbox, and a run already started by the timer is joined.
      let offset = fs.existsSync(admin.refreshLog) ? fs.statSync(admin.refreshLog).size : 0;
      const code = await run("systemctl", ["start", "--no-block", admin.refreshUnit], log);
      if (code !== 0) throw new Error(`systemctl start ${admin.refreshUnit} exited with ${code}`);
      const readNew = () => {
        if (!fs.existsSync(admin.refreshLog)) return;
        const size = fs.statSync(admin.refreshLog).size;
        if (size < offset) offset = 0; // rotated
        if (size === offset) return;
        const fd = fs.openSync(admin.refreshLog, "r");
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        fs.closeSync(fd);
        offset = size;
        log(buffer.toString("utf8"));
      };
      const deadline = Date.now() + 3 * 3600 * 1000;
      await sleep(1000);
      while (Date.now() < deadline) {
        readNew();
        const state = await capture("systemctl", ["is-active", admin.refreshUnit]);
        if (state !== "activating" && state !== "active") break;
        await sleep(1500);
      }
      readNew();
      const result = await capture("systemctl", ["show", "-p", "Result", "--value", admin.refreshUnit]);
      if (result !== "success") throw new Error(`${admin.refreshUnit} finished with result "${result}"`);
    },
    async calibre(command, stdin, log) {
      const code = await run("ssh", [
        "-i", admin.sshKey, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", admin.source, command,
      ], log, stdin);
      if (code !== 0) throw new Error(`${command} on the Calibre-Web host exited with ${code}`);
    },
  };
}

export class JobRunner {
  private running: number | null = null;

  constructor(private readonly c: Corpus, private readonly config: Config, private readonly commands: JobCommands) {
    // A job cannot survive a server restart.
    c.data.prepare("UPDATE jobs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(new Date().toISOString());
  }

  list(limit = 30) {
    const rows = this.c.data.prepare("SELECT id, kind, mode, status, requested_by, preview_of, created_at, finished_at FROM jobs ORDER BY id DESC LIMIT ?")
      .all(limit);
    return { running: this.running, jobs: rows };
  }

  get(id: number) {
    const row = this.c.data.prepare<[number], JobRow>("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!row) throw new ToolError(`No job ${id}.`);
    return { ...row, calibre_web_url: this.config.admin?.calibreWebUrl ?? null, params: JSON.parse(row.params) as Record<string, unknown>, items: row.items ? (JSON.parse(row.items) as JobItem[]) : [] };
  }

  /** Starts a job and returns its id at once; the job runs in the background. */
  start(kind: JobKind, mode: JobMode, opts: { previewOf?: number; also?: string[]; books?: string[]; metadata?: MetadataCorrection; duplicates?: DuplicateGroupSelection[] } = {}, requestedBy?: string): number {
    if (mode !== "preview" && mode !== "apply") throw new ToolError("Choose preview or apply.");
    const spec = JOB_KINDS[kind];
    if (!spec) throw new ToolError(`Unknown job "${kind}".`);
    if (mode === "preview" && !spec.previewable) throw new ToolError(`"${kind}" has no preview.`);
    if (this.running !== null) throw new ToolError(`Job ${this.running} is still running.`);

    let params: Record<string, unknown> = {};
    if (kind === "metadata") {
      if (mode !== "apply" || !opts.metadata) throw new ToolError("Review the title, authors, and year on the book page first.");
      params = { plan: metadataRepairPlan(this.c, this.config.shelvesLibrary, opts.metadata) };
    } else if (spec.calibre && mode === "apply") {
      // An apply runs exactly what its preview listed, and only a recent, successful preview.
      if (!opts.previewOf) throw new ToolError("Preview first, then apply that preview.");
      const preview = this.get(opts.previewOf);
      if (preview.kind !== kind || preview.mode !== "preview" || preview.status !== "succeeded") {
        throw new ToolError(`Job ${opts.previewOf} is not a successful ${kind} preview.`);
      }
      if (Date.now() - Date.parse(preview.created_at) > 3600 * 1000) throw new ToolError("That preview is over an hour old; preview again.");
      params = preview.params;
      if (kind === "duplicates") {
        // Apply the groups the source reviewed without blockers; blocked groups stay as they are.
        const groups = preview.items.flatMap(it => it.duplicate_review && !it.duplicate_review.blockers.length && it.duplicate_review.plan.reviewed ? [it.duplicate_review.plan] : []);
        if (!groups.length) throw new ToolError("Every group in that preview has blockers. Resolve them and preview again.");
        for (const g of groups) for (const r of g.remove) assertDuplicateUnreferenced(this.c, r.uuid, `Duplicate ${r.id}`);
        params = { plan: { library: (preview.params.plan as DuplicateBatchPlan).library, groups } };
      }
    } else if (kind === "duplicates" && mode === "preview") {
      if (!opts.duplicates?.length) throw new ToolError("Choose a keeper on the duplicate review screen.");
      params = { plan: duplicateBatchPlan(this.c, this.config.shelvesLibrary, opts.duplicates) };
    } else if (mode === "preview" && (kind === "tags" || kind === "cleanup")) {
      const library = this.config.shelvesLibrary;
      // A book page previews just that book (`books`); the dashboard previews every approved book.
      params = { plan: kind === "tags" ? tagPlan(this.c, library, opts.books) : tagCleanupPlan(this.c, library, opts.also ?? []), ...(opts.books ? { books: opts.books } : {}) };
    }

    const id = Number(this.c.data.prepare(`
      INSERT INTO jobs (kind, mode, params, status, requested_by, preview_of, created_at, log)
      VALUES (?, ?, ?, 'running', ?, ?, ?, '')`)
      .run(kind, mode, JSON.stringify(params), requestedBy ?? null, opts.previewOf ?? null, new Date().toISOString()).lastInsertRowid);
    this.running = id;
    if (kind === "duplicates" && mode === "apply") this.c.writesPaused = "Duplicate resolution is running. Try again after its refresh finishes.";
    void this.execute(id, kind, mode, params).finally(() => {
      this.running = null;
      this.c.writesPaused = undefined;
    });
    return id;
  }

  private async execute(id: number, kind: JobKind, mode: JobMode, params: Record<string, unknown>): Promise<void> {
    let log = "";
    let partial = "";
    const items: JobItem[] = [];
    let dirty = false;
    // Output arrives in arbitrary chunks; "@@change" lines become items, everything else is the log.
    const append = (text: string) => {
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("@@change ")) {
          try {
            items.push(JSON.parse(line.slice("@@change ".length)) as JobItem);
          } catch {
            log += `${line}\n`;
          }
        } else log += `${line}\n`;
      }
      if (log.length > MAX_LOG) log = `[earlier output trimmed]\n${log.slice(-MAX_LOG)}`;
      dirty = true;
    };
    const save = this.c.data.prepare("UPDATE jobs SET log = ?, items = ? WHERE id = ?");
    const flusher = setInterval(() => {
      if (dirty) {
        save.run(log, JSON.stringify(items), id);
        dirty = false;
      }
    }, 1000);
    let status: "succeeded" | "failed" = "succeeded";
    let recorded = false;
    // An apply's items are changes made in Calibre: log them before the follow-up refresh, which then
    // recognizes them instead of logging them a second time, and log them even if the apply failed
    // partway (the scripts carry on past a failed book, and items are only the books that changed).
    const record = () => {
      if (mode === "apply" && !recorded) {
        recorded = true;
        this.recordItems(id, items);
      }
    };
    try {
      await this.perform(kind, mode, params, append, record);
    } catch (error) {
      append(`\n${(error as Error).message}\n`);
      status = "failed";
    } finally {
      clearInterval(flusher);
      if (partial) append("\n");
      record();
      this.c.data.prepare("UPDATE jobs SET log = ?, items = ?, status = ?, finished_at = ? WHERE id = ?")
        .run(log, JSON.stringify(items), status, new Date().toISOString(), id);
    }
  }

  private recordItems(jobId: number, items: JobItem[]): void {
    const actor = this.c.data.prepare("SELECT requested_by FROM jobs WHERE id = ?").pluck().get(jobId) as string | null;
    const library = this.config.shelvesLibrary;
    const changes: Change[] = [];
    for (const item of items) {
      const base = { source: "admin-job" as const, job_id: jobId, book_id: `${library}:${item.calibre_id}`, calibre_uuid: item.uuid ?? null, title: item.title, actor };
      for (const tag of item.added ?? []) changes.push({ ...base, kind: "tag_added", detail: tag });
      for (const tag of item.removed ?? []) changes.push({ ...base, kind: "tag_removed", detail: tag });
      if (item.duplicate_partial) changes.push({ ...base, kind: "duplicate_resolution_failed", detail: JSON.stringify(item.duplicate_partial) });
      if (item.duplicate_resolved) changes.push({ ...base, kind: "duplicate_resolved", detail: JSON.stringify(item.duplicate_resolved) });
      if (item.metadata) changes.push({ ...base, kind: "metadata_corrected", detail: JSON.stringify(item.metadata) });
      if (item.added_format) changes.push({ ...base, kind: "format_added", detail: `${item.source_format} → ${item.added_format}` });
    }
    recordChanges(this.c.data, changes);
  }

  private async perform(kind: JobKind, mode: JobMode, params: Record<string, unknown>, log: (text: string) => void,
    applied: () => void): Promise<void> {
    const plan = params.plan as { books: unknown[] } | undefined;
    switch (kind) {
      case "refresh":
        return this.commands.refresh(log);
      case "zotero":
        if (!this.commands.zotero) throw new ToolError("Zotero is not configured (CORPUS_ZOTERO_LIBRARY, and CORPUS_ZOTERO_API_KEY for zotero.org).");
        return this.commands.zotero(log);
      case "backup":
        log(`Backed up to ${await backupDataStore(this.c.data, this.config.backupDir)}\n`);
        return;
      case "duplicates": {
        const removes = (params.plan as DuplicateBatchPlan).groups.flatMap(g => g.remove);
        for (const r of removes) assertDuplicateUnreferenced(this.c, r.uuid, `Duplicate ${r.id}`);
        if (this.config.admin?.quoteMcpUrl) for (const r of removes) await assertNoBookQuotes(this.config.admin.quoteMcpUrl, r.uuid);
        try { await this.commands.calibre(mode === "apply" ? "duplicates-apply" : "duplicates-preview", JSON.stringify(params.plan), log); }
        catch (error) {
          if (mode === "apply") {
            applied();
            try { await this.commands.refresh(log); } catch (refreshError) { log(`Refresh also failed: ${String(refreshError)}\n`); }
          }
          throw error;
        }
        break;
      }
      case "metadata":
        if (!plan?.books.length) throw new ToolError("No metadata correction to apply.");
        // The editable form is the user's review. Check and apply the same immutable plan in one job.
        await this.commands.calibre("metadata-preview", JSON.stringify(plan), log);
        try {
          await this.commands.calibre("metadata-apply", JSON.stringify(plan), log);
        } catch (error) {
          applied(); // The source reports actual partial changes before its non-zero exit.
          log("\nChecking the index after the failed metadata write…\n");
          try { await this.commands.refresh(log); }
          catch (refreshError) { log(`Refresh also failed: ${(refreshError as Error).message}\n`); }
          throw error;
        }
        break;
      case "tags":
      case "cleanup":
        if (!plan?.books.length) {
          log("Nothing to change.\n");
          return;
        }
        await this.commands.calibre(mode === "apply" ? "tags-apply" : "tags-preview", JSON.stringify(plan), log);
        break;
      case "convert":
        await this.commands.calibre(mode === "apply" ? "convert-apply" : "convert-preview", undefined, log);
        break;
    }
    if (mode === "apply") {
      applied();
      // Show the change in the index right away instead of at the next timer run.
      log("\nRefreshing the index…\n");
      await this.commands.refresh(log);
      if (kind === "metadata") {
        const metadata = params.plan as ReturnType<typeof metadataRepairPlan>;
        const reviewed = metadata.books[0], b = getBook(this.c, `${metadata.library}:${reviewed.calibre_id}`);
        if (b.uuid !== reviewed.uuid || b.title !== reviewed.after.title || b.year !== reviewed.after.year || JSON.stringify((JSON.parse(b.authors) as string[]).map(n=>n.replaceAll("|",","))) !== JSON.stringify(reviewed.after.authors)) throw new ToolError("The refresh has not confirmed the saved correction. Reload the book before using its generated citekey.");
        const blockers = JSON.parse(b.citekey_blockers) as string[];
        log(blockers.length ? `Generated citekey needs review: ${blockers.join(", ")}.\n` : `Generated citekey: ${b.proposed_citekey} — available without pinning.\n`);
        const assigned=b.calibre_citekey ?? pinnedByUuid(this.c.data,b.uuid)?.citekey;
        if (assigned) log(`Existing assigned citekey remains in effect: ${assigned}.\n`);
      }
    }
  }
}
