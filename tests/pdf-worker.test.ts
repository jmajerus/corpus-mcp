import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDataStore } from "../src/data.js";
import { contentFindings, contentProfile, pdfProfile, profilesSettled } from "../src/duplicate-contents.js";
import { PdfRunner, PdfTimeout, stopPdfWorkers, usePdfWorkers } from "../src/pdf-runner.js";
import { runPdfTask } from "../src/pdf-tasks.js";
import { makePdf, tempDir } from "./fixtures.js";

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
