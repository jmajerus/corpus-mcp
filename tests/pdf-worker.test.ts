import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDataStore } from "../src/data.js";
import { contentFindings, contentProfile, pdfProfile, profilesSettled } from "../src/duplicate-contents.js";
import { PdfRunner, PdfTimeout, stopPdfWorkers, usePdfWorkers } from "../src/pdf-runner.js";
import { runPdfTask } from "../src/pdf-tasks.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import { type Corpus, ToolError, renderPageAsync } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import type { Config } from "../src/config.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

// The server's MuPDF work in worker threads: a damaged PDF can keep MuPDF busy for many minutes, which
// must never stop the server answering (2026-11-14: /admin/duplicates profiled every copy inline).

afterEach(() => stopPdfWorkers());

const pdf = () => makePdf({ pages: [["One two three four five six seven eight nine ten eleven"], ["Twelve thirteen fourteen"]] });

it("runs tasks in a worker, one at a time, and stops one that runs past its time limit", async () => {
  const root = tempDir();
  const file = path.join(root, "book.pdf");
  fs.writeFileSync(file, pdf());
  const runner = new PdfRunner(30_000);
  try {
    const [a, b] = await Promise.all([
      runner.run({ kind: "profile", file, format: "PDF" }),
      runner.run({ kind: "render", file, format: "pdf", page: 1, scale: 0.5 }),
    ]);
    expect(a).toMatchObject({ pages: 2, words: 14 });
    expect(b).toEqual(runPdfTask({ kind: "render", file, format: "pdf", page: 1, scale: 0.5 }));
    await expect(runner.run({ kind: "profile", file: path.join(root, "missing.pdf"), format: "PDF" })).rejects.toThrow(/ENOENT/);
  } finally {
    runner.close();
  }
  // A limit no task can meet: stopped, and the next task gets a fresh worker.
  const strict = new PdfRunner(1);
  try {
    await expect(strict.run({ kind: "profile", file, format: "PDF" })).rejects.toBeInstanceOf(PdfTimeout);
    await expect(strict.run({ kind: "profile", file, format: "PDF" })).rejects.toThrow(/took longer than 0 s/);
  } finally {
    strict.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

it("profiles in the background with workers, keeps the result in data.db, and records a timeout as unreadable", async () => {
  const root = tempDir();
  const data = openDataStore(path.join(root, "data.db"));
  const file = path.join(root, "copy.pdf");
  fs.writeFileSync(file, pdf());
  try {
    usePdfWorkers();
    expect(contentProfile(file, "PDF", data)).toEqual({ pending: true });
    // Pending copies aren't compared, and the group says which format is still being read.
    const findings = contentFindings([{ id: "a", contents: { PDF: { pending: true } } }, { id: "b", contents: { PDF: pdfProfile(pdf()) } }], ["PDF sizes differ: …"]);
    expect(findings).toMatchObject({ content_warnings: [], contents_pending: ["PDF"], size_warnings: ["PDF sizes differ: …"] });
    await profilesSettled();
    expect(contentProfile(file, "PDF", data)).toMatchObject({ pages: 2, words: 14 });
    expect(JSON.parse(data.prepare("SELECT profile FROM file_profiles").pluck().get() as string)).toMatchObject({ pages: 2, words: 14 });

    // A file MuPDF can't finish in time is unreadable, and stays so (a new copy of the file is read again).
    stopPdfWorkers();
    usePdfWorkers({ profileTimeoutMs: 1 });
    const slow = path.join(root, "slow.pdf");
    fs.writeFileSync(slow, pdf());
    expect(contentProfile(slow, "PDF", data)).toEqual({ pending: true });
    await profilesSettled();
    expect(contentProfile(slow, "PDF", data)).toEqual({ error: "Reading the PDF took longer than 0 s, so it was stopped; the file may be damaged." });
  } finally {
    stopPdfWorkers();
    data.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("stops a render past its time limit, then refuses that file at once until it changes", async () => {
  const root = tempDir();
  makeLibrary(root, "main", [{ id: 1, title: "Damaged", authors: ["Dee Mage"], files: { pdf: pdf() } }]);
  const vocabularyPath = path.join(import.meta.dirname, "vocabulary.json");
  const config = {
    booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"), dataDbPath: path.join(root, "data.db"),
    backupDir: path.join(root, "backups"), shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
    citekeyPreset: "author-year-word", vocabularyPath,
  } as Config;
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  const data = openDataStore(config.dataDbPath);
  const c: Corpus = { db, data, booksRoot: root, vocabulary: Vocabulary.load(vocabularyPath) };
  try {
    // As a damaged PDF behaves: MuPDF runs past the limit, and the worker is stopped.
    usePdfWorkers({ renderTimeoutMs: 1 });
    const first = renderPageAsync(c, { book_id: "main:1", file_page: 1 });
    await expect(first).rejects.toBeInstanceOf(ToolError);
    await expect(first).rejects.toThrow(/Rendering main:1 took longer than 0 s, so it was stopped; the PDF may be damaged/);

    // With a limit any render meets, the same file is still refused, at once: no worker task is started.
    stopPdfWorkers();
    usePdfWorkers({ renderTimeoutMs: 30_000 });
    const started = Date.now();
    await expect(renderPageAsync(c, { book_id: "main:1", file_page: 1 })).rejects.toThrow(/took longer than 0 s/);
    expect(Date.now() - started).toBeLessThan(50);

    // A replaced file (new size or time) is rendered again.
    const file = path.join(root, db.prepare("SELECT file_path FROM books WHERE id = 'main:1'").pluck().get() as string);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    expect(await renderPageAsync(c, { book_id: "main:1", file_page: 1, scale: 0.5 })).toMatchObject({ width: 306, file_page: 1 });
  } finally {
    stopPdfWorkers();
    db.close();
    data.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
