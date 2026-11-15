import { createHash } from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDataStore } from "../src/data.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import {
  assertIntakeRoot,
  intakeTags,
  listIntake,
  markIntakeApplied,
  releaseIntakeStaging,
  scanIntake,
  skipIntakeFiles,
  stageIntakeBatch,
} from "../src/intake.js";
import { JobRunner, type JobCommands } from "../src/jobs.js";
import { listStagedUploads, uploadDir } from "../src/upload.js";
import { INTAKE_HTML } from "../src/web/intake.js";
import { Vocabulary } from "../src/vocabulary.js";
import { makeEpub, makeLibrary, makePdf, tempDir } from "./fixtures.js";

let root: string, books: string, intake: string, outside: string, config: Config, c: any;
const indexedPdf = makePdf({ pages: [["A synthetic book already in the library", "Copyright 2021 by Ada Lovelace"]] });

function snapshot(dir: string): Map<string, { size: number; mtimeMs: number; sha256: string }> {
  const out = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        out.set(full, { size: st.size, mtimeMs: st.mtimeMs, sha256: "symlink" });
        continue;
      }
      if (st.isDirectory()) { walk(full); continue; }
      out.set(full, { size: st.size, mtimeMs: st.mtimeMs, sha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex") });
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  root = tempDir();
  books = path.join(root, "books");
  intake = path.join(root, "intake");
  outside = path.join(root, "outside");
  fs.mkdirSync(intake, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  makeLibrary(books, "main", [
    { id: 1, title: "The Same Book", authors: ["Ada Lovelace"], pubdate: "2021-01-01", files: { pdf: indexedPdf } },
  ]);
  config = {
    booksRoot: books,
    intakeRoot: intake,
    libraries: ["main"],
    excludeTags: [],
    dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"),
    backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"),
    shelvesLibrary: "main",
    host: "127.0.0.1",
    port: 0,
    citekeyPreset: "author-year-word",
    vocabularyPath: path.resolve("tests/vocabulary.json"),
  };
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  db.close();
  c = {
    db: openDatabase(config.dbPath, { readonly: true }),
    data: openDataStore(config.dataDbPath),
    booksRoot: books,
    citekeyPreset: "author-year-word",
    vocabulary: Vocabulary.load(config.vocabularyPath),
  };
});

afterEach(() => {
  c.db.close();
  c.data.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("suggests folder tags and drops generic directory names", () => {
  expect(intakeTags("ebooks/Vendor/Batch/Notes.epub")).toEqual(["Vendor", "Batch"]);
  expect(intakeTags("2020/Publisher/Book.pdf")).toEqual(["2020", "Publisher"]);
  expect(intakeTags("a/b/c/d/e/f/Book.epub")).toEqual(["a", "b", "c", "d", "e"]);
});

it("refuses an intake root inside or around the book mirror", () => {
  expect(assertIntakeRoot(config)).toBe(fs.realpathSync(intake));
  expect(() => assertIntakeRoot({ ...config, intakeRoot: undefined })).toThrow(/CORPUS_INTAKE_ROOT/);
  expect(() => assertIntakeRoot({ ...config, intakeRoot: books })).toThrow(/book mirror/);
  expect(() => assertIntakeRoot({ ...config, intakeRoot: path.join(books, "main") })).toThrow(/book mirror/);
  expect(() => assertIntakeRoot({ ...config, booksRoot: path.join(intake, "library") })).toThrow(/book mirror/);
});

it("ignores symlinks that leave the mount, skips _ directories, and does not write the tree", async () => {
  const secret = makePdf({ pages: [["This file lives outside the mount"]] });
  fs.writeFileSync(path.join(outside, "secret.pdf"), secret);
  fs.symlinkSync(path.join(outside, "secret.pdf"), path.join(intake, "secret.pdf"));
  fs.symlinkSync(outside, path.join(intake, "escaped"));
  fs.mkdirSync(path.join(intake, "_done"));
  fs.writeFileSync(path.join(intake, "_done", "handled.epub"), makeEpub("Handled", [{ title: "One", paragraphs: ["Already sorted aside."] }]));
  fs.mkdirSync(path.join(intake, "Vendor"));
  fs.writeFileSync(path.join(intake, "Vendor", "New Book.epub"), makeEpub("From the Vendor", [{ title: "One", paragraphs: ["A book the library does not have."] }]));
  const before = snapshot(intake);
  const outsideBefore = snapshot(outside);
  const summary = await scanIntake(c, config, () => {});
  expect(summary.outside).toBeGreaterThanOrEqual(2);
  expect(snapshot(intake)).toEqual(before);
  expect(snapshot(outside)).toEqual(outsideBefore);
  const paths = (c.data.prepare("SELECT path FROM intake_files ORDER BY path").pluck().all() as string[]);
  expect(paths).toEqual(["Vendor/New Book.epub"]);
  expect(paths).not.toContain("secret.pdf");
  expect(paths.join("\n")).not.toContain("_done");
});

it("marks an exact indexed hash present and does not stage it", async () => {
  fs.writeFileSync(path.join(intake, "Already Here.pdf"), indexedPdf);
  fs.writeFileSync(path.join(intake, "Fresh Notes.pdf"), makePdf({ pages: [["A paper that is not in Calibre yet"]] }));
  await scanIntake(c, config, () => {});
  const present = c.data.prepare("SELECT status, book_id, title FROM intake_files WHERE path = ?").get("Already Here.pdf") as { status: string; book_id: string; title: string };
  expect(present.status).toBe("present");
  expect(present.book_id).toBe("main:1");
  expect(present.title).toBe("Already Here");
  const fresh = c.data.prepare("SELECT status FROM intake_files WHERE path = ?").get("Fresh Notes.pdf") as { status: string };
  expect(fresh.status).toBe("candidate");
  const before = snapshot(intake);
  const staged = stageIntakeBatch(c, config, "me@example.com");
  expect(staged.staged).toBe(1);
  expect(snapshot(intake)).toEqual(before);
  const again = c.data.prepare("SELECT status FROM intake_files WHERE path = ?").get("Already Here.pdf") as { status: string };
  expect(again.status).toBe("present");
  const uploads = listStagedUploads(c, config);
  expect(uploads.items.map(item => item.filename)).toEqual(["Fresh Notes.pdf"]);
});

it("does not rehash a file whose size and mtime are unchanged", async () => {
  const file = path.join(intake, "Stable.pdf");
  const first = makePdf({ pages: [["First bytes of a stable file"]] });
  const second = makePdf({ pages: [["Second bytes, same slot in the ledger"]] });
  expect(first.length).toBeLessThan(second.length);
  fs.writeFileSync(file, first);
  await scanIntake(c, config, () => {});
  const hashed = c.data.prepare("SELECT sha256, size, mtime_ms FROM intake_files WHERE path = ?").get("Stable.pdf") as { sha256: string; size: number; mtime_ms: number };
  const stamp = Math.round(hashed.mtime_ms / 1000) * 1000;
  c.data.prepare("UPDATE intake_files SET mtime_ms = ? WHERE path = ?").run(stamp, "Stable.pdf");
  const padded = Buffer.alloc(hashed.size, 0);
  second.subarray(0, Math.min(second.length, padded.length)).copy(padded);
  if (padded.equals(first)) padded[padded.length - 1] ^= 0xff;
  fs.writeFileSync(file, padded);
  fs.utimesSync(file, stamp / 1000, stamp / 1000);
  await scanIntake(c, config, () => {});
  const held = c.data.prepare("SELECT sha256 FROM intake_files WHERE path = ?").pluck().get("Stable.pdf");
  expect(held).toBe(hashed.sha256);
  const moved = new Date(stamp + 5000);
  fs.utimesSync(file, moved, moved);
  await scanIntake(c, config, () => {});
  const reread = c.data.prepare("SELECT sha256 FROM intake_files WHERE path = ?").pluck().get("Stable.pdf");
  expect(reread).not.toBe(hashed.sha256);
});

it("stages only a quota-sized batch, suggests folder tags, and leaves the NAS path in place", async () => {
  fs.mkdirSync(path.join(intake, "ebooks", "Vendor"), { recursive: true });
  for (const name of ["One.pdf", "Two.pdf", "Three.pdf"]) {
    fs.writeFileSync(path.join(intake, "ebooks", "Vendor", name), makePdf({ pages: [[`Distinct text for ${name}`]] }));
  }
  fs.writeFileSync(path.join(intake, "ebooks", "Vendor", "Guide.epub"), makeEpub("Guide to the Batch", [{ title: "One", paragraphs: ["Embedded title from the vendor folder."] }]));
  const before = snapshot(intake);
  await scanIntake(c, config, () => {});
  const guide = c.data.prepare("SELECT title, status FROM intake_files WHERE path = ?").get("ebooks/Vendor/Guide.epub") as { title: string; status: string };
  expect(guide.status).toBe("candidate");
  expect(guide.title).toBe("Guide to the Batch");
  const first = stageIntakeBatch(c, config, "me@example.com", { maxFiles: 2, maxBytes: 50 * 1024 * 1024 });
  expect(first.staged).toBe(2);
  expect(first.remaining).toBeGreaterThan(0);
  expect(snapshot(intake)).toEqual(before);
  const staged = listStagedUploads(c, config);
  expect(staged.items).toHaveLength(2);
  expect(staged.items.every(item => item.draft.tags.length === 1 && item.draft.tags[0] === "Vendor")).toBe(true);
  expect(() => stageIntakeBatch(c, config, "me@example.com", { maxFiles: 2, maxBytes: 50 * 1024 * 1024 })).toThrow(/staging room/);
  releaseIntakeStaging(c.data);
  const released = c.data.prepare("SELECT COUNT(*) FROM intake_files WHERE status = 'candidate'").pluck().get();
  expect(released).toBe(4);
});

it("records an applied upload and a decision to leave a file on the NAS", async () => {
  fs.writeFileSync(path.join(intake, "Skip Me.pdf"), makePdf({ pages: [["Leave this one"]] }));
  fs.writeFileSync(path.join(intake, "Add Me.pdf"), makePdf({ pages: [["Add this one later"]] }));
  await scanIntake(c, config, () => {});
  expect(skipIntakeFiles(c, config, ["Skip Me.pdf"]).skipped).toBe(1);
  expect(() => skipIntakeFiles(c, config, ["../outside/secret.pdf"])).toThrow(/intake list/);
  expect((c.data.prepare("SELECT status FROM intake_files WHERE path = ?").pluck().get("Skip Me.pdf"))).toBe("skipped");
  stageIntakeBatch(c, config, "me@example.com", { maxFiles: 1 });
  const stagedId = c.data.prepare("SELECT staged_id FROM intake_files WHERE path = ?").pluck().get("Add Me.pdf") as string;
  markIntakeApplied(c.data, "main", [{ calibre_id: 9, upload_applied: { id: stagedId } }]);
  const applied = c.data.prepare("SELECT status, book_id FROM intake_files WHERE path = ?").get("Add Me.pdf") as { status: string; book_id: string };
  expect(applied).toEqual({ status: "applied", book_id: "main:9" });
  expect(fs.existsSync(path.join(intake, "Add Me.pdf"))).toBe(true);
  const list = listIntake(c, config, { status: "applied" });
  expect(list.items.map(item => item.path)).toEqual(["Add Me.pdf"]);
});

it("runs the scan as an admin job and does not refresh Calibre", async () => {
  fs.writeFileSync(path.join(intake, "Job.pdf"), makePdf({ pages: [["Scanned by the job runner"]] }));
  let refreshed = 0;
  const commands: JobCommands = {
    async refresh() { refreshed++; },
    async calibre() { throw new Error("intake does not call Calibre"); },
  };
  const runner = new JobRunner(c, config, commands);
  const id = runner.start("intake", "apply", {}, "me@example.com");
  let status = "running";
  for (let i = 0; i < 50 && status === "running"; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    status = c.data.prepare("SELECT status FROM jobs WHERE id = ?").pluck().get(id) as string;
  }
  expect(status).toBe("succeeded");
  expect(refreshed).toBe(0);
  const log = c.data.prepare("SELECT log FROM jobs WHERE id = ?").pluck().get(id) as string;
  expect(log).toContain("to review");
  expect(log).toContain("Nothing was copied");
});

it("clears the ledger when the intake directory changes, even if path, size, and mtime match", async () => {
  const file = path.join(intake, "Same.pdf");
  const first = makePdf({ pages: [["Bytes from the first mount"]] });
  fs.writeFileSync(file, first);
  await scanIntake(c, config, () => {});
  c.data.prepare("UPDATE intake_files SET status = 'skipped' WHERE path = ?").run("Same.pdf");
  const before = c.data.prepare("SELECT sha256, size, mtime_ms FROM intake_files WHERE path = ?").get("Same.pdf") as { sha256: string; size: number; mtime_ms: number };
  const other = path.join(root, "other-intake");
  fs.mkdirSync(other);
  const padded = Buffer.alloc(before.size);
  const second = makePdf({ pages: [["Bytes from a different mount"]] });
  second.subarray(0, Math.min(second.length, padded.length)).copy(padded);
  if (padded.equals(first)) padded[padded.length - 1] ^= 0xff;
  fs.writeFileSync(path.join(other, "Same.pdf"), padded);
  fs.utimesSync(path.join(other, "Same.pdf"), before.mtime_ms / 1000, before.mtime_ms / 1000);
  config.intakeRoot = other;
  await scanIntake(c, config, () => {});
  const after = c.data.prepare("SELECT sha256, status FROM intake_files WHERE path = ?").get("Same.pdf") as { sha256: string; status: string };
  expect(after.sha256).not.toBe(before.sha256);
  expect(after.status).toBe("candidate");
  config.intakeRoot = intake;
});

it("drops the staged upload when the NAS file changes, then records the new bytes", async () => {
  const file = path.join(intake, "Swap.pdf");
  fs.writeFileSync(file, makePdf({ pages: [["Original staged bytes"]] }));
  await scanIntake(c, config, () => {});
  stageIntakeBatch(c, config, "me@example.com");
  const stagedId = c.data.prepare("SELECT staged_id FROM intake_files WHERE path = ?").pluck().get("Swap.pdf") as string;
  expect(fs.existsSync(path.join(uploadDir(config), `${stagedId}.json`))).toBe(true);
  const row = c.data.prepare("SELECT sha256, mtime_ms FROM intake_files WHERE path = ?").get("Swap.pdf") as { sha256: string; mtime_ms: number };
  fs.writeFileSync(file, makePdf({ pages: [["Replacement bytes after staging"]] }));
  fs.utimesSync(file, (row.mtime_ms + 5000) / 1000, (row.mtime_ms + 5000) / 1000);
  await scanIntake(c, config, () => {});
  expect(fs.existsSync(path.join(uploadDir(config), `${stagedId}.json`))).toBe(false);
  const after = c.data.prepare("SELECT status, sha256, staged_id FROM intake_files WHERE path = ?").get("Swap.pdf") as { status: string; sha256: string; staged_id: string | null };
  expect(after.status).toBe("candidate");
  expect(after.sha256).not.toBe(row.sha256);
  expect(after.staged_id).toBeNull();
});

it("marks a file that disappeared as absent and leaves it out of the ready list", async () => {
  fs.writeFileSync(path.join(intake, "Keep.pdf"), makePdf({ pages: [["Still on the NAS"]] }));
  fs.writeFileSync(path.join(intake, "Gone.pdf"), makePdf({ pages: [["Removed before the next scan"]] }));
  await scanIntake(c, config, () => {});
  fs.rmSync(path.join(intake, "Gone.pdf"));
  await scanIntake(c, config, () => {});
  expect(c.data.prepare("SELECT status FROM intake_files WHERE path = ?").pluck().get("Gone.pdf")).toBe("absent");
  expect(listIntake(c, config, { status: "candidate" }).items.map(item => item.path)).toEqual(["Keep.pdf"]);
});

it("treats an exact copy of a non-indexed format as already in the library", async () => {
  const epub = makeEpub("Side Format", [{ title: "One", paragraphs: ["The EPUB beside the indexed PDF."] }]);
  const folder = path.join(books, "main", "Ada Lovelace", "The Same Book (1)");
  const name = "The Same Book - Ada Lovelace";
  fs.writeFileSync(path.join(folder, `${name}.epub`), epub);
  const catalogue = new Database(path.join(books, "main", "metadata.db"));
  catalogue.prepare("INSERT INTO data (book, format, name) VALUES (1, 'EPUB', ?)").run(name);
  catalogue.close();
  const indexed = c.db.prepare("SELECT sha256 FROM books WHERE id = 'main:1'").pluck().get() as string;
  expect(indexed).not.toBe(createHash("sha256").update(epub).digest("hex"));
  fs.writeFileSync(path.join(intake, "Side Format.epub"), epub);
  await scanIntake(c, config, () => {});
  const row = c.data.prepare("SELECT status, book_id FROM intake_files WHERE path = ?").get("Side Format.epub") as { status: string; book_id: string };
  expect(row).toEqual({ status: "present", book_id: "main:1" });
});

it("refuses to stage or skip while a scan is running", () => {
  c.intakePaused = "An intake scan is running. Stage or skip files after it finishes.";
  expect(() => stageIntakeBatch(c, config, "me@example.com")).toThrow(/intake scan is running/);
  expect(() => skipIntakeFiles(c, config, ["Keep.pdf"])).toThrow(/intake scan is running/);
  c.intakePaused = undefined;
});

it("renders the intake page", () => {
  const scripts = [...INTAKE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  expect(scripts.length).toBeGreaterThanOrEqual(2);
  expect(() => new Function(scripts.join("\n;\n"))).not.toThrow();
  expect(INTAKE_HTML).toContain("Stage next batch");
  expect(INTAKE_HTML).toContain("/admin/upload");
  expect(INTAKE_HTML).toContain('href="/admin/intake" aria-current="page"');
});
