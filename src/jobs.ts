import { spawn } from "node:child_process";
import fs from "node:fs";
import type { AdminConfig, Config } from "./config.js";
import { type Change, backupDataStore, recordChanges } from "./data.js";
import { tagPlan } from "./tagging.js";
import { type Corpus, ToolError, tagCleanupPlan } from "./tools.js";

/**
 * Admin jobs launched from /admin: one at a time, logged to data.db, and for anything that changes
 * Calibre, a preview first whose plan the apply reuses verbatim. Calibre changes run on the Calibre-Web
 * host as named commands of the sync key's forced command (deploy/corpus-source.sh), never as a shell.
 */

export type JobKind = "refresh" | "backup" | "tags" | "cleanup" | "convert";
export type JobMode = "preview" | "apply";

interface JobSpec { title: string; calibre: boolean; previewable: boolean }

export const JOB_KINDS: Record<JobKind, JobSpec> = {
  refresh: { title: "Refresh now (pull from Calibre-Web, then index)", calibre: false, previewable: false },
  backup: { title: "Back up data.db", calibre: false, previewable: false },
  tags: { title: "Apply approved tags to Calibre", calibre: true, previewable: true },
  cleanup: { title: "Remove non-subject tags from Calibre", calibre: true, previewable: true },
  convert: { title: "Add EPUBs for MOBI/AZW3-only books", calibre: true, previewable: true },
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
  added?: string[]; removed?: string[]; added_format?: string; source_format?: string;
}

const MAX_LOG = 256 * 1024;

/** The processes jobs run; tests replace them. */
export interface JobCommands {
  /** Starts the refresh unit and streams its log until it finishes; rejects if it fails. */
  refresh(log: (text: string) => void): Promise<void>;
  /** Runs a named command on the Calibre-Web host with optional stdin; rejects on a non-zero exit. */
  calibre(command: string, stdin: string | undefined, log: (text: string) => void): Promise<void>;
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
    return { ...row, params: JSON.parse(row.params) as Record<string, unknown>, items: row.items ? (JSON.parse(row.items) as JobItem[]) : [] };
  }

  /** Starts a job and returns its id at once; the job runs in the background. */
  start(kind: JobKind, mode: JobMode, opts: { previewOf?: number; also?: string[]; books?: string[] } = {}, requestedBy?: string): number {
    const spec = JOB_KINDS[kind];
    if (!spec) throw new ToolError(`Unknown job "${kind}".`);
    if (mode === "preview" && !spec.previewable) throw new ToolError(`"${kind}" has no preview.`);
    if (this.running !== null) throw new ToolError(`Job ${this.running} is still running.`);

    let params: Record<string, unknown> = {};
    if (spec.calibre && mode === "apply") {
      // An apply runs exactly what its preview listed, and only a recent, successful preview.
      if (!opts.previewOf) throw new ToolError("Preview first, then apply that preview.");
      const preview = this.get(opts.previewOf);
      if (preview.kind !== kind || preview.mode !== "preview" || preview.status !== "succeeded") {
        throw new ToolError(`Job ${opts.previewOf} is not a successful ${kind} preview.`);
      }
      if (Date.now() - Date.parse(preview.created_at) > 3600 * 1000) throw new ToolError("That preview is over an hour old; preview again.");
      params = preview.params;
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
    void this.execute(id, kind, mode, params).finally(() => {
      this.running = null;
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
      case "backup":
        log(`Backed up to ${await backupDataStore(this.c.data, this.config.backupDir)}\n`);
        return;
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
    }
  }
}
