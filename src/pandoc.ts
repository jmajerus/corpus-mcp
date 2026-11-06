import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtractedBook } from "./extract.js";
import { EpubNavigation, EpubNavigationError, mapPandocNavigation } from "./epub-navigation.js";

/** A distinct profile: Pandoc block locations intentionally differ from MuPDF pages. */
export const PANDOC_EXTRACTOR_VERSION = 3;
/** Pin adapter behavior independently of the Pandoc executable when refreshing staged indexes. */
export const PANDOC_ADAPTER_VERSION = 3;

// Pandoc owns both EPUB interpretation and text serialization. This writer only adapts its
// document blocks to our location interface. Keep the AST available for future rich output.
const WRITER = `
function Writer(doc, opts)
  local document = pandoc.json.decode(pandoc.write(doc, 'json'))
  local locations = {}
  local blockTexts = {}
  local function collect(blocks)
    for _, block in ipairs(blocks) do
      if block.t == 'Div' then
        collect(block.content)
      else
        local text = pandoc.write(pandoc.Pandoc({block}), 'plain', {wrap_text = 'none'})
        text = text:gsub('\\n+$', '')
        table.insert(blockTexts, text)
        if text:match('%S') then
          table.insert(locations, {text = text, heading = block.t == 'Header' and block.level or 0})
        end
      end
    end
  end
  collect(doc.blocks)
  return pandoc.json.encode({
    version = tostring(PANDOC_VERSION),
    document = document,
    locations = locations,
    blockTexts = blockTexts
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
  pandocAdapterVersion: number;
  preprocessedTargets: boolean;
}

/** Requires Pandoc >= 3.1 (pandoc.json). No shell, filters, remote resources, or layout engine. */
export function extractPandocEpub(data: Uint8Array): PandocBook {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-pandoc-"));
  try {
    const input = path.join(directory, "book.epub"), writer = path.join(directory, "locations.lua");
    fs.writeFileSync(writer, WRITER);
    const convert = (bytes: Uint8Array) => {
      fs.writeFileSync(input, bytes);
      const result = spawnSync(process.env.CORPUS_PANDOC_PATH || "pandoc", [
        "--sandbox", "--from=epub", `--to=${writer}`, "--wrap=none", input,
      ], { encoding: "utf8", timeout: 120_000, maxBuffer: 128 * 1024 * 1024, cwd: directory });
      if (result.error || result.status !== 0) {
        const reason = result.error?.message || result.stderr.trim().slice(0, 2000) || `exit ${result.status}`;
        throw new Error(`Pandoc EPUB extraction failed: ${reason}. Install Pandoc >= 3.1 or set CORPUS_PANDOC_PATH.`);
      }
      const parsed = JSON.parse(result.stdout) as {
        version: string; document: PandocDocument; locations: { text: string; heading: number }[]; blockTexts: string[];
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
      if (!Array.isArray(parsed.blockTexts) || parsed.blockTexts.some((t) => typeof t !== "string")) {
        throw new Error("Pandoc returned an invalid block text map.");
      }
      return { ...parsed, warnings: result.stderr.trim().slice(0, 8000) };
    };
    let parsed = convert(data);
    const navigation = new EpubNavigation(data);
    let mapped = mapPandocNavigation(parsed.document, parsed.blockTexts, navigation.spine);
    let preprocessedTargets = false;
    let warnings = parsed.warnings;
    for (const rewritten of navigation.preprocess(mapped)) {
      const next = convert(rewritten.data);
      if (next.version !== parsed.version || JSON.stringify(next.locations) !== JSON.stringify(parsed.locations)) {
        throw new EpubNavigationError("target preprocessing changed readable text or location boundaries.");
      }
      parsed = next;
      mapped = mapPandocNavigation(parsed.document, parsed.blockTexts, navigation.spine);
      navigation.assertResolved(rewritten.target, mapped);
      preprocessedTargets = true;
      warnings = [...new Set([warnings, parsed.warnings].filter(Boolean))].join("\n");
    }
    const outline = navigation.outline(mapped);
    const pages = parsed.locations.map(({ text }, index) => ({ index, label: null, paragraphs: [text], separatorBefore: index ? "\n\n" : "" }));
    return { reflowable: true, outline, pages, document: parsed.document, pandocVersion: parsed.version,
      pandocAdapterVersion: PANDOC_ADAPTER_VERSION, preprocessedTargets, auxiliaryCovers: navigation.auxiliaryCovers,
      ...(warnings ? { pandocWarnings: warnings } : {}) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
