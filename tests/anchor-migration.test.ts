import { expect, it } from "vitest";
import { planAnchorMigration } from "../src/anchor-migration.js";
import { CONTEXT, locate, type PageText, type QuoteAnchor } from "../src/quotes.js";

const pages = (...text: string[]): PageText[] => text.map((text, page_index) => ({ page_index, label: null, section_path: null, text }));
const anchor = (text: string, offset: number, quote: string): QuoteAnchor => ({
  start_page: 0, end_page: 0, start_offset: offset, end_offset: offset + quote.length, text: quote,
  prefix: text.slice(Math.max(0, offset - CONTEXT), offset), suffix: text.slice(offset + quote.length, offset + quote.length + CONTEXT),
});

it("remaps offsets when only extraction whitespace changed, without a changed file hash", () => {
  const old = "An opening\n\nwith broken lines. Target\n\nquote here. End.";
  const next = "An opening with broken lines. Target quote here. End.";
  expect(planAnchorMigration(pages(old), pages(next), anchor(old, old.indexOf("Target"), "Target\n\nquote here."))).toMatchObject({
    status: "remapped", anchor: { start_offset: next.indexOf("Target"), end_offset: next.indexOf(" End."), text: "Target quote here." },
  });
});

it("preserves the selected occurrence of a repeated quote", () => {
  const old = "Repeated words.\n\nBetween them. Repeated words. End.";
  const next = "Repeated words. Between them. Repeated words. End.";
  expect(planAnchorMigration(pages(old), pages(next), anchor(old, old.lastIndexOf("Repeated"), "Repeated words."))).toMatchObject({
    status: "remapped", anchor: { start_offset: next.lastIndexOf("Repeated") },
  });
});

it("maps quotes spanning stable locations and preserves source paragraph breaks", () => {
  const old = pages("Opening.\n\nQuote begins", "and\n\nends here. After.");
  const next = pages("Opening. Quote begins", "and ends here.\n\nAfter.");
  const a: QuoteAnchor = { start_page: 0, start_offset: 10, end_page: 1, end_offset: 15,
    text: "Quote begins\nand\n\nends here.", prefix: "Opening.\n\n", suffix: " After." };
  expect(planAnchorMigration(old, next, a)).toMatchObject({ status: "remapped", anchor: {
    start_page: 0, start_offset: 9, end_page: 1, end_offset: 14, text: "Quote begins\nand ends here.", suffix: "\n\nAfter.",
  } });
});

it("leaves an identical anchor unchanged", () => {
  const text = "First. Quote here. Last.";
  expect(planAnchorMigration(pages(text), pages(text), anchor(text, 7, "Quote here."))).toMatchObject({ status: "unchanged" });
});

it("maps composed, decomposed, ligature, and non-BMP text using complete grapheme boundaries", () => {
  const old = "Before. Cafe\u0301 \ufb01ne \u{1f642}. After.", next = "Before. Café fine \u{1f642}. After.";
  const quote = "Cafe\u0301 \ufb01ne \u{1f642}.";
  expect(planAnchorMigration(pages(old), pages(next), anchor(old, old.indexOf("Cafe"), quote))).toMatchObject({
    status: "remapped", anchor: { text: "Café fine \u{1f642}.", start_offset: next.indexOf("Café"), end_offset: next.indexOf(" After.") },
  });
  expect(locate(pages("Before Cafe\u0301 after."), "Café")).toMatchObject({ text: "Cafe\u0301", start_offset: 7, end_offset: 12 });
});

it("requires review for stale offsets, changed characters, and missing locations", () => {
  const text = "First. Quote here. Last.", a = anchor(text, 7, "Quote here.");
  expect(planAnchorMigration(pages(text), pages(text), { ...a, start_offset: 0 })).toEqual({ status: "review", reason: "stale-old-anchor" });
  expect(planAnchorMigration(pages(text), pages("Changed. Quote here. Last."), a)).toEqual({ status: "review", reason: "location-text-changed" });
  expect(planAnchorMigration(pages(text), [], a)).toEqual({ status: "review", reason: "missing-location" });
});
