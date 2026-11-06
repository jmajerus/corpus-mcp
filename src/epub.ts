import { strFromU8, unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type * as mupdf from "mupdf";
import type { ExtractedPage } from "./extract.js";
import { sourceStyles, type Sheet, type SourceStyle } from "./epub-css.js";

export interface SourceNode {
  name: string;
  attrs: Record<string, string>;
  children: SourceNode[];
  text?: string;
  parent?: SourceNode;
}

function sourceTree(html: string): SourceNode {
  const valid = XMLValidator.validate(html);
  if (valid !== true) throw new Error(`Invalid EPUB XHTML: ${valid.err.msg}`);
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "",
    removeNSPrefix: true, parseTagValue: false, trimValues: false, htmlEntities: true });
  const root: SourceNode = { name: "", attrs: {}, children: [] };
  const convert = (nodes: Record<string, unknown>[], parent: SourceNode): SourceNode[] => nodes.map((raw) => {
    const name = Object.keys(raw).find((key) => key !== ":@")!;
    const node: SourceNode = { name, attrs: (raw[":@"] ?? {}) as Record<string, string>, children: [], parent };
    if (name === "#text") node.text = String(raw[name]);
    else if (Array.isArray(raw[name])) node.children = convert(raw[name] as Record<string, unknown>[], node);
    return node;
  });
  root.children = convert(parser.parse(html), root);
  return root;
}
interface Paragraph { text: string; pre: boolean; whitespace: { start: number; end: number }[] }
interface Chapter { href: string; paragraphs: Paragraph[] }

const OMIT = new Set(["head", "script", "style", "template"]);
const attr = (node: SourceNode, name: string) => node.attrs[name];

function sourceParagraphs(html: string, href: string, read: (name: string) => string): Paragraph[] {
  const tree = sourceTree(html);
  const sheets: Sheet[] = [];
  const collect = (node: SourceNode) => {
    const conditional = !!node.attrs.media && node.attrs.media.trim() !== "all";
    if (node.name === "style") sheets.push({ href: `${href}#style${sheets.length}`, css: node.children.map((n) => n.text ?? "").join(""), conditional });
    if (node.name === "link" && (!node.attrs.type || node.attrs.type.toLowerCase() === "text/css") && /(?:^|\s)stylesheet(?:\s|$)/i.test(node.attrs.rel ?? "") && node.attrs.href) {
      const path = archivePath(href, node.attrs.href);
      sheets.push({ href: path, css: read(path), conditional });
    }
    node.children.forEach(collect);
  };
  collect(tree);
  const styleFor = sourceStyles(sheets, (base, relative) => {
    const path = archivePath(base, relative);
    return { href: path, css: read(path) };
  });
  const paragraphs: Paragraph[] = [];
  let current = "", preserved = false, labelOnly = false, trailingCollapsible = false;
  let whitespace: Paragraph["whitespace"] = [];
  const append = (text: string, mode: string) => {
    // CSS only collapses document whitespace, not NBSP or other Unicode space separators.
    const required = ["pre", "pre-wrap", "break-spaces"].includes(mode) ? /\s+/gu
      : mode === "pre-line" ? /\n+|[^\S \t\r\n\f]+/gu : /[^\S \t\r\n\f]+/gu;
    for (const match of text.matchAll(required)) whitespace.push({ start: current.length + match.index!, end: current.length + match.index! + match[0].length });
    current += text;
  };
  const flush = (keepLabel = false) => {
    if (keepLabel && labelOnly) return;
    const text = trailingCollapsible ? current.slice(0, -1) : current;
    if (text.trim()) paragraphs.push({ text, pre: preserved, whitespace });
    else if (preserved && text) throw new Error("Whitespace-only preserved EPUB content cannot be mapped to locations.");
    current = "";
    preserved = false;
    labelOnly = false;
    trailingCollapsible = false;
    whitespace = [];
  };
  const walk = (node: SourceNode, inherited?: SourceStyle) => {
    if (node.name === "#text") {
      const text = node.text!.replace(/\u00ad/g, "");
      if (text.trim()) labelOnly = false;
      const mode = inherited?.whiteSpace ?? "normal";
      if (["pre", "pre-wrap", "break-spaces"].includes(mode)) {
        append(text, mode); preserved = true;
        if (text) trailingCollapsible = false;
      } else {
        let normalized = mode === "pre-line" ? text.replace(/[ \t\f]+/g, " ").replace(/ *\r?\n */g, "\n")
          : text.replace(/[ \t\r\n\f]+/g, " ");
        if (!current || trailingCollapsible || current.endsWith("\n")) normalized = normalized.replace(/^ /, "");
        if (normalized.startsWith("\n") && trailingCollapsible) current = current.slice(0, -1);
        append(normalized, mode);
        if (normalized) trailingCollapsible = normalized.endsWith(" ");
        if (mode === "pre-line") preserved = true;
      }
      return;
    }
    if (OMIT.has(node.name)) return;
    const style = styleFor(node, inherited);
    if (style.display === "none") return;
    // This MuPDF EPUB renderer substitutes an inline SVG with this literal placeholder. Alignment
    // below verifies that behavior; a renderer that supports SVG text will require a different path.
    if (node.name === "svg") { current += "[image]"; return; }
    if (node.name === "br") {
      if (trailingCollapsible) current = current.slice(0, -1);
      append("\n", "pre-line"); trailingCollapsible = false; preserved = true; return;
    }
    const block = !["inline", "inline-block", "table-cell"].includes(style.display);
    if (block) flush(true);
    if (style.display === "list-item" && style.listType !== "none") {
      // MuPDF renders default list labels as text. Non-default CSS labels fail alignment below.
      const parent = node.parent;
      if (style.listType === "decimal" && parent) {
        const items = parent.children.filter((n) => n.name === "li");
        let number = Number(attr(parent, "start") ?? 1) - 1;
        for (const item of items) {
          number = Number(attr(item, "value") ?? number + 1);
          if (item === node) break;
        }
        current += `${number}. `;
      } else {
        const marker = { disc: "•", circle: "○", square: "■" }[style.listType];
        if (!marker) throw new Error(`Unsupported EPUB list marker: ${style.listType}`);
        current += `${marker} `;
      }
      labelOnly = true; trailingCollapsible = true;
    }
    for (const child of node.children) walk(child, style);
    if (style.display === "table-cell") { current += "\t"; trailingCollapsible = true; }
    if (block) flush();
  };
  walk(tree);
  flush();
  return paragraphs;
}

function archivePath(base: string, href: string): string {
  const url = new URL(href, `https://epub.invalid/${base}`);
  if (url.origin !== "https://epub.invalid") throw new Error(`External EPUB spine resource: ${href}`);
  return decodeURIComponent(url.pathname.slice(1));
}

function readSpine(data: Uint8Array): Chapter[] {
  const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });
  const resources = new Map<string, string>();
  const read = (name: string): string => {
    if (resources.has(name)) return resources.get(name)!;
    const entry = unzipSync(data, { filter: (file) => file.name === name })[name];
    if (!entry) throw new Error(`Missing EPUB resource: ${name}`);
    const text = strFromU8(entry);
    resources.set(name, text);
    return text;
  };
  const container = xml.parse(read("META-INF/container.xml"));
  const roots = [container.container?.rootfiles?.rootfile].flat().filter(Boolean);
  const root = roots.find((r) => r["@_media-type"] === "application/oebps-package+xml") ?? roots[0];
  const packagePath = root?.["@_full-path"];
  if (!packagePath) throw new Error("EPUB container has no package document.");
  const pkg = xml.parse(read(packagePath)).package;
  const manifest = [pkg?.manifest?.item].flat().filter(Boolean);
  const spine = [pkg?.spine?.itemref].flat().filter(Boolean);
  if (!spine.length) throw new Error("EPUB package has no reading spine.");
  const chapters: Chapter[] = [];
  for (const ref of spine) {
    const item = manifest.find((m) => m["@_id"] === ref["@_idref"]);
    if (!item?.["@_href"]) throw new Error(`Missing EPUB spine item: ${ref["@_idref"]}`);
    if (item["@_media-type"] !== "application/xhtml+xml" && item["@_media-type"] !== "text/html") {
      throw new Error(`Unsupported EPUB source spine media type: ${item["@_media-type"]}`);
    }
    const href = archivePath(packagePath, item["@_href"]);
    chapters.push({ href, paragraphs: sourceParagraphs(read(href), href, read) });
  }
  return chapters;
}

/** Match characters, ignoring layout whitespace, discretionary hyphens, and font ligatures. */
function canonical(text: string): string {
  return text.normalize("NFKC").replace(/[\s\u00ad]/gu, "");
}

interface SourceText extends Paragraph { canonical: string; offsets: number[]; ends: number[] }
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
function sourceText({ text, pre, whitespace }: Paragraph): SourceText {
  let normalized = "";
  const offsets: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const norm = canonical(segment);
    normalized += norm;
    for (let i = 0; i < norm.length; i++) { offsets.push(index); ends.push(index + segment.length); }
  }
  offsets.push(text.length);
  return { text, pre, whitespace, canonical: normalized, offsets, ends };
}

function lowerBound(values: number[], target: number): number {
  let left = 0, right = values.length;
  while (left < right) { const middle = (left + right) >>> 1; if (values[middle] < target) left = middle + 1; else right = middle; }
  return left;
}

/**
 * Experimental EPUB extraction. Source markup supplies paragraphs/explicit line breaks; MuPDF
 * supplies the existing location boundaries. Every chapter must match character-for-character
 * after documented normalization. Never guess, skip unmatched text, or fall back to layout blocks.
 */
export function extractEpubSourcePages(data: Uint8Array, doc: mupdf.Document): ExtractedPage[] {
  const chapters = readSpine(data);
  const starts = chapters.map((c) => doc.resolveLink(c.href));
  const count = doc.countPages();
  if (starts[0] !== 0 || starts.some((s, i) => s < 0 || (i > 0 && s <= starts[i - 1]))) {
    throw new Error("EPUB source spine cannot be mapped unambiguously to MuPDF locations.");
  }
  const pages: ExtractedPage[] = [];
  for (let chapter = 0; chapter < chapters.length; chapter++) {
    const { href, paragraphs } = chapters[chapter];
    const source = paragraphs.map(sourceText);
    const expected = source.map((p) => p.canonical).join("");
    const gaps = new Map<number, string[]>();
    let sourceAt = 0;
    for (const p of source) {
      for (const span of p.whitespace) {
        const position = sourceAt + Math.min(lowerBound(p.offsets, span.end), p.canonical.length);
        const parts = gaps.get(position) ?? [];
        parts.push(p.text.slice(span.start, span.end)); gaps.set(position, parts);
      }
      sourceAt += p.canonical.length;
    }
    let at = 0, paragraph = 0, within = 0;
    const end = starts[chapter + 1] ?? count;
    for (let index = starts[chapter]; index < end; index++) {
      const page = doc.loadPage(index);
      let renderedText: SourceText;
      try {
        // No dehyphenate: retain real source hyphens. Discretionary soft hyphens normalize away.
        const text = page.toStructuredText("preserve-whitespace");
        try { renderedText = sourceText({ text: text.asText(), pre: false, whitespace: [] }); } finally { text.destroy(); }
      } finally { page.destroy(); }
      const rendered = renderedText.canonical;
      if (!expected.startsWith(rendered, at)) {
        let mismatch = 0;
        while (mismatch < rendered.length && expected[at + mismatch] === rendered[mismatch]) mismatch++;
        throw new Error(`EPUB source/layout mismatch in ${href}, location ${index + 1}, character ${at + mismatch}: expected ${JSON.stringify(expected.slice(at + mismatch, at + mismatch + 24))}, rendered ${JSON.stringify(rendered.slice(mismatch, mismatch + 24))}.`);
      }
      // Character alignment alone would accept lost indentation, spaces, or explicit line breaks.
      // Require significant source gaps to survive in the raw rendered text. A gap crossing a
      // location cannot be assigned reliably, so refuse it rather than guessing its ownership.
      for (const [position, parts] of gaps) {
        if (position < at || position > at + rendered.length) continue;
        if ((position === at && position !== 0) || (position === at + rendered.length && position !== expected.length)) {
          throw new Error(`Significant EPUB whitespace crosses locations in ${href}, location ${index + 1}.`);
        }
        const relative = position - at;
        const begin = relative === 0 ? 0 : renderedText.ends[relative - 1];
        const finish = relative === rendered.length ? renderedText.text.length : renderedText.offsets[relative];
        const actual = renderedText.text.slice(begin, finish);
        let cursor = 0;
        for (const part of parts) {
          const found = actual.indexOf(part, cursor);
          if (found < 0) throw new Error(`Significant EPUB whitespace differs from layout in ${href}, location ${index + 1}.`);
          cursor = found + part.length;
        }
        gaps.delete(position);
      }
      at += rendered.length;
      let remaining = rendered.length;
      const fragments: string[] = [];
      while (remaining > 0 && paragraph < source.length) {
        const p = source[paragraph];
        const take = Math.min(remaining, p.canonical.length - within);
        // A page boundary must not split the expansion of one source character (e.g. a ligature).
        if (within + take < p.canonical.length && p.offsets[within + take] === p.offsets[within + take - 1]) {
          throw new Error(`EPUB location splits a source character in ${href}, location ${index + 1}.`);
        }
        const from = within === 0 ? 0 : p.ends[within - 1];
        const to = within + take === p.canonical.length ? p.text.length : p.ends[within + take - 1];
        const raw = p.text.slice(from, to);
        const fragment = p.pre ? raw : raw.replace(/^[ \t]+|[ \t]+$/g, "");
        if (fragment) fragments.push(fragment);
        within += take;
        remaining -= take;
        if (within === p.canonical.length) { paragraph++; within = 0; }
      }
      pages.push({ index, label: null, paragraphs: fragments });
    }
    if (at !== expected.length) throw new Error(`EPUB source has unmatched text in ${href} after location ${end}.`);
    if (gaps.size) throw new Error(`Significant EPUB whitespace cannot be mapped in ${href}.`);
  }
  return pages;
}
