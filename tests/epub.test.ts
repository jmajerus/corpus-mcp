import { expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { extractBook } from "../src/extract.js";
import { extractEpubSourcePages } from "../src/epub.js";
import { sourceStyles } from "../src/epub-css.js";
import { makeEpub } from "./fixtures.js";

const preview = (data: Uint8Array) => extractBook(data, "epub", { epubParagraphs: "source" });
const book = (body: string, css?: string) => makeEpub("Structure", [{ title: "Chapter", paragraphs: [], body, css }]);

it("joins visual lines by their source paragraph, regardless of punctuation or capitalization", () => {
  const paragraph = "Curiosity about daily facts, about daily things, about daily men. It is the most respectable faculty of the human mind. ".repeat(4).trim();
  const data = book(`<h1>Heading</h1><p>${paragraph}</p><p>lowercase next paragraph without punctuation</p>`,
    "p { margin: 0; line-height: 1.7; text-indent: 1em; }");
  const old = extractBook(data, "epub");
  expect(old.pages[0].paragraphs.length).toBeGreaterThan(3);
  const result = preview(data);
  expect(result.pages).toHaveLength(old.pages.length);
  expect(result.outline).toEqual(old.outline);
  expect(result.pages[0].paragraphs).toEqual(["Heading", paragraph, "lowercase next paragraph without punctuation"]);
});

it("separates source paragraphs even when layout groups them into one block", () => {
  const result = preview(book("<p>First paragraph</p><p>second paragraph</p><p>Third paragraph.</p>", "p { margin: 0; }")).pages;
  expect(result[0].paragraphs).toEqual(["First paragraph", "second paragraph", "Third paragraph."]);
});

it("preserves inline text, entities, anchors, and real hyphens", () => {
  const data = book('<p>One <em>emphasized</em> phrase <a id="page"/> and an <a href="#page">inline link</a>, well-known &amp; useful.</p><p>A dis&#173;cretionary hyphen.</p>');
  expect(preview(data).pages[0].paragraphs).toEqual([
    "One emphasized phrase and an inline link, well-known & useful.", "A discretionary hyphen.",
  ]);
});

it.each(["normal", "pre-line"])("preserves non-breaking Unicode spaces with white-space: %s", (mode) => {
  const data = book('<p>A&nbsp;B &#x202F; C\t \nD</p>', `p {white-space:${mode}}`);
  expect(preview(data).pages[0].paragraphs).toEqual([mode === "normal" ? "A\u00a0B \u202f C D" : "A\u00a0B \u202f C\nD"]);
});

it("trims ordinary paragraph edges independently of preserved inline descendants", () => {
  const data = book('<p>   Before <span style="white-space:pre">  code  </span> after   </p>');
  expect(preview(data).pages[0].paragraphs).toEqual(["Before   code   after"]);
});

it("keeps default block boundaries for details, summary, and fieldsets", () => {
  expect(preview(book('<details><summary>Summary</summary>Details</details><fieldset><legend>Legend</legend>Field</fieldset>')).pages[0].paragraphs)
    .toEqual(["Summary", "Details", "Legend", "Field"]);
});

it.each(["pre", "pre-line", "pre-wrap", "break-spaces"])("refuses lost significant whitespace in %s text", (mode) => {
  const layout = {
    resolveLink: () => 0, countPages: () => 1,
    loadPage: () => ({ destroy() {}, toStructuredText: () => ({ asText: () => "First second", destroy() {} }) }),
  } as unknown as Parameters<typeof extractEpubSourcePages>[1];
  expect(() => extractEpubSourcePages(book(`<p style="white-space:${mode}">First\nsecond</p>`), layout)).toThrow(/Significant EPUB whitespace/);
});

it("refuses significant whitespace whose location ownership is ambiguous", () => {
  const layout = {
    resolveLink: () => 0, countPages: () => 2,
    loadPage: (index: number) => ({ destroy() {}, toStructuredText: () => ({ asText: () => index ? "second" : "First\n", destroy() {} }) }),
  } as unknown as Parameters<typeof extractEpubSourcePages>[1];
  expect(() => extractEpubSourcePages(book('<pre>First\nsecond</pre>'), layout)).toThrow(/whitespace crosses locations/);
  expect(() => preview(book('<pre>   </pre>'))).toThrow(/Whitespace-only preserved/);
});

it("keeps explicit verse line breaks, separate stanzas, and preformatted indentation", () => {
  const result = preview(book("<h2>A poem</h2><p>First line<br/>Second line<br/><br/>Third line</p><p>Another stanza<br/>Last line</p><pre>    first code line\n      second code line</pre>"));
  expect(result.pages[0].paragraphs).toEqual([
    "A poem", "First line\nSecond line\n\nThird line", "Another stanza\nLast line", "    first code line\n      second code line",
  ]);
});

it("keeps default list items and headings distinct", () => {
  const result = preview(book("<h1>List</h1><ul><li><p>First item</p></li><li>Second item</li></ul><ol><li>First numbered</li><li>Second numbered</li></ol>"));
  expect(result.pages[0].paragraphs).toEqual(["List", "• First item", "• Second item", "1. First numbered", "2. Second numbered"]);
});

it("splits a long source paragraph across existing locations without losing or duplicating words", () => {
  const text = Array.from({ length: 900 }, (_, n) => `word${n}`).join(" ");
  const data = makeEpub("Long", [{ title: "First", paragraphs: [text, "Next paragraph."] }, { title: "Second", paragraphs: ["Another chapter."] }]);
  const old = extractBook(data, "epub"), result = preview(data);
  expect(result.pages.length).toBeGreaterThan(2);
  expect(result.pages.map((p) => p.index)).toEqual(old.pages.map((p) => p.index));
  expect(result.outline).toEqual(old.outline);
  const fragments = result.pages.flatMap((p) => p.paragraphs);
  expect(fragments.join(" ").replace(/\s+/g, " ")).toBe(`First ${text} Next paragraph. Second Another chapter.`);
  expect(fragments).toContain("Next paragraph.");
  expect(fragments).toContain("Another chapter.");
});

it("uses the OPF spine order, rather than ZIP or manifest order", () => {
  const files = unzipSync(makeEpub("Spine", [{ title: "One", paragraphs: ["First."] }, { title: "Two", paragraphs: ["Second."] }]));
  files["OEBPS/content.opf"] = strToU8(strFromU8(files["OEBPS/content.opf"]).replace('<itemref idref="c1"/><itemref idref="c2"/>', '<itemref idref="c2"/><itemref idref="c1"/>'));
  expect(preview(zipSync(files)).pages.flatMap((p) => p.paragraphs)).toEqual(["Two", "Second.", "One", "First."]);
});

it("refuses source/layout disagreement instead of guessing or silently falling back", () => {
  const corruptLayout = {
    resolveLink: () => 0, countPages: () => 1,
    loadPage: () => ({ destroy() {}, toStructuredText: () => ({ asText: () => "Different text.", destroy() {} }) }),
  } as unknown as Parameters<typeof extractEpubSourcePages>[1];
  expect(() => extractEpubSourcePages(book("<p>Original text.</p>"), corruptLayout)).toThrow(/source\/layout mismatch/);
});

it("preserves CSS whitespace semantics even when character alignment alone would match", () => {
  expect(preview(book('<p style="white-space:pre-line">Line one\nLine two</p>')).pages[0].paragraphs).toEqual(["Line one\nLine two"]);
  expect(preview(book("<p>Line one\nLine two</p>", "p { white-space: pre-line; }")).pages[0].paragraphs).toEqual(["Line one\nLine two"]);
});

it("uses CSS flow overrides for boundaries and omits hidden source text", () => {
  expect(preview(book('<span style="display:block">One line</span><span>Another line</span>')).pages[0].paragraphs).toEqual(["One line", "Another line"]);
  expect(preview(book('<p>First </p><p>second</p><p style="display:none">Hidden.</p>', "p { display: inline; }")).pages[0].paragraphs).toEqual(["First second"]);
});

it("applies the author cascade, inheritance, source order, and important precedence", () => {
  const data = book('<div class="verse"><p id="poem" class="line" style="white-space:normal">Line one\nLine two</p></div>',
    '.verse {white-space:pre-line} p {white-space:normal!important} #poem {white-space:pre-line!important} .line {white-space:normal!important}');
  const styles = sourceStyles([{ href: "style.css", css: '.verse {white-space:pre-line} p {white-space:normal!important} #poem {white-space:pre-line!important} .line {white-space:normal!important}' }], () => { throw new Error("unexpected import"); });
  expect(styles({ name: "p", attrs: { id: "poem", class: "line", style: "white-space:normal" }, children: [] }).whiteSpace).toBe("pre-line");
  // MuPDF's cascade disagrees with this important rule, so source extraction must refuse it.
  expect(() => preview(data)).toThrow(/Significant EPUB whitespace/);
  expect(preview(book('<div style="white-space:pre-line"><span>First\nsecond</span></div>')).pages[0].paragraphs).toEqual(["First\nsecond"]);
});

it("loads only linked stylesheets and resolves their imports relative to each stylesheet", () => {
  const files = unzipSync(book('<div class="verse">First\nsecond</div>'));
  files["OEBPS/ch1.xhtml"] = strToU8(strFromU8(files["OEBPS/ch1.xhtml"]).replace("</head>", '<link rel="stylesheet" href="css/main.css"/></head>'));
  files["OEBPS/css/main.css"] = strToU8('@import "nested/verse.css"; .verse {display:block}');
  files["OEBPS/css/nested/verse.css"] = strToU8('.verse {white-space:pre-line}');
  files["OEBPS/unused.css"] = strToU8('.verse {display:grid}');
  const styles = sourceStyles([{ href: "OEBPS/css/main.css", css: '@import "nested/verse.css"; .verse {display:block}' }], (base, relative) => {
    expect(base).toBe("OEBPS/css/main.css"); expect(relative).toBe("nested/verse.css");
    return { href: "OEBPS/css/nested/verse.css", css: '.verse {white-space:pre-line}' };
  });
  expect(styles({ name: "div", attrs: { class: "verse" }, children: [] }).whiteSpace).toBe("pre-line");
  // The source cascade resolves the import, but MuPDF omits its newline in the rendered stream.
  expect(() => preview(zipSync(files))).toThrow(/Significant EPUB whitespace/);
});

it("refuses unsupported matched or conditional layout rules, but permits unused rules", () => {
  expect(() => preview(book('<div>Text</div>', 'div {display:grid}'))).toThrow(/Unsupported EPUB display/);
  expect(() => preview(book('<p>Text</p>', '@media print {p {white-space:pre}}'))).toThrow(/Conditional EPUB CSS/);
  expect(preview(book('<p>Text</p>', '.absent {display:grid}')).pages[0].paragraphs).toEqual(["Text"]);
});

it("reads XHTML self-closing elements without swallowing the body", () => {
  const files = unzipSync(book('<p>Text <a id="empty"/>after the empty anchor.</p>'));
  files["OEBPS/ch1.xhtml"] = strToU8(strFromU8(files["OEBPS/ch1.xhtml"]).replace("<title>Chapter</title>", "<title/>"));
  expect(preview(zipSync(files)).pages[0].paragraphs).toEqual(["Text after the empty anchor."]);
});

it("aligns ligatures and combining marks without changing source spelling", () => {
  expect(preview(book("<p>Cafe\u0301 with a \ufb01ne view.</p>")).pages[0].paragraphs).toEqual(["Cafe\u0301 with a \ufb01ne view."]);
});

it("rejects the EPUB-only preview option for other formats", () => {
  expect(() => extractBook(new Uint8Array(), "pdf", { epubParagraphs: "source" })).toThrow(/only supported for EPUB/);
});
