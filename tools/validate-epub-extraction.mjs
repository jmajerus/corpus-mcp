// Read-only comparison: npm run build && node tools/validate-epub-extraction.mjs book.epub [...]
import fs from "node:fs";
import { parseArgs } from "node:util";
import { extractBook } from "../dist/extract.js";

const { values, positionals: files } = parseArgs({ allowPositionals: true, options: { backend: { type: "string", default: "pandoc" } } });
if (!["pandoc", "source"].includes(values.backend)) throw new Error("--backend must be pandoc or source");
if (!files.length) {
  console.error("Usage: node tools/validate-epub-extraction.mjs [--backend pandoc|source] book.epub [...]");
  process.exitCode = 1;
}
for (const file of files) {
  try {
    const data = fs.readFileSync(file);
    const baseline = extractBook(data, "epub");
    const preview = extractBook(data, "epub", { epubParagraphs: values.backend });
    const locationsStable = baseline.pages.length === preview.pages.length && baseline.pages.every((p, i) => p.index === preview.pages[i].index);
    const outlineStable = JSON.stringify(baseline.outline) === JSON.stringify(preview.outline);
    if (values.backend === "source" && (!locationsStable || !outlineStable)) throw new Error("Location or outline mapping changed.");
    // Successful conversion is not a fidelity verdict. Pandoc intentionally changes locations.
    console.log(JSON.stringify({ file, backend: values.backend, status: values.backend === "pandoc" ? "converted" : "passed",
      pandocVersion: preview.pandocVersion, baselineLocations: baseline.pages.length, locations: preview.pages.length, locationsStable, outlineStable,
      pandocAdapterVersion: preview.pandocAdapterVersion, preprocessedTargets: preview.preprocessedTargets,
      ...(preview.pandocWarnings ? { pandocWarnings: preview.pandocWarnings } : {}),
      changedPages: baseline.pages.filter((p, i) => p.paragraphs.join("\n\n") !== preview.pages[i]?.paragraphs.join("\n\n")).length,
      baselineParagraphFragments: baseline.pages.reduce((n, p) => n + p.paragraphs.length, 0),
      sourceParagraphFragments: preview.pages.reduce((n, p) => n + p.paragraphs.length, 0) }));
  } catch (error) {
    console.log(JSON.stringify({ file, status: "refused", error: error.message }));
    process.exitCode = 1;
  }
}
