import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import type { OutlineEntry } from "./extract.js";
import type { PandocDocument } from "./pandoc.js";

export class EpubNavigationError extends Error {
  constructor(message: string) { super(`EPUB navigation: ${message}`); this.name = "EpubNavigationError"; }
}
type Xml = Record<string, unknown> & { ":@"?: Record<string, string> };
const xmlOptions = { preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", trimValues: false,
  parseTagValue: false, htmlEntities: true, commentPropName: "#comment" };
const name = (node: Xml) => Object.keys(node).find((k) => k !== ":@" && !/^[?#]/.test(k)) ?? "";
const local = (node: Xml) => name(node).split(":").at(-1)!;
const children = (node: Xml): Xml[] => Array.isArray(node[name(node)]) ? node[name(node)] as Xml[] : [];
const attr = (node: Xml, key: string) => Object.entries(node[":@"] ?? {}).find(([k]) => k.split(":").at(-1) === key)?.[1];
const text = (node: Xml): string => node["#text"] !== undefined ? String(node["#text"]) : children(node).map(text).join("");
const label = (node: Xml) => text(node).replace(/\s+/g, " ").trim();
function descendants(nodes: Xml[], tag: string): Xml[] {
  return nodes.flatMap((n) => [...(local(n) === tag ? [n] : []), ...descendants(children(n), tag)]);
}
function parseXml(source: string, metadata = false): Xml[] {
  if (metadata && XMLValidator.validate(source) !== true) throw new EpubNavigationError("invalid navigation/package XML.");
  try { return new XMLParser(xmlOptions).parse(source) as Xml[]; }
  catch { throw new EpubNavigationError("could not parse an XML resource."); }
}
interface Target { file: string; fragment: string }
interface Entry { title: string; target: Target | null; children: Entry[] }
interface SpineFile { file: string; basename: string }
interface Anchor { file: string | null; location: number | null }
export interface AuxiliaryCover {
  file: string;
  evidence: "guide" | "body-type" | "declared-image";
}
export interface PandocNavigationMap {
  anchors: Map<string, Anchor[]>;
  files: Map<string, { start: number; end: number }>;
}
function href(base: string, value: string): Target {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) throw new EpubNavigationError("external table-of-contents target.");
  const hash = value.indexOf("#"), rawFile = hash < 0 ? value : value.slice(0, hash);
  let file: string, fragment: string;
  try {
    const decoded = decodeURIComponent(rawFile);
    if (/[?\\]/.test(decoded) || decoded.startsWith("/")) throw new Error();
    file = decoded ? path.posix.normalize(path.posix.join(path.posix.dirname(base), decoded)) : base;
    fragment = hash < 0 ? "" : decodeURIComponent(value.slice(hash + 1));
  } catch { throw new EpubNavigationError("invalid table-of-contents URI."); }
  if (!file || file === ".." || file.startsWith("../")) throw new EpubNavigationError("target escapes the EPUB archive.");
  return { file, fragment };
}

/** Only package/navigation metadata is interpreted here. Pandoc remains the content reader/writer. */
export class EpubNavigation {
  readonly spine: SpineFile[];
  readonly auxiliaryCovers: AuxiliaryCover[] = [];
  private readonly nonReadingCovers = new Set<string>();
  private readonly entries: Entry[];
  private readonly resources = new Map<string, string>();
  constructor(private readonly data: Uint8Array) {
    const root = descendants(parseXml(this.read("META-INF/container.xml"), true), "rootfile")
      .find((n) => attr(n, "media-type") === "application/oebps-package+xml");
    const packageFile = attr(root ?? {}, "full-path");
    if (!packageFile) throw new EpubNavigationError("missing package document.");
    const pkg = parseXml(this.read(href("", packageFile).file), true);
    const manifest = descendants(pkg, "manifest")[0], spine = descendants(pkg, "spine")[0];
    if (!manifest || !spine) throw new EpubNavigationError("missing manifest or reading spine.");
    const items = children(manifest).filter((n) => local(n) === "item");
    const byId = new Map(items.map((n) => [attr(n, "id"), n]));
    if (byId.has(undefined) || byId.size !== items.length) throw new EpubNavigationError("missing or duplicate manifest ID.");
    this.spine = children(spine).filter((n) => local(n) === "itemref" && attr(n, "linear") !== "no").flatMap((ref) => {
      const item = byId.get(attr(ref, "idref"));
      if (!item) throw new EpubNavigationError("missing spine manifest item.");
      if (!["application/xhtml+xml", "text/html"].includes(attr(item, "media-type") ?? "")) return [];
      const file = href(packageFile, attr(item, "href") ?? "").file;
      return [{ file, basename: path.posix.basename(file) }];
    });
    if (new Set(this.spine.map((s) => s.basename)).size !== this.spine.length) {
      throw new EpubNavigationError("ambiguous repeated spine basename.");
    }
    const navItems = items.filter((n) => (attr(n, "properties") ?? "").split(/\s+/).includes("nav"));
    if (navItems.length > 1) throw new EpubNavigationError("multiple navigation documents.");
    let entries: Entry[] | undefined;
    if (navItems.length) {
      const file = href(packageFile, attr(navItems[0], "href") ?? "").file;
      const tocs = descendants(parseXml(this.read(file), true), "nav").filter((n) => (attr(n, "type") ?? "").split(/\s+/).includes("toc"));
      if (tocs.length > 1) throw new EpubNavigationError("multiple toc navigation trees.");
      if (tocs.length) {
        const lists = children(tocs[0]).filter((n) => local(n) === "ol");
        if (lists.length !== 1) throw new EpubNavigationError("missing or ambiguous toc list.");
        entries = this.navList(lists[0], file);
      }
    }
    if (!entries) {
      const toc = attr(spine, "toc"), ncxItems = items.filter((n) => attr(n, "media-type") === "application/x-dtbncx+xml");
      if ((toc && !byId.has(toc)) || (!toc && ncxItems.length > 1)) throw new EpubNavigationError("missing or ambiguous NCX manifest item.");
      const ncx = toc ? byId.get(toc) : ncxItems[0];
      if (ncx) {
        const file = href(packageFile, attr(ncx, "href") ?? "").file;
        const maps = descendants(parseXml(this.read(file), true), "navMap");
        if (maps.length !== 1) throw new EpubNavigationError("missing or ambiguous NCX navMap.");
        const points = (nodes: Xml[]): Entry[] => nodes.filter((n) => local(n) === "navPoint").map((node) => {
          const content = children(node).find((n) => local(n) === "content"), src = content && attr(content, "src");
          const title = children(node).find((n) => local(n) === "navLabel");
          if (!src || !title || !label(title)) throw new EpubNavigationError("incomplete NCX entry.");
          return { title: label(title), target: href(file, src), children: points(children(node)) };
        });
        entries = points(children(maps[0]));
      }
    }
    this.entries = entries ?? [];
    if (entries && !entries.length) throw new EpubNavigationError("empty table of contents.");
    const targets = this.targets();
    const targetFiles = new Set(targets.map((t) => t.file));
    const coverImages = new Set(items.filter((item) => (attr(item, "properties") ?? "").split(/\s+/).includes("cover-image"))
      .map((item) => href(packageFile, attr(item, "href") ?? "").file));
    for (const meta of descendants(pkg, "meta")) {
      if (attr(meta, "name") !== "cover") continue;
      const item = byId.get(attr(meta, "content"));
      if (item && attr(item, "href")) coverImages.add(href(packageFile, attr(item, "href")!).file);
    }
    const guideCovers = new Set(descendants(pkg, "reference").filter((ref) => attr(ref, "type") === "cover" && attr(ref, "href"))
      .map((ref) => href(packageFile, attr(ref, "href")!)).filter((t) => !t.fragment).map((t) => t.file));
    for (const ref of children(spine).filter((n) => local(n) === "itemref" && attr(n, "linear") === "no")) {
      const item = byId.get(attr(ref, "idref"));
      if (!item || !["application/xhtml+xml", "text/html"].includes(attr(item, "media-type") ?? "")) continue;
      const file = href(packageFile, attr(item, "href") ?? "").file;
      if (!targetFiles.has(file) || this.spine.some((s) => s.file === file) || this.nonReadingCovers.has(file)) continue;
      const bodies = descendants(parseXml(this.read(file)), "body");
      if (bodies.length !== 1) continue;
      const body = bodies[0];
      let evidence: AuxiliaryCover["evidence"] | undefined;
      if (guideCovers.has(file)) evidence = "guide";
      else if ((attr(body, "type") ?? "").split(/\s+/).includes("cover")) evidence = "body-type";
      else {
        const images = [...descendants(children(body), "img"), ...descendants(children(body), "image")];
        if (!text(body).trim() && images.length && images.every((image) => {
          const src = attr(image, "src") ?? attr(image, "href");
          return !!src && coverImages.has(href(file, src).file);
        })) evidence = "declared-image";
      }
      if (evidence) { this.nonReadingCovers.add(file); this.auxiliaryCovers.push({ file, evidence }); }
    }
    // A dropped duplicate ID must not make a different retained occurrence look unique.
    const fragments = targets.filter((t) => t.fragment);
    for (const file of new Set(fragments.map((t) => t.file))) {
      const wanted = new Set(fragments.filter((t) => t.file === file).map((t) => t.fragment));
      const counts = new Map<string, number>();
      const count = (nodes: Xml[]) => {
        for (const node of nodes) {
          const ids = new Set([attr(node, "id"), ...(local(node) === "a" ? [attr(node, "name")] : [])]);
          for (const id of ids) if (id && wanted.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
          count(children(node));
        }
      };
      count(parseXml(this.read(file)));
      for (const id of wanted) if (counts.get(id) !== 1) throw new EpubNavigationError(`missing or duplicate source target ${file}#${id}.`);
    }
  }
  private read(file: string): string {
    if (!this.resources.has(file)) {
      const bytes = unzipSync(this.data, { filter: (entry) => entry.name === file })[file];
      if (!bytes) throw new EpubNavigationError(`missing resource ${file}.`);
      this.resources.set(file, strFromU8(bytes));
    }
    return this.resources.get(file)!;
  }
  private navList(list: Xml, base: string): Entry[] {
    return children(list).filter((n) => local(n) === "li").map((node) => {
      const nested = children(node).filter((n) => local(n) === "ol");
      const labels = children(node).filter((n) => ["a", "span"].includes(local(n)));
      if (labels.length !== 1 || nested.length > 1 || !label(labels[0])) throw new EpubNavigationError("incomplete or ambiguous toc entry.");
      const link = local(labels[0]) === "a" ? attr(labels[0], "href") : undefined;
      return { title: label(labels[0]), target: link === undefined ? null : href(base, link), children: nested.flatMap((n) => this.navList(n, base)) };
    });
  }
  private targets(): Target[] {
    const walk = (entries: Entry[]): Target[] => entries.flatMap((e) => [...(e.target ? [e.target] : []), ...walk(e.children)]);
    return walk(this.entries);
  }
  private locate(target: Target, map: PandocNavigationMap): number | null {
    const source = this.spine.find((s) => s.file === target.file);
    if (!source) throw new EpubNavigationError(`target is outside the linear XHTML spine: ${target.file}.`);
    const range = map.files.get(target.file);
    if (!range || range.start === range.end) throw new EpubNavigationError(`target spine file has no readable location: ${target.file}.`);
    if (!target.fragment) return range.start;
    const keys = new Set([source.basename, encodeURI(source.basename), encodeURIComponent(source.basename)].map((s) => `${s}#${target.fragment}`));
    const matches = [...new Set([...keys].flatMap((key) => map.anchors.get(key) ?? []))];
    if (!matches.length) return null;
    if (matches.length !== 1 || matches[0].file !== target.file || matches[0].location === null) {
      throw new EpubNavigationError(`ambiguous or misplaced target ${target.file}#${target.fragment}.`);
    }
    const location = matches[0].location;
    if (location < range.start || location >= range.end) throw new EpubNavigationError("target lies outside its spine file.");
    return location;
  }
  /** Yield one targeted rewrite at a time. Each must recover its anchor with identical location
   * text before the caller asks for the next; changes cannot cancel each other out. */
  *preprocess(map: PandocNavigationMap): Generator<{ data: Uint8Array; target: Target }> {
    const unique = new Map(this.targets().map((target) => [JSON.stringify(target), target]));
    const missing = [...unique.values()].filter((target) => !this.nonReadingCovers.has(target.file) && this.locate(target, map) === null);
    if (!missing.length) return;
    const archive = unzipSync(this.data);
    for (const file of new Set(missing.map((t) => t.file))) {
      const tree = parseXml(this.read(file));
      for (const target of missing.filter((t) => t.file === file)) {
        const all = (nodes: Xml[]): Xml[] => nodes.flatMap((n) => [n, ...all(children(n))]);
        const matches = all(tree).filter((n) => attr(n, "id") === target.fragment || (local(n) === "a" && attr(n, "name") === target.fragment));
        if (matches.length !== 1) throw new EpubNavigationError(`missing or duplicate source target ${file}#${target.fragment}.`);
        const node = matches[0], attrs = node[":@"]!;
        const tag = local(node);
        for (const key of Object.keys(attrs)) if (key.split(":").at(-1) === "id" || (local(node) === "a" && key === "name")) delete attrs[key];
        if (["p", "td", "th"].includes(tag)) {
          node[name(node)] = [{ span: [], ":@": { id: target.fragment } }, ...children(node)];
        } else {
          // Use inline wrappers for inline/void targets, block wrappers for block targets.
          // Never insert a span as a child of ul/table/pre or a div into a paragraph.
          const wrapped = { ...node };
          for (const key of Object.keys(node)) delete node[key];
          node[["img", "a", "br", "input"].includes(tag) ? "span" : "div"] = [wrapped];
          node[":@"] = { id: target.fragment };
        }
        archive[file] = strToU8(new XMLBuilder(xmlOptions).build(tree));
        yield { data: zipSync(archive), target };
      }
    }
  }
  assertResolved(target: Target, map: PandocNavigationMap): void {
    if (this.locate(target, map) === null) throw new EpubNavigationError(`unresolved target after preprocessing: ${target.file}#${target.fragment}.`);
  }
  outline(map: PandocNavigationMap): OutlineEntry[] {
    const result: OutlineEntry[] = [];
    const walk = (entries: Entry[], parents: string[]) => {
      for (const entry of entries) {
        const ord = result.length, trail = [...parents, entry.title];
        const auxiliary = entry.target && this.nonReadingCovers.has(entry.target.file);
        const start = entry.target && !auxiliary ? this.locate(entry.target, map) : null;
        if (entry.target && !auxiliary && start === null) throw new EpubNavigationError(`unresolved target ${entry.target.file}#${entry.target.fragment}.`);
        result.push({ ord, title: entry.title, level: parents.length, path: trail.join(" › "), startPage: start });
        walk(entry.children, trail);
        if (!entry.target) {
          const subtree = result.slice(ord + 1);
          if (!subtree.length) throw new EpubNavigationError("unlinked toc group has no child.");
          result[ord].startPage = subtree.find((child) => child.startPage !== null)?.startPage ?? null;
        }
      }
    };
    walk(this.entries, []);
    return result;
  }
}

/** Map AST identifiers onto the exact blocks serialized by the Lua writer, including invisible
 * file markers. No empty anchor is allowed to borrow a location from the following spine file. */
export function mapPandocNavigation(document: PandocDocument, blockTexts: string[], spine: readonly SpineFile[]): PandocNavigationMap {
  const anchors = new Map<string, Anchor[]>(), files: PandocNavigationMap["files"] = new Map();
  const byName = new Map(spine.map((s) => [s.basename, s.file]));
  let file: string | null = null, leaf = 0, location = 0;
  const record = (id: string, at: number | null, owner = file) => {
    if (!id) return;
    const anchor = { file: owner, location: at }, keys = new Set([id]);
    const hash = id.indexOf("#");
    if (hash >= 0) {
      try { keys.add(`${decodeURIComponent(id.slice(0, hash))}${id.slice(hash)}`); } catch { /* Preserve literal IDs. */ }
    }
    for (const key of keys) { const found = anchors.get(key) ?? []; found.push(anchor); anchors.set(key, found); }
  };
  type Node = { t: string; c?: unknown };
  const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && "t" in v;
  const identifier = (node: Node): string => {
    if (!Array.isArray(node.c)) return "";
    const attrs = node.t === "Header" ? node.c[1]
      : ["Div", "Span", "Code", "CodeBlock", "Link", "Image", "Table", "Figure"].includes(node.t) ? node.c[0] : null;
    return Array.isArray(attrs) && typeof attrs[0] === "string" ? attrs[0] : "";
  };
  const allIds = (value: unknown, at: number | null) => {
    if (isNode(value)) { record(identifier(value), at); allIds(value.c, at); }
    else if (Array.isArray(value)) value.forEach((v) => allIds(v, at));
  };
  const collect = (blocks: unknown[]) => {
    for (const value of blocks) {
      if (!isNode(value)) throw new EpubNavigationError("invalid Pandoc block.");
      const contents = value.c;
      if (value.t === "Div" && Array.isArray(contents) && Array.isArray(contents[1])) {
        const start = location, owner = file;
        collect(contents[1]);
        record(identifier(value), location > start && owner === file ? start : null, owner);
        continue;
      }
      const plain = blockTexts[leaf++];
      if (typeof plain !== "string") throw new EpubNavigationError("Pandoc block/text mapping differs.");
      const span = value.t === "Para" && Array.isArray(contents) && contents.length === 1 ? contents[0] : null;
      const id = isNode(span) && span.t === "Span" && Array.isArray(span.c) && Array.isArray(span.c[1]) && !span.c[1].length ? identifier(span) : "";
      const candidates = new Set([byName.get(id)]);
      try { candidates.add(byName.get(decodeURIComponent(id))); } catch { /* Literal marker. */ }
      candidates.delete(undefined);
      if (candidates.size > 1) throw new EpubNavigationError("ambiguous encoded spine basename.");
      if (id && candidates.size) {
        if (plain !== "") throw new EpubNavigationError("spine marker unexpectedly contains text.");
        if (file) files.get(file)!.end = location;
        file = [...candidates][0]!;
        if (files.has(file)) throw new EpubNavigationError("repeated Pandoc spine marker.");
        files.set(file, { start: location, end: location });
      } else {
        const readable = /[^ \f\n\r\t\v]/.test(plain); // Match Lua's %S, including preserved Unicode spaces.
        allIds(value, readable ? location : null);
        if (readable) location++;
      }
    }
  };
  collect(document.blocks);
  if (file) files.get(file)!.end = location;
  if (files.size !== spine.length) throw new EpubNavigationError("missing Pandoc spine marker.");
  if (leaf !== blockTexts.length) throw new EpubNavigationError("unmatched Pandoc block text.");
  return { anchors, files };
}
