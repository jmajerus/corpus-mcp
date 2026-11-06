// Checkpointed extraction into an existing private candidate. Never promotes or edits source DBs.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { values } = parseArgs({ options: {
  candidate: { type: "string" }, "books-root": { type: "string" },
  backend: { type: "string", default: fileURLToPath(new URL("../dist/reextraction.js", import.meta.url)) },
  worker: { type: "string" },
} });
if (!values.candidate || !values["books-root"]) throw new Error("Supply --candidate and --books-root.");
const backend = path.resolve(values.backend);
if (values.worker) {
  const { stageUnanchoredCandidateBook } = await import(pathToFileURL(backend).href);
  console.log(JSON.stringify(stageUnanchoredCandidateBook({ candidate: values.candidate, booksRoot: values["books-root"], book: values.worker })));
} else {
  const Database = createRequire(pathToFileURL(backend))("better-sqlite3");
  const db = new Database(path.join(values.candidate, "corpus.db"), { readonly: true, fileMustExist: true });
  const data = new Database(path.join(values.candidate, "data.db"), { readonly: true, fileMustExist: true });
  let books, held;
  try {
    if (db.prepare("SELECT value FROM meta WHERE key='epub_source_preview'").pluck().get() !== "inspection-only") throw new Error("Not an inspection candidate.");
    const saved = new Set([...data.prepare("SELECT calibre_uuid FROM anchors").pluck().all(), ...data.prepare("SELECT calibre_uuid FROM quotes").pluck().all()]);
    const all = db.prepare("SELECT id,uuid FROM books WHERE format='epub' AND status='indexed' AND extractor_version<>3 ORDER BY file_size,id").all();
    books = all.filter((b) => !saved.has(b.uuid)); held = all.filter((b) => saved.has(b.uuid)).map((b) => b.id);
  } finally { db.close(); data.close(); }
  const progress = path.join(values.candidate, "progress.json"), records = path.join(values.candidate, "books.jsonl");
  if (fs.existsSync(progress) || fs.existsSync(records)) throw new Error("This candidate already has a run report.");
  const started = new Date().toISOString(), counts = { staged: 0, refused: 0 };
  const update = (extra = {}) => {
    const summary = { started, updated: new Date().toISOString(), total: books.length, completed: counts.staged + counts.refused,
      ...counts, heldForConsumer: held, promotionReady: false, ...extra };
    fs.writeFileSync(progress + ".tmp", JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(progress + ".tmp", progress);
  };
  update();
  try {
    for (const book of books) {
      update({ current: book.id });
      const temporary = fs.mkdtempSync(path.join(values.candidate, "worker-"));
      const grouped = process.platform !== "win32";
      const run = spawnSync(process.execPath, ["--max-old-space-size=900", fileURLToPath(import.meta.url),
        "--candidate", values.candidate, "--books-root", values["books-root"], "--backend", backend, "--worker", book.id],
      { encoding: "utf8", timeout: 900_000, killSignal: "SIGKILL", detached: grouped, maxBuffer: 128 * 1024,
        env: { ...process.env, TMPDIR: temporary } });
      // A killed worker may leave its Pandoc child. Kill the isolated process group, then remove
      // only that worker's private temporary files (which can contain a copy of the input EPUB).
      if (grouped && run.pid) { try { process.kill(-run.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      fs.rmSync(temporary, { recursive: true, force: true });
      let result;
      if (run.error || run.status !== 0) {
        const inspect = new Database(path.join(values.candidate, "corpus.db"), { readonly: true });
        try {
          // Workers cannot modify saved quotes/anchors, and book/index writes are one transaction.
          // If the process died after commit, that complete book can be retained safely.
          const version = inspect.prepare("SELECT extractor_version FROM books WHERE id=?").pluck().get(book.id);
          result = version === 3 ? { book: book.id, status: "staged", recoveredAfterWorkerExit: true }
            : { book: book.id, status: "refused", reason: run.error?.message || `Worker exited ${run.status}, signal ${run.signal}` };
        } finally { inspect.close(); }
      } else {
        result = JSON.parse(run.stdout);
        if (result.book !== book.id || !["staged", "refused"].includes(result.status)) throw new Error("Invalid worker report.");
      }
      counts[result.status]++;
      fs.appendFileSync(records, JSON.stringify(result) + "\n", { mode: 0o600 }); update();
    }
    const check = new Database(path.join(values.candidate, "corpus.db"));
    try {
      if (check.pragma("quick_check").some((row) => row.quick_check !== "ok")) throw new Error("Candidate index integrity check failed.");
      check.pragma("wal_checkpoint(TRUNCATE)");
    } finally { check.close(); }
    update({ finished: new Date().toISOString() });
  } catch (error) { update({ failed: true, error: error.message }); throw error; }
}
