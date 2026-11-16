import type { DataStore } from "./data.js";
import { duplicatePairs, duplicateReferences } from "./duplicates.js";
import type { Corpus } from "./tools.js";

/**
 * The Library health page (PLAN.md, Library health): what tools/calibre-health.py found when it compared the
 * Calibre library's metadata.db with the folders on disk and Calibre-Web's links. The check runs on the
 * Calibre-Web host through the "health" command and changes nothing; corpus-mcp keeps each report and adds
 * what it knows (book ids, saved references, other copies of a broken record).
 */

export interface HealthFile { file: string; bytes: number; matches: { id: number; format: string }[] }
export interface HealthReport {
  version: number; checked_at: string; library: string; records: number;
  counts: Record<string, number>;
  records_missing: { id: number; uuid: string; title: string; path: string; folder_missing: boolean; formats_missing: string[]; cover_missing: boolean }[];
  orphans: { path: string; id: number; kind: "leftover" | "lost" | "empty"; files: HealthFile[]; bytes: number; cover: boolean;
    record: { title: string; path: string; folder_exists: boolean } | null }[];
  cover_unflagged: { id: number; title: string; path: string }[];
  strays: { path: string; kind: "file" | "folder"; bytes: number }[];
  corpus_backups: { count: number; bytes: number };
  backups: { dir: string; exists: boolean; count: number; bytes: number } | null;
  app_db: { checked: boolean; missing_links: { table: string; book_id: number; count: number }[] };
}

/** Reports kept, newest first: enough to see when something appeared. */
const KEEP = 30;

/** The "@@health {json}" line calibre-health.py prints; null when the output has none. */
export function parseHealthOutput(output: string): HealthReport | null {
  const line = output.split("\n").find((l) => l.startsWith("@@health "));
  if (!line) return null;
  const report = JSON.parse(line.slice("@@health ".length)) as HealthReport;
  if (report.version !== 1 || !Array.isArray(report.records_missing) || !Array.isArray(report.orphans)) throw new Error("The health report is not in a form this server reads.");
  return report;
}

export function saveHealthReport(data: DataStore, jobId: number | null, report: HealthReport): void {
  data.transaction(() => {
    data.prepare("INSERT INTO health_reports (job_id, at, report) VALUES (?, ?, ?)").run(jobId, report.checked_at, JSON.stringify(report));
    data.prepare("DELETE FROM health_reports WHERE id NOT IN (SELECT id FROM health_reports ORDER BY id DESC LIMIT ?)").run(KEEP);
  })();
}

export function latestHealthReport(data: DataStore): { job_id: number | null; at: string; report: HealthReport } | null {
  const row = data.prepare("SELECT job_id, at, report FROM health_reports ORDER BY id DESC LIMIT 1").get() as { job_id: number | null; at: string; report: string } | undefined;
  return row ? { job_id: row.job_id, at: row.at, report: JSON.parse(row.report) as HealthReport } : null;
}

/** A one-line summary for the job's log. */
export function healthSummary(r: HealthReport): string {
  const c = r.counts;
  return `${r.records} records checked. ${c.records_missing} with missing files; ${c.orphans} folders with no record `
    + `(${c.orphans_leftover} leftover, ${c.orphans_lost} lost, ${c.orphans_empty} empty); ${c.cover_unflagged} covers not recorded; `
    + `${c.strays} other items in the library folder; ${c.corpus_backups} corpus-mcp backups in the library folder; `
    + `${c.app_db_missing_links} Calibre-Web links to books that are gone.`;
}

/**
 * The latest report as the page shows it, with corpus-mcp's view added: each Calibre id as a book id, a broken
 * record's saved references (what removing it would strand) and the other copies the duplicate check pairs it
 * with, and the books an orphan's files match.
 */
export function healthView(c: Corpus, library: string) {
  const latest = latestHealthReport(c.data);
  if (!latest) return { report: null };
  const r = latest.report;
  const id = (n: number) => `${library}:${n}`;
  const title = c.db.prepare<[string], string>("SELECT title FROM books WHERE id = ?").pluck();
  const { pairs } = duplicatePairs(c, library, true);
  const copies = (bookId: string) => pairs.filter((p) => p.books.some((b) => b.id === bookId))
    .map((p) => p.books.find((b) => b.id !== bookId)!).map((b) => ({ book_id: b.id, title: b.title, status: b.status }));
  return {
    job_id: latest.job_id,
    report: {
      ...r,
      records_missing: r.records_missing.map((m) => ({
        ...m, book_id: id(m.id),
        references: Object.fromEntries(Object.entries(duplicateReferences(c, m.uuid)).filter(([, n]) => n > 0)),
        copies: copies(id(m.id)),
      })),
      orphans: r.orphans.map((o) => ({
        ...o, book_id: o.record ? id(o.id) : null,
        files: o.files.map((f) => ({ ...f, matches: f.matches.map((m) => ({ ...m, book_id: id(m.id), title: title.get(id(m.id)) ?? null })) })),
      })),
      cover_unflagged: r.cover_unflagged.map((x) => ({ ...x, book_id: id(x.id) })),
    },
  };
}
