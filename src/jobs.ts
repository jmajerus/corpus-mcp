import { spawn } from "node:child_process";
import fs from "node:fs";
import type { AdminConfig, Config } from "./config.js";
import { type Change, type SyncBaseline, backupDataStore, pinnedByUuid, recordAlias, recordBaselines, recordChanges } from "./data.js";
import { moveAnchors } from "./anchors.js";
import { JobLogFilter } from "./joblog.js";
import { type CoverFound, type CoverPlan, attachCoverPayloads, previewLibraryCovers } from "./library-covers.js";
import { healthSummary, parseHealthOutput, saveHealthReport } from "./health.js";
import { metadataRepairPlan, type MetadataCorrection, type MetadataValues } from "./metadata-repair.js";
import { duplicateBatchPlan, duplicateContents, assertDuplicateMovable, moveDuplicateFiling, type DuplicateBatchPlan, type DuplicateGroupSelection } from "./duplicates.js";
import { markIntakeApplied, scanIntake } from "./intake.js";
import { attachUploadPayloads, removeAppliedUploads, uploadBatchPlan, type UploadBatchPlan, type UploadItemPlan, type UploadSelection } from "./upload.js";
import { assertBookQuotesMovable } from "./quoteMcp.js";
import { moveTagProposal, tagPlan } from "./tagging.js";
import { type BookRow, type Corpus, getBook, ToolError, tagCleanupPlan } from "./tools.js";

/**
 * Admin jobs launched from /admin: one at a time, logged to data.db, and for anything that changes
 * Calibre, a preview first whose plan the apply reuses verbatim. Metadata corrections
 * are reviewed in their editable form and run that preview and apply within one job. Calibre changes run on the Calibre-Web
 * host as named commands of the sync key's forced command (deploy/corpus-source.sh), never as a shell.
 */

export type JobKind = "refresh" | "backup" | "tags" | "cleanup" | "convert" | "covers" | "zotero" | "metadata" | "duplicates" | "upload" | "intake" | "health";
export type JobMode = "preview" | "apply";

interface JobSpec { title: string; calibre: boolean; previewable: boolean }

export const JOB_KINDS: Record<JobKind, JobSpec> = {
  upload: { title: "Upload books to Calibre", calibre: true, previewable: true },
  intake: { title: "Scan the master ebook directory", calibre: false, previewable: false },
  // Reads the Calibre library on its host; changes nothing, so it needs no preview.
  health: { title: "Check the Calibre library's files", calibre: false, previewable: false },
  duplicates: { title: "Resolve reviewed duplicate groups", calibre: true, previewable: true },
  metadata: { title: "Correct title, authors, and year in Calibre", calibre: true, previewable: false },
  refresh: { title: "Refresh now (pull from Calibre-Web, then index)", calibre: false, previewable: false },
  backup: { title: "Back up data.db", calibre: false, previewable: false },
  tags: { title: "Apply approved tags to Calibre", calibre: true, previewable: true },
  cleanup: { title: "Remove non-subject tags from Calibre", calibre: true, previewable: true },
  convert: { title: "Convert books that have no EPUB or PDF", calibre: true, previewable: true },
  // The preview looks covers up here (src/library-covers.ts); only the apply goes to the Calibre-Web host.
  covers: { title: "Find covers for books with plain title-page covers", calibre: true, previewable: true },
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
  duplicate_resolved?: { removed_id:number; removed_uuid:string; backup:string; trash:boolean; shelves?: { shelf: string; action: string }[] };
  upload_review?: {
    plan: UploadItemPlan & { reviewed?: string };
    action: "add_book" | "add_format";
    filename: string;
    source_format: string;
    convert_to: string | null;
    add_formats: string[];
    target?: { id: number; uuid: string; title: string; formats: string[] } | null;
    blockers: string[];
  };
  upload_skipped?: { filename: string; message: string };
  upload_partial?: { id: string; backup: string; message: string };
  upload_applied?: { id: string; action: "add_book" | "add_format"; formats: string[]; backup: string };
  added?: string[]; removed?: string[];
  /** With added/removed: the book's whole tag list as the tag script wrote it. */
  tags?: string[];
  added_format?: string; source_format?: string; source_sha256?: string;
  /** A book the convert job cannot convert, and why (DRM-encrypted, unrecognized file). */
  convert_skipped?: string;
  /** A cover the covers preview found; cover_set when the apply set it, cover_skipped when it didn't. */
  cover_found?: CoverFound;
  cover_set?: { source: string; label: string; backup: string };
  cover_skipped?: string;
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

export function run(cmd: string, args: string[], log: (text: string) => void, stdin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.stdout.on("data", (d) => log(String(d)));
    child.stderr.on("data", (d) => log(String(d)));
    child.on("error", (error) => finish(() => reject(error)));
    // The command can exit before this write finishes (ssh cannot connect, or it reads
    // nothing). The pipe then fails with EPIPE, and with no listener Node exits the process.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") return;
      finish(() => reject(error));
    });
    child.on("close", (code) => finish(() => resolve(code ?? 1)));
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
  start(kind: JobKind, mode: JobMode, opts: { previewOf?: number; also?: string[]; books?: string[]; metadata?: MetadataCorrection; duplicates?: DuplicateGroupSelection[]; upload?: UploadSelection[] } = {}, requestedBy?: string): number {
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
      if (kind === "convert") {
        // The apply converts exactly the books the preview listed, as listed; the source rechecks each.
        const books = preview.items.filter(it => it.added_format).map(it => ({ calibre_id: it.calibre_id, uuid: it.uuid, source_format: it.source_format, source_sha256: it.source_sha256, added_format: it.added_format }));
        if (!books.length) throw new ToolError("That preview has nothing to convert.");
        params = { plan: { books } };
      }
      if (kind === "duplicates") {
        // Apply the groups the source reviewed without blockers; blocked groups stay as they are.
        if (preview.items.some(it => it.duplicate_review && !Array.isArray(it.duplicate_review.plan.remove))) throw new ToolError("That preview predates batch resolution. Preview again.");
        const groups = preview.items.flatMap(it => it.duplicate_review && !it.duplicate_review.blockers.length && it.duplicate_review.plan.reviewed ? [it.duplicate_review.plan] : []);
        if (!groups.length) throw new ToolError("Every group in that preview has blockers. Resolve them and preview again.");
        const library = (preview.params.plan as DuplicateBatchPlan).library;
        for (const g of groups) assertDuplicateMovable(this.c, library, g);
        params = { plan: { library, groups } };
      }
      if (kind === "covers") {
        const books = preview.items.flatMap(it => it.cover_found && it.uuid ? [{ calibre_id: it.calibre_id, uuid: it.uuid, title: it.title, cover: it.cover_found }] : []);
        if (!books.length) throw new ToolError("That preview found no covers to set.");
        params = { plan: { library: this.config.shelvesLibrary, books } satisfies CoverPlan };
      }
      if (kind === "upload") {
        const items = preview.items.flatMap(it => it.upload_review && !it.upload_review.blockers.length && it.upload_review.plan.reviewed ? [it.upload_review.plan] : []);
        if (!items.length) throw new ToolError("Every file in that preview has blockers. Resolve them and preview again.");
        params = { plan: { library: (preview.params.plan as UploadBatchPlan).library, items } };
      }
    } else if (kind === "duplicates" && mode === "preview") {
      if (!opts.duplicates?.length) throw new ToolError("Choose a keeper on the duplicate review screen.");
      // Only the plan goes to the source; `contents` is for the preview page.
      params = { plan: duplicateBatchPlan(this.c, this.config.shelvesLibrary, opts.duplicates),
        contents: duplicateContents(this.c, this.config.shelvesLibrary, opts.duplicates.map(s => s.keep)) };
    } else if (kind === "upload" && mode === "preview") {
      if (!opts.upload?.length) throw new ToolError("Select at least one staged file to upload.");
      params = { plan: uploadBatchPlan(this.c, this.config, opts.upload) };
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
    if (kind === "intake") {
      this.c.intakePaused = "An intake scan is running. Stage or skip files after it finishes.";
    }
    if ((kind === "duplicates" || kind === "upload") && mode === "apply") {
      this.c.writesPaused = kind === "upload"
        ? "Book upload is running. Try again after its refresh finishes."
        : "Duplicate resolution is running. Try again after its refresh finishes.";
    }
    void this.execute(id, kind, mode, params).finally(() => {
      this.running = null;
      this.c.writesPaused = undefined;
      this.c.intakePaused = undefined;
    });
    return id;
  }

  private async execute(id: number, kind: JobKind, mode: JobMode, params: Record<string, unknown>): Promise<void> {
    let log = "";
    let partial = "";
    const items: JobItem[] = [];
    let dirty = false;
    const filter = new JobLogFilter();
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
        } else {
          const shown = filter.line(line);
          if (shown !== null) log += `${shown}\n`;
        }
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
        if (kind === "upload") {
          removeAppliedUploads(this.config, items.flatMap(it => it.upload_applied?.id ? [it.upload_applied.id] : []));
          markIntakeApplied(this.c.data, this.config.shelvesLibrary, items);
        }
        if (kind === "duplicates") {
          const actor = this.c.data.prepare("SELECT requested_by FROM jobs WHERE id = ?").pluck().get(id) as string | null;
          for (const it of items) {
            if (!it.duplicate_resolved?.trash || !it.uuid) continue;
            const keeper = { uuid: it.uuid, book_id: `${this.config.shelvesLibrary}:${it.calibre_id}`, title: it.title };
            moveTagProposal(this.c.data, it.duplicate_resolved.removed_uuid, keeper, actor, id);
            const removedId = `${this.config.shelvesLibrary}:${it.duplicate_resolved.removed_id}`;
            moveDuplicateFiling(this.c, it.duplicate_resolved.removed_uuid, removedId, keeper, actor, id);
            // Before the refresh drops the trashed record's pages: its quotes are re-anchored from them.
            const keeperRow = this.c.db.prepare<[string], BookRow>("SELECT * FROM books WHERE uuid = ?").get(it.uuid);
            if (keeperRow) {
              const quotes = moveAnchors(this.c, it.duplicate_resolved.removed_uuid, keeperRow);
              if (quotes.moved || quotes.orphaned) recordChanges(this.c.data, [{ kind: "quotes_moved", source: "admin-job", job_id: id, book_id: keeper.book_id,
                calibre_uuid: keeper.uuid, title: keeper.title, actor,
                detail: `${quotes.moved} re-anchored${quotes.orphaned ? `, ${quotes.orphaned} to find again` : ""} from ${removedId}` }]);
            }
            // quote-mcp and anything else that kept the trashed UUID now reaches the keeper.
            recordAlias(this.c.data, { old_uuid: it.duplicate_resolved.removed_uuid, uuid: it.uuid, old_book_id: removedId, reason: "duplicate_merged", job_id: id });
          }
        }
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
      const hidden = filter.summary();
      if (hidden) append(`${hidden}\n`);
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
      if (item.upload_applied?.action === "add_book") {
        changes.push({ ...base, kind: "book_added", detail: item.upload_applied.formats.map(f => f.toLowerCase()).join(" → ") });
      } else if (item.upload_applied?.action === "add_format" && !item.added_format) {
        changes.push({ ...base, kind: "format_added", detail: item.upload_applied.formats.map(f => f.toLowerCase()).join(" → ") });
      }
      if (item.metadata) changes.push({ ...base, kind: "metadata_corrected", detail: JSON.stringify(item.metadata) });
      if (item.added_format) changes.push({ ...base, kind: "format_added", detail: `${item.source_format} → ${item.added_format}` });
      if (item.cover_set) changes.push({ ...base, kind: "cover_set", detail: `${item.cover_set.source === "otl" ? "Open Textbook Library" : item.cover_set.source}: ${item.cover_set.label}` });
    }
    recordChanges(this.c.data, changes);
    recordBaselines(this.c.data, this.baselines(jobId, items));
  }

  /**
   * What an apply just wrote to Calibre, per field, as the values a later sync compares against (PLAN.md,
   * Calibre downstream). Only values the script reports writing: tags from the whole list it set (an event
   * without one, from an older script, records nothing rather than a guess from the index, which may be
   * older than what the script read from Calibre).
   */
  private baselines(jobId: number, items: JobItem[]): SyncBaseline[] {
    const out: SyncBaseline[] = [];
    for (const item of items) {
      if (!item.uuid) continue;
      const base = { calibre_uuid: item.uuid, surface: "calibre" as const, job_id: jobId };
      if (item.metadata && !item.metadata.partial) {
        for (const field of ["title", "authors", "year"] as const) out.push({ ...base, field, value: item.metadata.after[field] });
      }
      if (Array.isArray(item.tags)) out.push({ ...base, field: "tags", value: [...item.tags].sort((a, b) => a.localeCompare(b)) });
    }
    return out;
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
      case "intake":
        await scanIntake(this.c, this.config, log);
        return;
      case "health": {
        // The report is one long JSON line: kept out of the job's log, which gets the summary instead.
        let output = "", pending = "";
        await this.commands.calibre("health", undefined, (text) => {
          pending += text;
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) {
            if (line.startsWith("@@health ")) output += line + "\n";
            else log(line + "\n");
          }
        });
        if (pending.startsWith("@@health ")) output += pending;
        else if (pending) log(pending);
        const report = parseHealthOutput(output);
        if (!report) throw new Error("The Calibre-Web host sent no health report.");
        saveHealthReport(this.c.data, this.running, report);
        log(healthSummary(report) + "\n");
        return;
      }
      case "duplicates": {
        const batch = params.plan as DuplicateBatchPlan, removes = batch.groups.flatMap(g => g.remove);
        for (const g of batch.groups) assertDuplicateMovable(this.c, batch.library, g);
        if (this.config.admin?.quoteMcpUrl) for (const r of removes) await assertBookQuotesMovable(this.config.admin.quoteMcpUrl, r.uuid, this.c.data);
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
      case "covers": {
        if (mode === "preview") { await previewLibraryCovers(this.c, this.config, log); return; }
        const payload = attachCoverPayloads(this.config, params.plan as CoverPlan);
        try { await this.commands.calibre("covers-apply", JSON.stringify(payload), log); }
        catch (error) {
          applied();
          try { await this.commands.refresh(log); } catch (refreshError) { log(`Refresh also failed: ${String(refreshError)}\n`); }
          throw error;
        }
        break;
      }
      case "upload": {
        const payload = attachUploadPayloads(this.config, params.plan as UploadBatchPlan);
        try { await this.commands.calibre(mode === "apply" ? "upload-apply" : "upload-preview", JSON.stringify(payload), log); }
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
        if (mode === "preview") { await this.commands.calibre("convert-preview", undefined, log); break; }
        try { await this.commands.calibre("convert-apply", JSON.stringify(params.plan), log); }
        catch (error) {
          // The script carries on past a failed book: index the ones it did convert.
          applied();
          log("\nRefreshing the index for the books that were converted…\n");
          try { await this.commands.refresh(log); } catch (refreshError) { log(`Refresh also failed: ${(refreshError as Error).message}\n`); }
          throw error;
        }
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
