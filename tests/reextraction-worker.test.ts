import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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

it("accounts for unset extractor versions in controller outcomes and held books", () => {
  const root = tempDir(), project = fileURLToPath(new URL("../", import.meta.url));
  try {
    fs.symlinkSync(path.join(project, "node_modules"), path.join(root, "node_modules"), "dir");
    const backend = path.join(root, "backend.mjs");
    fs.writeFileSync(backend, `export function stageUnanchoredCandidateBook({ book }) {
      return { book, status: "refused", reason: "Fixture refusal; book kept unchanged." };
    }`);
    const db = new Database(path.join(root, "corpus.db"));
    const data = new Database(path.join(root, "data.db"));
    let before;
    try {
      db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
        INSERT INTO meta VALUES('epub_source_preview','inspection-only');
        CREATE TABLE books(id TEXT,uuid TEXT,format TEXT,status TEXT,extractor_version INTEGER,file_size INTEGER);`);
      const insert = db.prepare("INSERT INTO books VALUES(?,?,?,?,?,?)");
      [
        ["unset", "unset", "epub", "indexed", null, 1],
        ["legacy1", "legacy1", "epub", "indexed", 1, 2],
        ["legacy2", "legacy2", "epub", "indexed", 2, 3],
        ["current", "current", "epub", "indexed", 3, 4],
        ["anchored-unset", "anchored", "epub", "indexed", null, 5],
        ["quoted-unset", "quoted", "epub", "indexed", null, 6],
        ["pdf", "pdf", "pdf", "indexed", null, 7],
        ["failed", "failed", "epub", "failed", null, 8],
      ].forEach(row => insert.run(...row));
      data.exec(`CREATE TABLE anchors(calibre_uuid TEXT); INSERT INTO anchors VALUES('anchored');
        CREATE TABLE quotes(calibre_uuid TEXT); INSERT INTO quotes VALUES('quoted');`);
      before = db.prepare("SELECT * FROM books ORDER BY id").all();
    } finally { db.close(); data.close(); }
    const savedBefore = fs.readFileSync(path.join(root, "data.db"));
    const run = spawnSync(process.execPath, [path.join(project, "tools/reextract-unanchored-epubs.mjs"),
      "--candidate", root, "--books-root", root, "--backend", backend], { encoding: "utf8", timeout: 15_000 });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const outcomes = fs.readFileSync(path.join(root, "books.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(outcomes.map(book => [book.book, book.status])).toEqual([
      ["unset", "refused"], ["legacy1", "refused"], ["legacy2", "refused"],
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(root, "progress.json"), "utf8"))).toMatchObject({
      total: 3, completed: 3, staged: 0, refused: 3, heldForConsumer: ["anchored-unset", "quoted-unset"],
      promotionReady: false, finished: expect.any(String),
    });
    const checked = new Database(path.join(root, "corpus.db"), { readonly: true });
    try { expect(checked.prepare("SELECT * FROM books ORDER BY id").all()).toEqual(before); }
    finally { checked.close(); }
    expect(fs.readFileSync(path.join(root, "data.db"))).toEqual(savedBefore);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
