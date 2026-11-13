import { expect, it } from "vitest";
import path from "node:path";
import { contentFindings, contentProfile, epubProfile, pdfProfile, textOverlap, type BookContents } from "../src/duplicate-contents.js";
import { makePdf, makeShapedEpub as makeEpub } from "./fixtures.js";

it("profiles an EPUB's text, navigation, print pages, links and images, leaving markup and its navigation out of the words", () => {
  // Words: the text, "don’t stop", the link numbers, "external" and the last chapter's "The end".
  expect(epubProfile(makeEpub({ words: 500, images: 3, toc: 12, pages: 40, links: 7 }))).toEqual({
    words: 500 + 2 + 7 + 1 + 2, contents: 12, page_list: 40, links: 7, sample: false, images: 3, image_bytes: 3 * 2048, font_bytes: 0,
    text_bytes: expect.any(Number), sketch: expect.any(Array),
  });
  expect(epubProfile(makeEpub({ ncxPages: 25 })).page_list).toBe(25);
});

it("reads sample wording only at the end of the reading order", () => {
  expect(epubProfile(makeEpub({ ending: "You’ve reached the end of this free sample." })).sample).toBe(true);
  expect(epubProfile(makeEpub({ ending: "A sample of soil was taken." })).sample).toBe(false);
  // A chapter that quotes a store's pitch is not the book's ending (and comes later in the archive than the ending).
  expect(epubProfile(makeEpub({ quote: "The ad said: buy the full book now." })).sample).toBe(false);
});

it("estimates shared text from sketches: the same text whatever its markup, none between different texts", () => {
  const a = epubProfile(makeEpub({ words: 3000, images: 1 })), b = epubProfile(makeEpub({ words: 3000, images: 9, links: 50 }));
  expect(textOverlap(a.sketch, b.sketch)).toBeGreaterThan(0.95);
  expect(textOverlap(a.sketch, epubProfile(makeEpub({ words: 3000, vocabulary: "other" })).sketch)).toBe(0);
  expect(textOverlap(a.sketch, [])).toBeNull();
  expect(a.sketch).toHaveLength(256);
});

it("reports a catalogued file missing from the mirror as unreadable", () => {
  expect(contentProfile(path.join(import.meta.dirname, "no-such-book.epub"), "EPUB")).toEqual({ error: "The EPUB is missing from the mirror or cannot be read (ENOENT)." });
});

it("profiles a PDF's pages, text layer, bookmarks and printed page numbers", () => {
  const pdf = makePdf({ pages: [["One two three four five six seven eight nine ten eleven"], [], ["Twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone"]],
    labels: [[0, "r", 1]], outline: [{ title: "Start", page: 1 }, { title: "End", page: 3 }] });
  expect(pdfProfile(pdf)).toMatchObject({ pages: 3, text_pages: 2, words: 21, contents: 2, page_labels: true, sample: false });
});

const epub = (o: Parameters<typeof makeEpub>[0]) => ({ EPUB: epubProfile(makeEpub(o)) }) as BookContents;

it("names the copy that falls short, and why, and keeps a size gap only where the contents differ", () => {
  const full = epub({ words: 2000, images: 40, toc: 20, pages: 300, links: 120 });
  const f = contentFindings([{ id: "main:100", contents: epub({ words: 2000, images: 1, toc: 20, links: 120 }) }, { id: "main:783", contents: full }],
    ["EPUB sizes differ 18.5×: …"]);
  expect(f.content_warnings.map(w => [w.measure, w.against])).toEqual([["page_list", ["main:100"]], ["images", ["main:100"]]]);
  expect(f.content_warnings[1].message).toBe("main:100’s EPUB has 1 image; main:783’s has 40: figures may be missing.");
  expect(f.size_warnings).toEqual(["EPUB sizes differ 18.5×: …"]);

  const fewer = contentFindings([{ id: "a", contents: epub({ words: 1000, toc: 20, links: 60 }) }, { id: "b", contents: epub({ words: 2000, toc: 0, links: 10 }) }], []);
  // Half its text missing: a has fewer words, and shares only about half of b's passages.
  expect(fewer.content_warnings.map(w => [w.measure, w.copy, w.against])).toEqual([["words", "a", ["a"]], ["contents", "b", ["b"]], ["links", "b", ["b"]], ["text", "a", []]]);
  expect(fewer.content_warnings[1].message).toBe("b’s EPUB has no table of contents; a’s has 20 entries.");
});

it("explains a size gap between copies with the same text and structure, instead of warning", () => {
  const f = contentFindings([{ id: "a", contents: epub({ images: 2, pages: 300 }) }, { id: "b", contents: epub({ images: 3, pages: 300 }) }], ["EPUB sizes differ by 17%: …"]);
  expect(f.content_warnings).toEqual([]);
  expect(f.size_warnings).toEqual([]);
  expect(f.content_notes).toEqual(["EPUB sizes differ, but the text and structure match. Images: a 4 KB, b 6 KB; markup: a 19 KB, b 19 KB."]);
});

it("keeps the size warning when a copy cannot be read, and flags a sample", () => {
  const f = contentFindings([{ id: "a", contents: { EPUB: { error: "Could not read the EPUB: bad zip" } } }, { id: "b", contents: epub({ ending: "End of sample" }) }],
    ["EPUB sizes differ by 40%: …"]);
  expect(f.content_warnings.map(w => [w.measure, w.against])).toEqual([["error", ["a"]], ["sample", ["b"]]]);
  expect(f.size_warnings).toEqual(["EPUB sizes differ by 40%: …"]);
});

it("warns at exactly 5% fewer words", () => {
  // 995 and 945 words of text, plus 5 more in each copy: 1,000 and 950.
  const f = contentFindings([{ id: "a", contents: epub({ words: 995 }) }, { id: "b", contents: epub({ words: 945 }) }], []);
  expect(f.content_warnings.filter(w => w.measure === "words").map(w => w.message)).toEqual(["b’s EPUB has 5% fewer words than a’s (950 vs 1,000): it may be missing chapters, be abridged, or be another edition."]);
});

it("keeps the size warning, and warns, when copies with the same counts have different texts", () => {
  const f = contentFindings([{ id: "a", contents: epub({}) }, { id: "b", contents: epub({ vocabulary: "other" }) }], ["EPUB sizes differ by 20%: …"]);
  expect(f.content_warnings.map(w => [w.measure, w.copy, w.against])).toEqual([["text", "b", []]]);
  expect(f.content_warnings[0].message).toBe("b’s and a’s EPUB texts share only about 0% of their passages: they may be different editions, translations or books.");
  expect(f.content_notes).toEqual([]);
  expect(f.size_warnings).toEqual(["EPUB sizes differ by 20%: …"]);
  expect(f.content_overlap).toEqual({ EPUB: { reference: "a", shared: { b: 0 } } });
});
