import { generate, parse, type CssNode, type Declaration } from "css-tree";
import { compile, type Options } from "css-select";
import { calculate } from "specificity";
import type { SourceNode } from "./epub.js";

export interface Sheet { href: string; css: string; conditional?: boolean }
interface Rule {
  matches: (node: SourceNode) => boolean;
  specificity: number[];
  declarations: Declaration[];
  conditional: boolean;
}
export interface SourceStyle { display: string; whiteSpace: string; listType: string }
const BLOCKS = new Set(["address", "article", "aside", "blockquote", "div", "dl", "dt", "dd", "figcaption", "figure",
  "footer", "header", "h1", "h2", "h3", "h4", "h5", "h6", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "ul", "table", "tr"]);
const TABLE_DISPLAY: Record<string, string> = { table: "table", tr: "table-row", td: "table-cell", th: "table-cell",
  thead: "table-header-group", tbody: "table-row-group", tfoot: "table-footer-group", caption: "table-caption" };
const relevant = (property: string) => ["display", "white-space", "white-space-collapse", "text-wrap-mode", "list-style", "list-style-type", "all"].includes(property);
const isTag = (node: SourceNode): node is SourceNode => !!node.name && !/^[#?]/.test(node.name);
const adapter: NonNullable<Options<SourceNode, SourceNode>["adapter"]> = {
  isTag,
  getAttributeValue: (node, name) => node.attrs[name],
  getChildren: (node) => node.children,
  getName: (node) => node.name,
  getParent: (node) => node.parent ?? null,
  getSiblings: (node) => node.parent?.children ?? [node],
  getText: (node): string => node.text ?? node.children.map(adapter.getText).join(""),
  hasAttrib: (node, name) => Object.hasOwn(node.attrs, name),
  removeSubsets: (nodes) => nodes.filter((node, i) => nodes.indexOf(node) === i && !nodes.some((ancestor) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
    return false;
  })),
};
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** A deliberately limited author cascade: unsupported semantic rules are refused, never ignored. */
export function sourceStyles(sheets: Sheet[], read: (base: string, href: string) => Sheet): (node: SourceNode, inherited?: SourceStyle) => SourceStyle {
  const rules: Rule[] = [];
  const load = (sheet: Sheet, ancestors: Set<string>) => {
    if (ancestors.has(sheet.href)) throw new Error(`Cyclic EPUB CSS import: ${sheet.href}`);
    const chain = new Set([...ancestors, sheet.href]);
    const tree = parse(sheet.css, { onParseError: (error) => { throw new Error(`Invalid EPUB CSS in ${sheet.href}: ${error.message}`); } });
    const visit = (node: CssNode, conditional = !!sheet.conditional) => {
      if (node.type === "StyleSheet" || node.type === "Block") { node.children.forEach((n) => visit(n, conditional)); return; }
      if (node.type === "Atrule") {
        if (node.name.toLowerCase() === "import" && node.prelude?.type === "AtrulePrelude") {
          const children = node.prelude.children.toArray();
          const first = children[0];
          if (first?.type !== "Url" && first?.type !== "String") throw new Error(`Unsupported EPUB CSS import in ${sheet.href}`);
          const imported = read(sheet.href, first.value);
          const media = children.slice(1).map((n) => generate(n)).join("").trim();
          load({ ...imported, conditional: conditional || (!!media && media !== "all") }, chain);
        } else if (node.block && node.name.toLowerCase() !== "font-face") {
          const media = node.prelude ? generate(node.prelude).trim() : "";
          visit(node.block, conditional || node.name.toLowerCase() !== "media" || media !== "all");
        }
        return;
      }
      if (node.type !== "Rule") return;
      const declarations = node.block.children.toArray().filter((n): n is Declaration => n.type === "Declaration" && relevant(n.property.toLowerCase()));
      if (!declarations.length) return;
      if (node.prelude.type !== "SelectorList") throw new Error(`Unsupported EPUB CSS selector in ${sheet.href}`);
      node.prelude.children.forEach((selector) => {
        const text = generate(selector);
        try {
          const { A, B, C } = calculate(text);
          rules.push({ matches: compile(text, { adapter, xmlMode: true }), specificity: [A, B, C], declarations, conditional });
        } catch {
          throw new Error(`Unsupported semantic EPUB CSS selector: ${text}`);
        }
      });
    };
    visit(tree);
  };
  sheets.forEach((sheet) => load(sheet, new Set()));
  return (node, parent) => {
    let listDepth = 0;
    for (let ancestor: SourceNode | undefined = node; ancestor; ancestor = ancestor.parent) if (ancestor.name === "ul") listDepth++;
    const defaults: SourceStyle = {
      display: TABLE_DISPLAY[node.name] ?? (node.name === "li" ? "list-item" : BLOCKS.has(node.name) ? "block" : "inline"),
      whiteSpace: node.name === "pre" ? "pre" : parent?.whiteSpace ?? "normal",
      listType: node.name === "ol" ? "decimal" : node.name === "ul" ? ["disc", "circle", "square"][Math.min(listDepth - 1, 2)] : parent?.listType ?? "disc",
    };
    const winners = new Map<string, { value: string; rank: number[] }>();
    let order = 0;
    const apply = (declaration: Declaration, specificity: number[], inline: number) => {
      const property = declaration.property.toLowerCase();
      const rank = [declaration.important ? 1 : 0, inline, ...specificity, order++];
      if (!winners.has(property) || compare(rank, winners.get(property)!.rank) >= 0) {
        winners.set(property, { value: generate(declaration.value).trim().toLowerCase(), rank });
      }
    };
    for (const rule of rules) if (rule.matches(node)) {
      if (rule.conditional) throw new Error(`Conditional EPUB CSS changes text structure on ${node.name}.`);
      rule.declarations.forEach((declaration) => apply(declaration, rule.specificity, 0));
    }
    if (node.attrs.style) {
      const inline = parse(node.attrs.style, { context: "declarationList", onParseError: (error) => { throw error; } });
      if (inline.type === "DeclarationList") inline.children.forEach((n) => {
        if (n.type === "Declaration" && relevant(n.property.toLowerCase())) apply(n, [0, 0, 0], 1);
      });
    }
    for (const property of ["all", "white-space-collapse", "text-wrap-mode"]) {
      if (winners.has(property)) throw new Error(`Unsupported semantic EPUB CSS property: ${property}`);
    }
    const result = { ...defaults };
    const assign = (property: string, key: keyof SourceStyle, initial: string, inherits: boolean) => {
      const value = winners.get(property)?.value;
      if (!value) return;
      if (value === "inherit" || (value === "unset" && inherits)) result[key] = parent?.[key] ?? initial;
      else if (value === "initial" || value === "unset") result[key] = initial;
      else result[key] = value;
    };
    assign("display", "display", "inline", false);
    assign("white-space", "whiteSpace", "normal", true);
    // Resolve the list-style shorthand and longhand using their original cascade ranks.
    const shorthand = winners.get("list-style");
    if (shorthand && (!winners.has("list-style-type") || compare(shorthand.rank, winners.get("list-style-type")!.rank) >= 0)) {
      const type = shorthand.value.match(/\b(none|disc|circle|square|decimal)\b/)?.[0];
      if (!type || /url\(/.test(shorthand.value)) throw new Error(`Unsupported EPUB list style: ${shorthand.value}`);
      winners.set("list-style-type", { value: type, rank: shorthand.rank });
    }
    assign("list-style-type", "listType", "disc", true);
    if (!["none", "inline", "block", "inline-block", "list-item", "table", "table-row", "table-cell", "table-row-group", "table-header-group", "table-footer-group", "table-caption"].includes(result.display)) {
      throw new Error(`Unsupported EPUB display value: ${result.display}`);
    }
    if (!["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"].includes(result.whiteSpace)) {
      throw new Error(`Unsupported EPUB white-space value: ${result.whiteSpace}`);
    }
    return result;
  };
}
