import { expect, it } from "vitest";
import { contentFindings, epubProfile, pdfProfile, type BookContents } from "../src/duplicate-contents.js";
import { makePdf, makeShapedEpub as makeEpub } from "./fixtures.js";

it("profiles an EPUB's text, navigation, print pages, links and images, leaving markup and its navigation out of the words", () => {
  // Words: the text, "don’t stop", the link numbers and "external".
  expect(epubProfile(makeEpub({ words: 500, images: 3, toc: 12, pages: 40, links: 7 }))).toEqual({
    words: 500 + 2 + 7 + 1, contents: 12, page_list: 40, links: 7, sample: false, images: 3, image_bytes: 3 * 2048, font_bytes: 0, text_bytes: expect.any(Number),
  });
  expect(epubProfile(makeEpub({ ncxPages: 25 })).page_list).toBe(25);
  expect(epubProfile(makeEpub({ ending: "You’ve reached the end of this free sample." })).sample).toBe(true);
  expect(epubProfile(makeEpub({ ending: "A sample of soil was taken." })).sample).toBe(false);
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
  expect(fewer.content_warnings.map(w => [w.measure, w.against])).toEqual([["words", ["a"]], ["contents", ["b"]], ["links", ["b"]]]);
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
