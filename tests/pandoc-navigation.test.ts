import { expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { extractPandocEpub } from "../src/pandoc.js";
import { EpubNavigation } from "../src/epub-navigation.js";
import { makeEpub } from "./fixtures.js";
import { sectionPaths } from "../src/extract.js";

function edit(data: Uint8Array, change: (files: ReturnType<typeof unzipSync>) => void): Uint8Array {
  const files = unzipSync(data); change(files); return zipSync(files);
}
function nav(data: Uint8Array, body: string) {
  return edit(data, (files) => { files["OEBPS/nav.xhtml"] = strToU8(strFromU8(files["OEBPS/nav.xhtml"]).replace(/<body>[\s\S]*<\/body>/, `<body>${body}</body>`)); });
}
function target(body: string, fragment = "target") {
  return nav(makeEpub("Targets", [{ title: "Chapter", paragraphs: [], body }]),
    `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="ch1.xhtml#${fragment}">Navigation title</a></li></ol></nav>`);
}

function auxiliaryCover(evidence: "guide" | "body" | "image" | "legacy-image" | "unknown") {
  return edit(makeEpub("Auxiliary", [{ title: "Cover", paragraphs: [],
    body: evidence === "body" ? '<div><img src="cover.png" alt="Cover"/></div>' : '<p><img src="cover.png" alt="Cover"/></p>' },
    { title: "Chapter", paragraphs: ["Primary chapter words."] }]), (files) => {
    let opf = strFromU8(files["OEBPS/content.opf"]).replace('<itemref idref="c1"/>', '<itemref idref="c1" linear="no"/>');
    if (evidence === "guide") opf = opf.replace("</package>", '<guide><reference type="cover" href="ch1.xhtml"/></guide></package>');
    if (evidence === "body") files["OEBPS/ch1.xhtml"] = strToU8(strFromU8(files["OEBPS/ch1.xhtml"])
      .replace("<body>", '<body xmlns:epub="http://www.idpf.org/2007/ops" epub:type="cover">'));
    if (["image", "legacy-image"].includes(evidence)) {
      opf = opf.replace("</manifest>", `<item id="cover-image" href="cover.png" media-type="image/png"${evidence === "image" ? ' properties="cover-image"' : ""}/></manifest>`);
      if (evidence === "legacy-image") opf = opf.replace("</metadata>", '<meta name="cover" content="cover-image"/></metadata>');
      files["OEBPS/cover.png"] = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk3sAAAAASUVORK5CYII=", "base64");
    }
    files["OEBPS/content.opf"] = strToU8(opf);
  });
}

it.each([['guide', 'guide'], ['body', 'body-type'], ['image', 'declared-image'], ['legacy-image', 'declared-image']] as const)(
  "retains a confirmed auxiliary cover using %s evidence without a reading location", (kind, evidence) => {
    const book = extractPandocEpub(auxiliaryCover(kind));
    expect(book.outline).toMatchObject([{ title: "Cover", startPage: null }, { title: "Chapter", startPage: expect.any(Number) }]);
    expect(book.auxiliaryCovers).toEqual([{ file: "OEBPS/ch1.xhtml", evidence }]);
    const chapter = book.outline[1].startPage!;
    expect(sectionPaths(book.outline, book.pages.length)[chapter]).toBe("Chapter");
    expect(book.pages[chapter].paragraphs).toEqual(["Chapter"]);
  });

it("does not exempt an unconfirmed auxiliary document based on its cover label", () => {
  expect(() => extractPandocEpub(auxiliaryCover("unknown"))).toThrow(/outside the linear XHTML spine/);
});

it("keeps missing primary chapter targets deferred when an auxiliary cover is recognized", () => {
  const data = edit(auxiliaryCover("guide"), (files) => {
    files["OEBPS/nav.xhtml"] = strToU8(strFromU8(files["OEBPS/nav.xhtml"]).replace('href="ch2.xhtml"', 'href="missing.xhtml"'));
  });
  expect(() => extractPandocEpub(data)).toThrow(/outside the linear XHTML spine/);
});

it("keeps a missing auxiliary cover resource deferred despite its guide declaration", () => {
  const data = edit(auxiliaryCover("guide"), (files) => { delete files["OEBPS/ch1.xhtml"]; });
  expect(() => extractPandocEpub(data)).toThrow(/missing resource/);
});

it("keeps a broken auxiliary cover fragment deferred", () => {
  const data = edit(auxiliaryCover("guide"), (files) => {
    files["OEBPS/nav.xhtml"] = strToU8(strFromU8(files["OEBPS/nav.xhtml"]).replace('href="ch1.xhtml"', 'href="ch1.xhtml#missing"'));
  });
  expect(() => extractPandocEpub(data)).toThrow(/missing or duplicate source target/);
});

it("starts a TOC group on its first reading child after an auxiliary cover", () => {
  const data = nav(auxiliaryCover("guide"), '<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><span>Book</span><ol><li><a href="ch1.xhtml">Cover</a></li><li><a href="ch2.xhtml">Chapter</a></li></ol></li></ol></nav>');
  const outline = extractPandocEpub(data).outline;
  expect(outline[0].startPage).toBe(outline[2].startPage);
  expect(outline[1].startPage).toBeNull();
});

it("uses navigation labels and nesting, excludes landmarks/page-list, and maps containing locations", () => {
  const data = nav(makeEpub("Contents", [{ title: "Different body heading", paragraphs: [],
    body: '<p>Introduction.</p><h2 id="chapter">Body heading</h2><p>Chapter words.</p>' }]), `
    <nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="page-list"><ol><li><a href="missing.xhtml">Page 1</a></li></ol></nav>
    <nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><span>Part one</span><ol>
    <li><a href="ch1.xhtml#chapter">Named chapter</a></li></ol></li></ol></nav>
    <nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="landmarks"><ol><li><a href="missing.xhtml">Body</a></li></ol></nav>`);
  expect(extractPandocEpub(data).outline).toEqual([
    { ord: 0, level: 0, title: "Part one", path: "Part one", startPage: 1 },
    { ord: 1, level: 1, title: "Named chapter", path: "Part one › Named chapter", startPage: 1 },
  ]);
});

it("maps a heading-free file to its first readable block without emitting its empty marker", () => {
  const book = extractPandocEpub(makeEpub("Plain", [{ title: "Named chapter", paragraphs: [], body: "<p>Plain chapter.</p>" }]));
  expect(book.pages).toHaveLength(1);
  expect(book.outline).toMatchObject([{ title: "Named chapter", startPage: 0 }]);
  expect(book.preprocessedTargets).toBe(false);
});

it.each([
  ["div", '<div id="target"><p>Words.</p></div>'],
  ["section", '<section id="target"><p>Words.</p></section>'],
  ["span", '<p>Before <span id="target">words.</span></p>'],
  ["li", '<ul><li id="target">Words.</li></ul>'],
  ["pre", '<pre id="target"><code>one\n  two</code></pre>'],
])("retains an existing %s target without preprocessing", (_, body) => {
  const book = extractPandocEpub(target(body));
  expect(book.preprocessedTargets).toBe(false);
  expect(book.outline[0].startPage).toBe(0);
});

it.each([
  ["p", '<p id="target">Words.</p>'],
  ["hr", '<hr id="target"/><p>Words.</p>'],
  ["blockquote", '<blockquote id="target"><p>Words.</p></blockquote>'],
  ["ul", '<ul id="target"><li>Words.</li></ul>'],
  ["ol", '<ol id="target"><li>Words.</li></ol>'],
  ["table", '<table id="target"><tr><td>Words.</td></tr></table>'],
  ["td", '<table><tr><td id="target">Words.</td></tr></table>'],
  ["figure", '<figure id="target"><p>Words.</p></figure>'],
  ["img", '<p>Before <img id="target" src="missing.png" alt="Image"/> after.</p>'],
])("recovers a missing %s target while requiring identical text and locations", (_, body) => {
  const data = target(body), original = data.slice(), before = extractPandocEpub(makeEpub("Targets", [{ title: "Chapter", paragraphs: [], body }]));
  const book = extractPandocEpub(data);
  expect(book.preprocessedTargets).toBe(true);
  expect(book.pages).toEqual(before.pages);
  expect(book.outline[0].startPage).toBe(0);
  expect(data).toEqual(original);
});

it("reads NCX nesting when no toc nav is advertised and ignores NCX page lists", () => {
  const data = edit(makeEpub("NCX", [{ title: "First", paragraphs: ["First content."] }, { title: "Second", paragraphs: ["Second content."] }]), (files) => {
    files["OEBPS/content.opf"] = strToU8(strFromU8(files["OEBPS/content.opf"]).replace('properties="nav"', "")
      .replace("</manifest>", '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>')
      .replace("<spine>", '<spine toc="ncx">'));
    files["OEBPS/toc.ncx"] = strToU8(`<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
      <navPoint><navLabel><text>First label</text></navLabel><content src="ch1.xhtml"/>
        <navPoint><navLabel><text>Second label</text></navLabel><content src="ch2.xhtml"/></navPoint>
      </navPoint></navMap><pageList><pageTarget><content src="missing.xhtml"/></pageTarget></pageList></ncx>`);
  });
  expect(extractPandocEpub(data).outline).toMatchObject([
    { title: "First label", path: "First label", level: 0, startPage: 0 },
    { title: "Second label", path: "First label › Second label", level: 1, startPage: 2 },
  ]);
});

it("defers a missing target even when another entry and a body heading resolve", () => {
  const data = nav(makeEpub("Partial", [{ title: "Chapter", paragraphs: ["Words."] }]), `
    <nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol>
      <li><a href="ch1.xhtml">Good</a></li><li><a href="ch1.xhtml#missing">Missing</a></li>
    </ol></nav>`);
  expect(() => extractPandocEpub(data)).toThrow(/missing or duplicate source target/);
});

it("defers malformed navigation rather than accepting a partially parsed outline", () => {
  const data = nav(makeEpub("Malformed", [{ title: "Chapter", paragraphs: ["Words."] }]),
    '<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="ch1.xhtml">Chapter</a></ol></nav>');
  expect(() => extractPandocEpub(data)).toThrow(/invalid navigation\/package XML/);
});

it("defers an empty file rather than borrowing a location from the next file", () => {
  const data = makeEpub("Empty", [{ title: "Empty chapter", paragraphs: [], body: "" },
    { title: "Readable chapter", paragraphs: ["Words."] }]);
  expect(() => extractPandocEpub(data)).toThrow(/no readable location/);
});

it("defers an empty in-file anchor rather than attaching it to unrelated following text", () => {
  expect(() => extractPandocEpub(target('<div id="target"></div><p>Following text.</p>'))).toThrow(/ambiguous or misplaced/);
});

it("defers duplicate source targets even if Pandoc retains only one of them", () => {
  expect(() => extractPandocEpub(target('<p id="target">Dropped ID.</p><p><span id="target">Retained ID.</span></p>')))
    .toThrow(/duplicate source target/);
});

it("checks each target rewrite separately, including repeated TOC links to one target", () => {
  const data = nav(makeEpub("Several", [{ title: "Chapter", paragraphs: [], body: '<p id="one">One.</p><p id="two">Two.</p>' }]), `
    <nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol>
      <li><a href="ch1.xhtml#one">First</a></li><li><a href="ch1.xhtml#two">Second</a></li>
      <li><a href="ch1.xhtml#one">First again</a></li></ol></nav>`);
  const book = extractPandocEpub(data);
  expect(book.outline.map((e) => e.startPage)).toEqual([0, 1, 0]);
  expect(book.pages.map((p) => p.paragraphs)).toEqual([["One."], ["Two."]]);
});

it("maps retained anchors nested in compound blocks to the containing location", () => {
  const book = extractPandocEpub(target('<blockquote><p>Intro.</p><h2 id="target">Nested heading</h2><p>After.</p></blockquote>'));
  expect(book.pages).toHaveLength(1);
  expect(book.outline[0].startPage).toBe(0);
  expect(book.preprocessedTargets).toBe(false);
});

it("defers repeated spine basenames", () => {
  const data = edit(makeEpub("Collision", [{ title: "One", paragraphs: ["One."] }, { title: "Two", paragraphs: ["Two."] }]), (files) => {
    for (const [index, directory] of [[1, "a"], [2, "b"]] as const) {
      files[`OEBPS/${directory}/shared.xhtml`] = files[`OEBPS/ch${index}.xhtml`]; delete files[`OEBPS/ch${index}.xhtml`];
      for (const file of ["OEBPS/content.opf", "OEBPS/nav.xhtml"]) files[file] = strToU8(strFromU8(files[file]).replaceAll(`ch${index}.xhtml`, `${directory}/shared.xhtml`));
    }
  });
  expect(() => extractPandocEpub(data)).toThrow(/repeated spine basename/);
});

it("rejects an anchor placed in a different spine file", () => {
  const data = makeEpub("Owner", [{ title: "One", paragraphs: ["One."] },
    { title: "Two", paragraphs: [], body: '<p><span id="target">Two.</span></p>' }]);
  const navigation = new EpubNavigation(nav(data, '<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="ch2.xhtml#target">Two</a></li></ol></nav>'));
  expect(() => navigation.outline({ files: new Map([["OEBPS/ch1.xhtml", { start: 0, end: 1 }], ["OEBPS/ch2.xhtml", { start: 1, end: 2 }]]),
    anchors: new Map([["ch2.xhtml#target", [{ file: "OEBPS/ch1.xhtml", location: 0 }]]]) })).toThrow(/misplaced/);
});

it("handles URI-encoded spine filenames and target fragments", () => {
  const data = edit(target('<p><span id="target space">Words.</span></p>', "target%20space"), (files) => {
    files["OEBPS/part one.xhtml"] = files["OEBPS/ch1.xhtml"]; delete files["OEBPS/ch1.xhtml"];
    for (const file of ["OEBPS/content.opf", "OEBPS/nav.xhtml"]) files[file] = strToU8(strFromU8(files[file]).replaceAll("ch1.xhtml", "part%20one.xhtml"));
  });
  expect(extractPandocEpub(data).outline[0].startPage).toBe(0);
});
