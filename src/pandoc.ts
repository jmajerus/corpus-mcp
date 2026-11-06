import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtractedBook, OutlineEntry } from "./extract.js";

/** A distinct profile: Pandoc block locations intentionally differ from MuPDF pages. */
export const PANDOC_EXTRACTOR_VERSION = 3;

// Pandoc owns both EPUB interpretation and text serialization. This writer only adapts its
// document blocks to our location interface. Keep the AST available for future rich output.
const WRITER = `
function Writer(doc, opts)
  local locations = {}
  local function collect(blocks)
    for _, block in ipairs(blocks) do
      if block.t == 'Div' then
        collect(block.content)
      else
        local text = pandoc.write(pandoc.Pandoc({block}), 'plain', {wrap_text = 'none'})
        text = text:gsub('\\n+$', '')
        if text:match('%S') then
          table.insert(locations, {text = text, heading = block.t == 'Header' and block.level or 0})
        end
      end
    end
  end
  collect(doc.blocks)
  return pandoc.json.encode({
    version = tostring(PANDOC_VERSION),
    document = pandoc.json.decode(pandoc.write(doc, 'json')),
    locations = locations
  })
end
`;

export interface PandocDocument {
  "pandoc-api-version": number[];
  meta: Record<string, unknown>;
  blocks: unknown[];
}
export interface PandocBook extends ExtractedBook {
  /** Complete Pandoc AST; not flattened text, suitable for subsequent Pandoc writers. */
  document: PandocDocument;
  pandocVersion: string;
}

/** Requires Pandoc >= 3.1 (pandoc.json). No shell, filters, remote resources, or layout engine. */
export function extractPandocEpub(data: Uint8Array): PandocBook {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-pandoc-"));
  try {
    const input = path.join(directory, "book.epub"), writer = path.join(directory, "locations.lua");
    fs.writeFileSync(input, data);
    fs.writeFileSync(writer, WRITER);
    const result = spawnSync(process.env.CORPUS_PANDOC_PATH || "pandoc", [
      "--sandbox", "--from=epub", `--to=${writer}`, "--wrap=none", input,
    ], { encoding: "utf8", timeout: 120_000, maxBuffer: 128 * 1024 * 1024, cwd: directory });
    if (result.error || result.status !== 0) {
      const reason = result.error?.message || result.stderr.trim().slice(0, 2000) || `exit ${result.status}`;
      throw new Error(`Pandoc EPUB extraction failed: ${reason}. Install Pandoc >= 3.1 or set CORPUS_PANDOC_PATH.`);
    }
    const parsed = JSON.parse(result.stdout) as {
      version: string; document: PandocDocument; locations: { text: string; heading: number }[];
    };
    if (typeof parsed.version !== "string" || !Array.isArray(parsed.document?.blocks)
      || !Array.isArray(parsed.document?.["pandoc-api-version"]) || !Array.isArray(parsed.locations)
      || parsed.locations.some((p) => typeof p.text !== "string" || !Number.isInteger(p.heading) || p.heading < 0)) {
      throw new Error("Pandoc returned an invalid extraction document.");
    }
    const version = /^(\d+)\.(\d+)(?:\.\d+)*$/.exec(parsed.version);
    const major = Number(version?.[1]), minor = Number(version?.[2]);
    if (!version || !Number.isSafeInteger(major) || !Number.isSafeInteger(minor)
      || major < 3 || (major === 3 && minor < 1)) {
      throw new Error(`Unsupported Pandoc version ${JSON.stringify(parsed.version)}; install Pandoc >= 3.1.`);
    }
    if (!parsed.locations.length) throw new Error("Pandoc EPUB extraction produced no readable text.");
    const outline: OutlineEntry[] = [];
    const parents: { level: number; title: string }[] = [];
    const pages = parsed.locations.map(({ text, heading }, index) => {
      if (heading) {
        while (parents.length && parents.at(-1)!.level >= heading) parents.pop();
        const title = text.replace(/\s+/g, " ").trim();
        parents.push({ level: heading, title });
        outline.push({ ord: outline.length, level: parents.length - 1, title,
          path: parents.map((p) => p.title).join(" › "), startPage: index });
      }
      return { index, label: null, paragraphs: [text], separatorBefore: index ? "\n\n" : "" };
    });
    return { reflowable: true, outline, pages, document: parsed.document, pandocVersion: parsed.version,
      ...(result.stderr.trim() ? { pandocWarnings: result.stderr.trim().slice(0, 8000) } : {}) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
