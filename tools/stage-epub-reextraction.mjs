// Creates inspection-only copies; never updates or publishes an active index.
import { parseArgs } from "node:util";
import { stageEpubReextraction } from "../dist/reextraction.js";

try {
  const { values } = parseArgs({ options: {
    index: { type: "string" }, data: { type: "string" }, "books-root": { type: "string" },
    output: { type: "string" }, book: { type: "string", multiple: true },
    file: { type: "string", multiple: true },
    backend: { type: "string", default: "pandoc" },
  } });
  if (!values.index || !values.data || !values["books-root"] || !values.output || !values.book?.length) {
    throw new Error("Usage: node tools/stage-epub-reextraction.mjs --index snapshot/corpus.db --data snapshot/data.db --books-root /path/to/books --output /tmp/new-candidate --book main:37 [--book main:35]");
  }
  const files = Object.fromEntries((values.file ?? []).map((entry) => {
    const at = entry.indexOf("=");
    if (at < 1 || !entry.slice(at + 1)) throw new Error("--file takes book-id=/path/to/mirror.epub");
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  if (!["pandoc", "source"].includes(values.backend)) throw new Error("--backend must be pandoc or source");
  const report = await stageEpubReextraction({ index: values.index, data: values.data, booksRoot: values["books-root"], output: values.output, books: values.book, files, backend: values.backend });
  console.log(JSON.stringify(report, null, 2));
  if (report.books.some((b) => b.status === "refused")) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
