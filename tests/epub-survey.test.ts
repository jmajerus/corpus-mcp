import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

it("reports every book after a worker crash, retains warnings, and leaves inputs unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-survey-test-"));
  const project = fileURLToPath(new URL("../", import.meta.url));
  const index = path.join(root, "corpus.db"), output = path.join(root, "report");
  try {
    // The survey resolves its SQLite dependency relative to the selected extractor release.
    fs.symlinkSync(path.join(project, "node_modules"), path.join(root, "node_modules"), "dir");
    const extractor = path.join(root, "extract.mjs");
    fs.writeFileSync(extractor, `
      export function extractBook(bytes) {
        const mode = Buffer.from(bytes).toString();
        if (mode === 'crash') process.exit(9);
        return { pages: [{ index: 0, paragraphs: ['Extracted content.'] }],
          outline: mode === 'defer' ? [] : [{ title: 'Chapter' }], pandocVersion: '3.1.11.1',
          ...(mode === 'convert' ? { pandocWarnings: 'A diagnostic that needs operator review.' } : {}) };
      }
    `);
    const db = new Database(index);
    try {
      db.exec(`CREATE TABLE books (id TEXT, status TEXT, format TEXT, file_path TEXT, sha256 TEXT, page_count INTEGER, file_size INTEGER);
        CREATE TABLE outline (book_id TEXT);`);
      ["crash", "defer", "convert"].forEach((mode, i) => {
        const file = `${mode}.epub`, bytes = Buffer.from(mode), id = `main:${i + 1}`;
        fs.writeFileSync(path.join(root, file), bytes);
        db.prepare("INSERT INTO books VALUES (?, 'indexed', 'epub', ?, ?, 2, ?)")
          .run(id, file, createHash("sha256").update(bytes).digest("hex"), i);
        db.prepare("INSERT INTO outline VALUES (?)").run(id);
      });
    } finally { db.close(); }
    const before = fs.readFileSync(index);
    const run = spawnSync(process.execPath, [path.join(project, "tools/validate-epub-library.mjs"),
      "--index", index, "--books-root", root, "--output", output, "--extractor", extractor],
    { encoding: "utf8", timeout: 15_000 });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const records = fs.readFileSync(path.join(output, "books.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual([
      { book: "main:1", status: "failed", reason: "Worker exited 9, signal null" },
      expect.objectContaining({ book: "main:2", status: "deferred", reason: "lost-chapter-navigation", warning: false }),
      expect.objectContaining({ book: "main:3", status: "converted", warning: true,
        pandocWarnings: "A diagnostic that needs operator review." }),
    ]);
    expect(records[1]).not.toHaveProperty("pandocWarnings");
    const summary = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ total: 3, completed: 3, converted: 1, deferred: 1, failed: 1,
      promotionReady: false, finished: expect.any(String) });
    expect(JSON.parse(run.stdout)).toMatchObject({ total: 3, completed: 3, converted: 1, deferred: 1, failed: 1 });
    expect(fs.readFileSync(index)).toEqual(before);
    for (const mode of ["crash", "defer", "convert"]) expect(fs.readFileSync(path.join(root, `${mode}.epub`), "utf8")).toBe(mode);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
