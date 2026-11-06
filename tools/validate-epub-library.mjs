// Read-only, sequential EPUB conversion survey. Book contents remain on the indexing host.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { values } = parseArgs({ options: {
  index: { type: "string" }, "books-root": { type: "string" }, output: { type: "string" },
  extractor: { type: "string", default: fileURLToPath(new URL("../dist/extract.js", import.meta.url)) },
  worker: { type: "string" },
} });
const extractor = path.resolve(values.extractor);
if (values.worker) {
  const book = JSON.parse(values.worker);
  try {
    const { extractBook } = await import(pathToFileURL(extractor).href);
    const bytes = fs.readFileSync(book.file);
    if (createHash("sha256").update(bytes).digest("hex") !== book.sha256) throw new Error("File changed since indexing.");
    const next = extractBook(bytes, "epub", { epubParagraphs: "pandoc" });
    const lostOutline = book.outline > 0 && next.outline.length === 0;
    console.log(JSON.stringify({ book: book.id, status: lostOutline ? "deferred" : "converted",
      ...(lostOutline ? { reason: "lost-chapter-navigation" } : {}), indexedStatus: book.status,
      oldLocations: book.page_count, locations: next.pages.length, oldOutline: book.outline,
      outline: next.outline.length, pandocVersion: next.pandocVersion,
      pandocAdapterVersion: next.pandocAdapterVersion, preprocessedTargets: next.preprocessedTargets,
      auxiliaryCovers: next.auxiliaryCovers,
      warning: !!next.pandocWarnings,
      ...(next.pandocWarnings ? { pandocWarnings: next.pandocWarnings } : {}) }));
  } catch (error) {
    console.log(JSON.stringify({ book: book.id, status: error.name === "EpubNavigationError" ? "deferred" : "failed", reason: error.message }));
  }
} else {
  if (!values.index || !values["books-root"] || !values.output) {
    throw new Error("Usage: node tools/validate-epub-library.mjs --index corpus.db --books-root /srv/corpus/books --output /path/to/new-report-directory [--extractor /release/dist/extract.js]");
  }
  const Database = createRequire(pathToFileURL(extractor))("better-sqlite3");
  const db = new Database(values.index, { readonly: true, fileMustExist: true });
  let books;
  try {
    books = db.prepare(`SELECT b.id,b.status,b.file_path,b.sha256,b.page_count,
      (SELECT count(*) FROM outline o WHERE o.book_id=b.id) AS outline
      FROM books b WHERE b.format='epub' AND b.status IN ('indexed','failed') ORDER BY b.file_size,b.id`).all();
  } finally { db.close(); }
  // Reports are a fresh private directory. No active database or library file is opened for writing.
  fs.mkdirSync(values.output, { mode: 0o700 });
  const started = new Date().toISOString();
  const counts = { converted: 0, deferred: 0, failed: 0 };
  const summary = () => ({ started, updated: new Date().toISOString(), total: books.length,
    completed: counts.converted + counts.deferred + counts.failed, ...counts, promotionReady: false });
  const update = (extra = {}) => {
    fs.writeFileSync(path.join(values.output, "summary.json.tmp"), JSON.stringify({ ...summary(), ...extra }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(path.join(values.output, "summary.json.tmp"), path.join(values.output, "summary.json"));
  };
  update();
  for (const book of books) {
    update({ current: book.id });
    const run = spawnSync(process.execPath, ["--max-old-space-size=768", fileURLToPath(import.meta.url),
      "--extractor", extractor, "--worker", JSON.stringify({ ...book, file: path.join(values["books-root"], book.file_path) })],
    { encoding: "utf8", timeout: 150_000, maxBuffer: 64 * 1024 });
    let result;
    try {
      if (run.error || run.status !== 0) throw new Error(run.error?.message || `Worker exited ${run.status}, signal ${run.signal}`);
      result = JSON.parse(run.stdout);
      if (!["converted", "deferred", "failed"].includes(result.status)) throw new Error("Invalid worker report.");
    } catch (error) { result = { book: book.id, status: "failed", reason: error.message }; }
    counts[result.status]++;
    fs.appendFileSync(path.join(values.output, "books.jsonl"), JSON.stringify(result) + "\n", { mode: 0o600 });
    update();
  }
  update({ finished: new Date().toISOString() });
  console.log(JSON.stringify(summary()));
}
