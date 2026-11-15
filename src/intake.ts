import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readCatalogue } from "./calibre.js";
import type { Config } from "./config.js";
import type { DataStore } from "./data.js";
import { type Corpus, ToolError } from "./tools.js";
import {
  MAX_BATCH_BYTES,
  MAX_STAGED_FILES,
  MAX_STAGED_TOTAL_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_EXTENSIONS,
  type UploadExtension,
  extractUploadMetadata,
  removeStagedUpload,
  sniffUpload,
  stageUpload,
  stagedUploadState,
  updateStagedUpload,
} from "./upload.js";

export const INTAKE_STATUSES = ["present", "candidate", "staged", "applied", "skipped", "problem", "too_large", "absent"] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

const GENERIC_TAGS = new Set(["ebooks", "ebook", "books", "book", "downloads", "download", "documents", "docs"]);
const HEADER_EXTS = new Set<UploadExtension>(["epub", "mobi", "azw", "azw3", "prc", "kfx", "kfx-zip"]);

export interface IntakeFile {
  path: string;
  size: number;
  mtime_ms: number;
  sha256: string | null;
  status: IntakeStatus;
  title: string | null;
  authors: string[];
  problem: string | null;
  staged_id: string | null;
  book_id: string | null;
  seen_at: string;
}

interface IntakeDbRow {
  path: string;
  size: number;
  mtime_ms: number;
  sha256: string | null;
  status: IntakeStatus;
  title: string | null;
  authors: string | null;
  problem: string | null;
  staged_id: string | null;
  book_id: string | null;
  seen_at: string;
}

/** Folder names under the file become suggested tags. They are not used to decide identity. */
export function intakeTags(relPath: string): string[] {
  const tags: string[] = [];
  for (const part of relPath.split("/").slice(0, -1)) {
    const tag = part.replace(/[\x00-\x1f]/g, "").replace(/_/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (!tag || tag.length > 40 || GENERIC_TAGS.has(tag.toLowerCase())) continue;
    if (tags.some(existing => existing.toLowerCase() === tag.toLowerCase())) continue;
    tags.push(tag);
    if (tags.length >= 5) break;
  }
  return tags;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * The real intake directory, or why it cannot be scanned. Refuses a root that is the book
 * mirror, inside it, or a parent of it. Symlinks are resolved before the check.
 */
export function assertIntakeRoot(config: Pick<Config, "intakeRoot" | "booksRoot">): string {
  if (!config.intakeRoot) {
    throw new ToolError("Intake is off. Mount the master ebook directory read-only and set CORPUS_INTAKE_ROOT.");
  }
  let root: string;
  try {
    root = fs.realpathSync(config.intakeRoot);
    if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`CORPUS_INTAKE_ROOT is not a directory: ${config.intakeRoot}`);
  }
  let books = path.resolve(config.booksRoot);
  try { books = fs.realpathSync(config.booksRoot); } catch { /* the mirror may be absent in a test */ }
  if (root === books || inside(books, root) || inside(root, books)) {
    throw new ToolError("CORPUS_INTAKE_ROOT must be outside the book mirror (CORPUS_BOOKS_ROOT). Mount the master directory somewhere else.");
  }
  return root;
}

export function intakeAvailability(config: Pick<Config, "intakeRoot" | "booksRoot">): { enabled: boolean; root: string | null; error: string | null } {
  if (!config.intakeRoot) return { enabled: false, root: null, error: null };
  try {
    return { enabled: true, root: assertIntakeRoot(config), error: null };
  } catch (error) {
    return { enabled: true, root: config.intakeRoot, error: (error as Error).message };
  }
}

function uploadExt(name: string): UploadExtension | null {
  const lower = name.toLowerCase();
  return UPLOAD_EXTENSIONS.find(ext => lower.endsWith(`.${ext}`)) ?? null;
}

function filenameTitle(name: string, ext: UploadExtension): string {
  const stem = name.slice(0, name.length - ext.length - 1).replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return (stem || name).slice(0, 1000);
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function readHead(file: string, bytes: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const got = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

interface WalkedFile { rel: string; real: string; size: number; mtimeMs: number; ext: UploadExtension }

/** Ebook files under root. Directory symlinks are not followed. A symlink whose target leaves root is ignored. */
export function walkIntake(root: string): { files: WalkedFile[]; outside: number; unreadable: number } {
  const files: WalkedFile[] = [];
  let outside = 0;
  let unreadable = 0;
  const seenDirs = new Set<string>();
  try { seenDirs.add(fs.realpathSync(root)); } catch { seenDirs.add(root); }
  const queue = [root];
  const queueDir = (full: string, name: string) => {
    if (name.startsWith("_")) return;
    let real: string;
    try { real = fs.realpathSync(full); } catch { unreadable++; return; }
    if (!inside(root, real)) { outside++; return; }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    queue.push(full);
  };
  while (queue.length) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable++;
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let real: string;
        try { real = fs.realpathSync(full); } catch { unreadable++; continue; }
        if (!inside(root, real)) { outside++; continue; }
        let st: fs.Stats;
        try { st = fs.statSync(real); } catch { unreadable++; continue; }
        if (st.isDirectory()) { queueDir(full, entry.name); continue; }
        const ext = uploadExt(entry.name);
        if (!ext || !st.isFile()) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (!rel || rel.startsWith("..")) { outside++; continue; }
        files.push({ rel, real, size: st.size, mtimeMs: Math.round(st.mtimeMs), ext });
        continue;
      }
      if (entry.isDirectory()) {
        queueDir(full, entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = uploadExt(entry.name);
      if (!ext) continue;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { unreadable++; continue; }
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      files.push({ rel, real: full, size: st.size, mtimeMs: Math.round(st.mtimeMs), ext });
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, outside, unreadable };
}

const INTAKE_PAUSE = "An intake scan is running. Stage or skip files after it finishes.";
const ROOT_KEY = "intake_root";

function assertIntakeIdle(c: Corpus): void {
  if (c.intakePaused) throw new ToolError(c.intakePaused);
}

/**
 * Remembers the canonical intake directory. A different mount reuses relative paths, so the
 * previous ledger is dropped rather than treated as the same files.
 */
function adoptIntakeRoot(c: Corpus, config: Config): { root: string; reset: boolean } {
  const root = assertIntakeRoot(config);
  const stored = c.data.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(ROOT_KEY) as string | undefined;
  if (stored === root) return { root, reset: false };
  if (stored) c.data.prepare("DELETE FROM intake_files").run();
  c.data.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(ROOT_KEY, root);
  return { root, reset: Boolean(stored) };
}

/** Libraries on the book mirror, including one the index skipped because every book is excluded or the library is not in `CORPUS_LIBRARIES`. */
function catalogueLibraries(c: Corpus, config: Config): string[] {
  const names = new Set<string>();
  const add = (name: string) => {
    if (name && !name.includes("/") && !name.includes("\\") && !name.includes("\0") && name !== "." && name !== "..") names.add(name);
  };
  for (const name of config.libraries) add(name);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(c.booksRoot, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      if (fs.statSync(path.join(c.booksRoot, entry.name, "metadata.db")).isFile()) add(entry.name);
    } catch { /* not a Calibre library */ }
  }
  return [...names];
}

/** SHA-256 of every Calibre format file, not only the one format the index selected. */
async function libraryHashes(c: Corpus, config: Config): Promise<Map<string, string>> {
  const byHash = new Map<string, string>();
  const add = (hash: string | null | undefined, bookId: string) => {
    if (hash && !byHash.has(hash)) byHash.set(hash, bookId);
  };
  for (const row of c.db.prepare("SELECT id, sha256 FROM books WHERE sha256 IS NOT NULL").all() as { id: string; sha256: string }[]) {
    add(row.sha256, row.id);
  }
  const cached = c.data.prepare("SELECT sha256 FROM intake_format_hashes WHERE stamp = ?").pluck();
  const store = c.data.prepare("INSERT OR REPLACE INTO intake_format_hashes (stamp, sha256) VALUES (?, ?)");
  for (const library of catalogueLibraries(c, config)) {
    let catalogue;
    try { catalogue = readCatalogue(path.join(c.booksRoot, library)); }
    catch { continue; }
    for (const entry of catalogue) {
      const bookId = `${library}:${entry.metadata.calibreId}`;
      for (const rel of Object.values(entry.files)) {
        const full = path.join(c.booksRoot, library, rel);
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (!st.isFile()) continue;
        const stamp = `${library}/${rel.split(path.sep).join("/")}|${st.size}|${Math.round(st.mtimeMs)}`;
        let hash = cached.get(stamp) as string | undefined;
        if (!hash) {
          try { hash = await hashFile(full); } catch { continue; }
          store.run(stamp, hash);
        }
        add(hash, bookId);
      }
    }
  }
  return byHash;
}

function reconcileStaged(c: Corpus, config: Config): void {
  const live = stagedUploadState(config).ids;
  const rows = c.data.prepare("SELECT path, staged_id FROM intake_files WHERE status = 'staged'").all() as { path: string; staged_id: string | null }[];
  const revert = c.data.prepare("UPDATE intake_files SET status = 'candidate', staged_id = NULL, seen_at = ? WHERE path = ?");
  const now = new Date().toISOString();
  for (const row of rows) {
    if (!row.staged_id || !live.has(row.staged_id)) revert.run(now, row.path);
  }
}

const UPSERT = `
INSERT INTO intake_files (path, size, mtime_ms, sha256, status, title, authors, problem, staged_id, book_id, seen_at)
VALUES (@path, @size, @mtime_ms, @sha256, @status, @title, @authors, @problem, @staged_id, @book_id, @seen_at)
ON CONFLICT(path) DO UPDATE SET
  size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256, status = excluded.status,
  title = excluded.title, authors = excluded.authors, problem = excluded.problem,
  staged_id = excluded.staged_id, book_id = excluded.book_id, seen_at = excluded.seen_at`;

interface Classified {
  status: IntakeStatus;
  sha256: string | null;
  title: string | null;
  authors: string[];
  problem: string | null;
  book_id: string | null;
}

async function classifyFile(file: WalkedFile, byHash: Map<string, string>): Promise<Classified> {
  const title = filenameTitle(path.posix.basename(file.rel), file.ext);
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: "too_large", sha256: null, title, authors: [], problem: "Larger than 250 MB, so it cannot be staged.", book_id: null };
  }
  if (file.size === 0) {
    return { status: "problem", sha256: null, title, authors: [], problem: "The file is empty.", book_id: null };
  }
  const sha256 = await hashFile(file.real);
  const bookId = byHash.get(sha256);
  if (bookId) return { status: "present", sha256, title, authors: [], problem: null, book_id: bookId };
  if (!HEADER_EXTS.has(file.ext)) {
    const sniff = sniffUpload(readHead(file.real, 1024), file.ext);
    return { status: sniff.problem ? "problem" : "candidate", sha256, title, authors: [], problem: sniff.problem, book_id: null };
  }
  const data = fs.readFileSync(file.real);
  const sniff = sniffUpload(data, file.ext);
  let extractedTitle = title;
  let authors: string[] = [];
  try {
    const extracted = extractUploadMetadata(data, file.ext, path.posix.basename(file.rel), sniff.problem);
    if (extracted.title) extractedTitle = extracted.title.slice(0, 1000);
    authors = extracted.authors;
  } catch { /* the filename stands */ }
  return {
    status: sniff.problem ? "problem" : "candidate",
    sha256,
    title: extractedTitle,
    authors,
    problem: sniff.problem,
    book_id: null,
  };
}

export interface IntakeScanSummary {
  root: string;
  seen: number;
  unchanged: number;
  outside: number;
  unreadable: number;
  counts: Record<IntakeStatus, number>;
}

/** Hash ebook files under the intake root and record which bytes are already indexed. Does not copy or add anything. */
export async function scanIntake(c: Corpus, config: Config, log: (text: string) => void = () => {}): Promise<IntakeScanSummary> {
  const previousPause = c.intakePaused;
  c.intakePaused = INTAKE_PAUSE;
  try {
    const adopted = adoptIntakeRoot(c, config);
    const root = adopted.root;
    if (adopted.reset) log("The intake directory changed, so the previous ledger was cleared.\n");
    reconcileStaged(c, config);
    const byHash = await libraryHashes(c, config);
    const live = stagedUploadState(config).ids;
    const walked = walkIntake(root);
    const existing = new Map(
      (c.data.prepare("SELECT * FROM intake_files").all() as IntakeDbRow[]).map(row => [row.path, row]),
    );
    const upsert = c.data.prepare(UPSERT);
    // A stage or skip that landed after the snapshot (status or staged_id changed) is left alone.
    const touch = c.data.prepare(`
      UPDATE intake_files SET status = ?, book_id = ?, staged_id = ?, seen_at = ?
      WHERE path = ? AND status = ? AND staged_id IS ?`);
    const currentRow = c.data.prepare("SELECT status, staged_id FROM intake_files WHERE path = ?");
    const now = () => new Date().toISOString();
    let unchanged = 0;
    let seen = 0;
    const seenPaths = new Set<string>();
    for (const file of walked.files) {
      seen++;
      seenPaths.add(file.rel);
      const row = existing.get(file.rel);
      const held = row && row.status !== "absent" && row.size === file.size && row.mtime_ms === file.mtimeMs && (row.sha256 !== null || row.status === "too_large");
      if (held && row) {
        let status = row.status;
        let bookId = row.book_id;
        let stagedId = row.staged_id;
        if (status === "staged" && (!stagedId || !live.has(stagedId))) {
          status = "candidate";
          stagedId = null;
        }
        if (status !== "staged" && status !== "applied") {
          if (row.sha256 && byHash.has(row.sha256)) {
            status = "present";
            bookId = byHash.get(row.sha256) ?? bookId;
            stagedId = null;
          } else if (status === "present") {
            status = "candidate";
            bookId = null;
            stagedId = null;
          }
        }
        touch.run(status, bookId, stagedId, now(), file.rel, row.status, row.staged_id);
        unchanged++;
      } else {
        const current = currentRow.get(file.rel) as { status: IntakeStatus; staged_id: string | null } | undefined;
        if (current?.status === "staged" && current.staged_id) removeStagedUpload(config, current.staged_id);
        try {
          const classified = await classifyFile(file, byHash);
          upsert.run({
            path: file.rel,
            size: file.size,
            mtime_ms: file.mtimeMs,
            sha256: classified.sha256,
            status: classified.status,
            title: classified.title,
            authors: JSON.stringify(classified.authors),
            problem: classified.problem,
            staged_id: null,
            book_id: classified.book_id,
            seen_at: now(),
          });
          if (classified.status === "problem" || classified.status === "too_large") {
            log(`${classified.status === "too_large" ? "too large" : "problem"}  ${file.rel}${classified.problem ? `: ${classified.problem}` : ""}\n`);
          }
        } catch (error) {
          upsert.run({
            path: file.rel, size: file.size, mtime_ms: file.mtimeMs, sha256: null, status: "problem",
            title: filenameTitle(path.posix.basename(file.rel), file.ext), authors: "[]",
            problem: (error as Error).message, staged_id: null, book_id: null, seen_at: now(),
          });
          log(`problem  ${file.rel}: ${(error as Error).message}\n`);
        }
      }
      if (seen % 50 === 0) log(`Scanned ${seen} files…\n`);
      await new Promise(resolve => setImmediate(resolve));
    }
    const hide = c.data.prepare(`
      UPDATE intake_files SET status = 'absent', seen_at = ?
      WHERE path = ? AND status IN ('candidate', 'problem', 'too_large')`);
    let missing = 0;
    for (const rel of c.data.prepare("SELECT path FROM intake_files WHERE status IN ('candidate', 'problem', 'too_large')").pluck().all() as string[]) {
      if (!seenPaths.has(rel)) { hide.run(now(), rel); missing++; }
    }
    const counts = emptyCounts();
    for (const row of c.data.prepare("SELECT status, COUNT(*) AS n FROM intake_files GROUP BY status").all() as { status: IntakeStatus; n: number }[]) {
      counts[row.status] = row.n;
    }
    log(`Scanned ${seen} ebook files (${unchanged} unchanged). ` +
      `${counts.present} already in the library, ${counts.candidate} to review, ${counts.problem} damaged or blocked, ${counts.too_large} too large` +
      (missing ? `, ${missing} no longer on the NAS` : "") + ". " +
      (walked.outside ? `Ignored ${walked.outside} symlink${walked.outside === 1 ? "" : "s"} that left the mount. ` : "") +
      (walked.unreadable ? `${walked.unreadable} path${walked.unreadable === 1 ? "" : "s"} could not be read. ` : "") +
      `Nothing was copied.\n`);
    return { root, seen, unchanged, outside: walked.outside, unreadable: walked.unreadable, counts };
  } finally {
    c.intakePaused = previousPause;
  }
}

function emptyCounts(): Record<IntakeStatus, number> {
  return { present: 0, candidate: 0, staged: 0, applied: 0, skipped: 0, problem: 0, too_large: 0, absent: 0 };
}

function presentRow(row: IntakeDbRow): IntakeFile {
  let authors: string[] = [];
  try { authors = row.authors ? JSON.parse(row.authors) as string[] : []; } catch { authors = []; }
  return { ...row, authors };
}

export function listIntake(c: Corpus, config: Config, query: { status?: string; q?: string; limit?: number; offset?: number } = {}) {
  const availability = intakeAvailability(config);
  const counts = emptyCounts();
  let reset = false;
  if (availability.enabled && !availability.error) {
    reset = adoptIntakeRoot(c, config).reset;
    if (!reset) reconcileStaged(c, config);
  }
  for (const row of c.data.prepare("SELECT status, COUNT(*) AS n FROM intake_files GROUP BY status").all() as { status: IntakeStatus; n: number }[]) {
    if (row.status in counts) counts[row.status] = row.n;
  }
  const status = query.status && (INTAKE_STATUSES as readonly string[]).includes(query.status) ? query.status : "candidate";
  const where = ["status = @status"];
  const params: Record<string, unknown> = { status };
  if (query.q?.trim()) {
    where.push("(lower(path) LIKE @q OR lower(COALESCE(title, '')) LIKE @q)");
    params.q = `%${query.q.trim().toLowerCase()}%`;
  }
  const filtered = `WHERE ${where.join(" AND ")}`;
  const total = c.data.prepare(`SELECT COUNT(*) FROM intake_files ${filtered}`).pluck().get(params) as number;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const items = (c.data.prepare(`SELECT * FROM intake_files ${filtered} ORDER BY path LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }) as IntakeDbRow[]).map(presentRow);
  const staging = stagedUploadState(config);
  return {
    ...availability,
    counts,
    total,
    status,
    limit,
    offset,
    items,
    reset,
    staging: { files: staging.files, bytes: staging.bytes, max_files: MAX_STAGED_FILES, max_bytes: MAX_STAGED_TOTAL_BYTES },
  };
}

function safeRelative(rel: string): string {
  if (!rel || rel.includes("\0") || rel.startsWith("/") || rel.includes("\\")) throw new ToolError("Choose a file from the intake list.");
  const parts = rel.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new ToolError("Choose a file from the intake list.");
  return parts.join("/");
}

function resolveIntakeFile(root: string, rel: string): { full: string; real: string } {
  const safe = safeRelative(rel);
  const full = path.resolve(root, ...safe.split("/"));
  const back = path.relative(root, full);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) throw new ToolError("Choose a file from the intake list.");
  let real: string;
  try { real = fs.realpathSync(full); } catch { throw new ToolError(`${safe} is no longer in the intake directory.`); }
  if (!inside(root, real)) throw new ToolError(`${safe} is outside the intake directory.`);
  return { full, real };
}

export interface StageIntakeOptions { maxFiles?: number; maxBytes?: number }

/** Copy the next ready files into upload staging, stopping at the staging quota. Does not modify the NAS copy. */
export function stageIntakeBatch(c: Corpus, config: Config, actor?: string, limits: StageIntakeOptions = {}) {
  assertIntakeIdle(c);
  const root = adoptIntakeRoot(c, config).root;
  reconcileStaged(c, config);
  const maxFiles = limits.maxFiles ?? MAX_STAGED_FILES;
  const maxBytes = limits.maxBytes ?? MAX_STAGED_TOTAL_BYTES;
  const state = stagedUploadState(config);
  let roomFiles = maxFiles - state.files;
  // One preview holds 250 MB. Leave the rest of the 500 MB staging room for the next batch.
  const storageRoom = maxBytes - state.bytes;
  const previewRoom = MAX_BATCH_BYTES - state.bytes;
  let roomBytes = Math.min(storageRoom, Math.max(0, previewRoom));
  const rows = c.data.prepare("SELECT * FROM intake_files WHERE status = 'candidate' ORDER BY path").all() as IntakeDbRow[];
  if (!rows.length) return { staged: 0, linked: 0, remaining: 0 };
  const mark = c.data.prepare("UPDATE intake_files SET status = 'staged', staged_id = ?, seen_at = ? WHERE path = ?");
  const note = c.data.prepare("UPDATE intake_files SET status = 'problem', problem = ?, seen_at = ? WHERE path = ?");
  const now = () => new Date().toISOString();
  let staged = 0;
  let linked = 0;
  for (const row of rows) {
    if (row.sha256 && state.hashes.has(row.sha256)) {
      mark.run(state.hashes.get(row.sha256), now(), row.path);
      linked++;
      continue;
    }
    if (roomFiles <= 0 || row.size > roomBytes) continue;
    let real: string;
    try {
      real = resolveIntakeFile(root, row.path).real;
    } catch (error) {
      note.run((error as Error).message, now(), row.path);
      continue;
    }
    const st = fs.statSync(real);
    if (st.size !== row.size || Math.round(st.mtimeMs) !== row.mtime_ms) {
      note.run("Changed since the last scan. Scan again before staging it.", now(), row.path);
      continue;
    }
    const data = fs.readFileSync(real);
    const hashed = createHash("sha256").update(data).digest("hex");
    if (hashed !== row.sha256) {
      note.run("Changed since the last scan. Scan again before staging it.", now(), row.path);
      continue;
    }
    const evaluated = stageUpload(c, config, path.posix.basename(row.path), data, actor);
    const tags = intakeTags(row.path);
    if (tags.length && !evaluated.draft.tags.length) updateStagedUpload(c, config, evaluated.id, { tags });
    mark.run(evaluated.id, now(), row.path);
    state.ids.add(evaluated.id);
    state.hashes.set(evaluated.sha256, evaluated.id);
    roomFiles--;
    roomBytes -= data.length;
    staged++;
  }
  const remaining = c.data.prepare("SELECT COUNT(*) FROM intake_files WHERE status = 'candidate'").pluck().get() as number;
  if (!staged && !linked && rows.length) {
    throw new ToolError(previewRoom < storageRoom
      ? "None of the ready files fit in this preview. Preview and apply the files already staged (250 MB at a time), then stage the next batch."
      : "None of the ready files fit in the remaining staging room. Apply or clear staged files on the Upload page first.");
  }
  return { staged, linked, remaining };
}

/** Remember that these files should stay on the NAS. Does not delete them. */
export function skipIntakeFiles(c: Corpus, config: Config, paths: string[]): { skipped: number } {
  assertIntakeIdle(c);
  adoptIntakeRoot(c, config);
  const update = c.data.prepare(`
    UPDATE intake_files SET status = 'skipped', seen_at = ?
    WHERE path = ? AND status IN ('candidate', 'problem', 'too_large')`);
  const now = new Date().toISOString();
  let skipped = 0;
  for (const rel of paths) {
    skipped += update.run(now, safeRelative(rel)).changes;
  }
  return { skipped };
}

/** After a successful upload apply, the NAS paths that were staged are recorded as added. */
export function markIntakeApplied(data: DataStore, library: string, items: { calibre_id?: number; upload_applied?: { id: string } }[]): void {
  const stmt = data.prepare("UPDATE intake_files SET status = 'applied', book_id = COALESCE(?, book_id), seen_at = ? WHERE staged_id = ?");
  const now = new Date().toISOString();
  for (const item of items) {
    const id = item.upload_applied?.id;
    if (!id) continue;
    const bookId = Number.isInteger(item.calibre_id) ? `${library}:${item.calibre_id}` : null;
    stmt.run(bookId, now, id);
  }
}

/**
 * Offer files that were left on the NAS again. Each goes back to the status the scan gave it: a file
 * too large to stage or with a recorded problem returns to that list, not to the ready list.
 */
export function unskipIntakeFiles(c: Corpus, config: Config, paths: string[]): { restored: number } {
  assertIntakeIdle(c);
  adoptIntakeRoot(c, config);
  const update = c.data.prepare(`
    UPDATE intake_files SET seen_at = @now, status = CASE
      WHEN size > @maxBytes THEN 'too_large'
      WHEN problem IS NOT NULL OR sha256 IS NULL THEN 'problem'
      ELSE 'candidate' END
    WHERE path = @path AND status = 'skipped'`);
  const now = new Date().toISOString();
  let restored = 0;
  for (const rel of paths) {
    restored += update.run({ now, maxBytes: MAX_UPLOAD_BYTES, path: safeRelative(rel) }).changes;
  }
  return { restored };
}

/**
 * A staged upload was removed on the Upload page before Apply. Removing is a decision about the file,
 * so its NAS path is recorded as left on the NAS rather than offered again in the next batch;
 * the Intake page can offer it again.
 */
export function skipIntakeStaging(data: DataStore, stagedId?: string): { skipped: number } {
  const now = new Date().toISOString();
  const info = stagedId
    ? data.prepare("UPDATE intake_files SET status = 'skipped', staged_id = NULL, seen_at = ? WHERE status = 'staged' AND staged_id = ?").run(now, stagedId)
    : data.prepare("UPDATE intake_files SET status = 'skipped', staged_id = NULL, seen_at = ? WHERE status = 'staged'").run(now);
  return { skipped: info.changes };
}
