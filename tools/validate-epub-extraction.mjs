// Read-only comparison: npm run build && node tools/validate-epub-extraction.mjs book.epub [...]
import fs from "node:fs";
import { extractBook } from "../dist/extract.js";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node tools/validate-epub-extraction.mjs book.epub [...]");
  process.exitCode = 1;
}
for (const file of files) {
  try {
    const data = fs.readFileSync(file);
    const baseline = extractBook(data, "epub");
    const preview = extractBook(data, "epub", { epubParagraphs: "source" });
    const locationsStable = baseline.pages.length === preview.pages.length && baseline.pages.every((p, i) => p.index === preview.pages[i].index);
    const outlineStable = JSON.stringify(baseline.outline) === JSON.stringify(preview.outline);
    if (!locationsStable || !outlineStable) throw new Error("Location or outline mapping changed.");
    console.log(JSON.stringify({ file, status: "passed", locations: preview.pages.length, locationsStable, outlineStable,
      changedPages: baseline.pages.filter((p, i) => p.paragraphs.join("\n\n") !== preview.pages[i].paragraphs.join("\n\n")).length,
      baselineParagraphFragments: baseline.pages.reduce((n, p) => n + p.paragraphs.length, 0),
      sourceParagraphFragments: preview.pages.reduce((n, p) => n + p.paragraphs.length, 0) }));
  } catch (error) {
    console.log(JSON.stringify({ file, status: "refused", error: error.message }));
    process.exitCode = 1;
  }
}
