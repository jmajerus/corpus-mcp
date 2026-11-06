import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { openDataStore } from "../src/data.js";
import { scanLibraries } from "../src/indexer.js";
import { stageEpubReextraction, stageUnanchoredCandidateBook } from "../src/reextraction.js";
import { pagesOf, locate } from "../src/quotes.js";
import { storeAnchor, type Anchor } from "../src/anchors.js";
import type { Config } from "../src/config.js";
import type { Corpus } from "../src/tools.js";
import { makeEpub, makeLibrary, tempDir } from "./fixtures.js";

it("restricts workers to inspection candidates and unanchored books, preserving source databases", async () => {
  const root = tempDir();
  makeLibrary(root, "main", [
    { id: 1, title: "Words", files: { epub: makeEpub("Words", [{ title: "Chapter", paragraphs: ["A unique passage to preserve."] }]) } },
    { id: 2, title: "Empty", files: { epub: makeEpub("Empty", [{ title: "Empty", paragraphs: [], body: "" }]) } },
  ]);
  const config = { booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", citekeyPreset: "author-year-word" } as Config;
  const db = openDatabase(config.dbPath), data = openDataStore(config.dataDbPath);
  try {
    scanLibraries(config, db);
    const before = pagesOf(db, "main:1", 0, 100);
    expect(() => stageUnanchoredCandidateBook({ candidate: root, booksRoot: root, book: "main:1" })).toThrow(/inspection-only/);
    const candidate = path.join(root, "candidate");
    await stageEpubReextraction({ index: config.dbPath, data: config.dataDbPath, output: candidate, booksRoot: root, books: ["main:2"] });
    expect(stageUnanchoredCandidateBook({ candidate, booksRoot: root, book: "main:1" })).toMatchObject({ status: "staged", pandocAdapterVersion: 3 });
    expect(pagesOf(db, "main:1", 0, 100)).toEqual(before);
    expect(data.prepare("SELECT count(*) FROM anchors").pluck().get()).toBe(0);
    const next = openDatabase(path.join(candidate, "corpus.db")), nextData = openDataStore(path.join(candidate, "data.db"));
    try {
      const pages = pagesOf(next, "main:1", 0, 100);
      const found = locate(pages, "A unique passage to preserve.")!;
      const hash = next.prepare("SELECT sha256 FROM books WHERE id='main:1'").pluck().get() as string;
      const anchor: Anchor = { ...found, calibre_uuid: "uuid-1", sha256: hash, page_label: null, end_page_label: null, section: "Chapter" };
      expect(storeAnchor({ db: next, data: nextData } as Corpus, { excludeTags: [] }, { quote_id: 99, anchor }).status).toBe(201);
      expect(stageUnanchoredCandidateBook({ candidate, booksRoot: root, book: "main:1" })).toMatchObject({ status: "refused", reason: expect.stringContaining("coordinated consumer") });
      expect(pagesOf(next, "main:1", 0, 100)).toEqual(pages);
      expect(nextData.prepare("SELECT count(*) FROM anchors").pluck().get()).toBe(1);
    } finally { next.close(); nextData.close(); }
  } finally { db.close(); data.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
