import fs from "node:fs";
import path from "node:path";
import type { AdminConfig, Config } from "./config.js";
import { listProposals } from "./tagging.js";
import { zoteroReport } from "./zotero.js";
import { type Corpus, corpusStatus, listShelves } from "./tools.js";

/** The numbers behind the /admin dashboard. Everything here is read-only. */

interface Probe { name: string; url: string; up: boolean; status: number | null; ms: number | null; error?: string; checked_at: string }

let probeCache: { at: number; probes: Probe[] } | null = null;

/** Neighbouring LAN services: up means any HTTP answer within 3 seconds. Cached for 30 seconds. */
export async function probeNeighbors(neighbors: AdminConfig["neighbors"]): Promise<Probe[]> {
  if (probeCache && Date.now() - probeCache.at < 30_000) return probeCache.probes;
  const probes = await Promise.all(neighbors.map(async ({ name, url }): Promise<Probe> => {
    const started = Date.now();
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      await res.body?.cancel();
      return { name, url, up: true, status: res.status, ms: Date.now() - started, checked_at: new Date().toISOString() };
    } catch (error) {
      return { name, url, up: false, status: null, ms: null, error: (error as Error).message, checked_at: new Date().toISOString() };
    }
  }));
  probeCache = { at: Date.now(), probes };
  return probes;
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function disk(dir: string) {
  try {
    const s = fs.statfsSync(dir);
    return { path: dir, total_bytes: s.blocks * s.bsize, free_bytes: s.bavail * s.bsize };
  } catch {
    return { path: dir, total_bytes: null, free_bytes: null };
  }
}

function newestBackup(dir: string) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^data-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    const newest = files.at(-1);
    if (!newest) return { count: 0, newest: null, newest_at: null };
    return { count: files.length, newest, newest_at: fs.statSync(path.join(dir, newest)).mtime.toISOString() };
  } catch {
    return { count: 0, newest: null, newest_at: null };
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function adminMetrics(c: Corpus, config: Config, version: string) {
  const admin = config.admin!;
  const status = corpusStatus(c);
  const runs = (c.db.prepare("SELECT started_at, finished_at, seconds, summary FROM scan_runs ORDER BY id DESC LIMIT 12").all() as
    { started_at: string; finished_at: string; seconds: number; summary: string }[])
    .map((r) => {
      const s = JSON.parse(r.summary) as Record<string, unknown>;
      return { finished_at: r.finished_at, seconds: r.seconds, extracted: s.extracted, unchanged: s.unchanged, failed: s.failed,
        removed: s.removed, unreadable_libraries: s.unreadableLibraries, shelves: s.shelves };
    });
  const proposals = listProposals(c, { status: "approved", limit: 200 });
  return {
    generated_at: new Date().toISOString(),
    service: { version, uptime_seconds: Math.round(process.uptime()), access_configured: Boolean(admin.access.teamDomain && admin.access.audience) },
    index: {
      last_scan: status.last_scan,
      counts: status.counts,
      failed: status.failed,
      little_or_no_text: status.little_or_no_text.books.length,
      no_outline: status.no_outline.books.length,
      corpus_db_bytes: fileSize(config.dbPath),
      runs,
    },
    sync: readJson(admin.syncStatus),
    data: {
      data_db_bytes: fileSize(config.dataDbPath),
      backups: newestBackup(config.backupDir),
      proposals: { ...proposals.counts, approved_not_in_calibre: proposals.proposals.filter((p) => !p.in_calibre).length },
    },
    citekeys: {
      pinned: status.citekeys.pinned, calibre_identifier: status.citekeys.calibre_identifier, ready_to_file: status.citekeys.ready_to_file,
      blocked: status.citekeys.blocked, proposed_collisions: status.citekeys.proposed_collisions.length,
    },
    printed_isbns: { books_without_isbn: status.printed_isbns.books_without_isbn, books_printing_isbn: status.printed_isbns.books_printing_isbn },
    printed_years: { books_without_year: status.printed_years.books_without_year, books_printing_year: status.printed_years.books_printing_year },
    tags: {
      tagged_books: status.tags.tagged_books, distinct: status.tags.distinct, used_once: status.tags.used_once,
      suspect: status.tags.suspect.length + ((status.tags as { suspect_truncated?: number }).suspect_truncated ?? 0),
    },
    shelves: listShelves(c).shelves,
    quotes: Object.fromEntries((c.data.prepare(`
      SELECT 'total' AS k, COUNT(*) AS n FROM quotes UNION ALL
      SELECT 'orphaned', COUNT(*) FROM quotes WHERE status = 'orphaned'`).all() as { k: string; n: number }[]).map((r) => [r.k, r.n])),
    zotero: config.zotero ? (() => {
      const z = zoteroReport(c, config.zotero);
      return { in_zotero: z.books.calibre_uuid + z.books.isbn + z.books.confirmed, candidates: z.books.candidates, mismatches: z.mismatches.length, duplicates: z.duplicates.length, synced_at: z.sync.synced_at, error: z.sync.error };
    })() : null,
    disk: [disk(path.dirname(config.dbPath)), disk(config.booksRoot)],
    neighbors: await probeNeighbors(admin.neighbors),
  };
}
