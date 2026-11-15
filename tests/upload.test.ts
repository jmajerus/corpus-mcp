import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { notYetLogged, openDataStore } from "../src/data.js";
import { openDatabase } from "../src/db.js";
import { epubProfile, profilesSettled } from "../src/duplicate-contents.js";
import { scanLibraries } from "../src/indexer.js";
import { type JobCommands, JobRunner } from "../src/jobs.js";
import { usePdfWorkers } from "../src/pdf-runner.js";
import { Vocabulary } from "../src/vocabulary.js";
import {
  clearStagedUploads,
  listStagedUploads,
  removeStagedUpload,
  stageUpload,
  unzipBounded,
  updateStagedUpload,
  uploadBatchPlan,
  uploadDir,
} from "../src/upload.js";
import { UPLOAD_HTML } from "../src/web/upload.js";
import { makeEpub, makeLibrary, makePdf, tempDir } from "./fixtures.js";

let root: string, config: Config, c: any;
const existingPdf = makePdf({ pages: [["A synthetic book for upload duplicate detection", "Copyright 2021 by Ada Lovelace"]] });
const existingEpub = makeEpub("Unique Existing", [{ title: "One", paragraphs: ["A distinct book already in EPUB."] }]);

/** Build a synthetic PalmDOC/MOBI buffer with optional EXTH metadata and encryption flag. */
function makeMobiBuffer(opts: { title?: string; author?: string; isbn?: string; asin?: string; year?: string; encryption?: number } = {}): Buffer {
  const titleBuf = Buffer.from(opts.title ?? "Mobi Book", "utf8");
  const exthRecords: Buffer[] = [];
  const pushExth = (type: number, value: string) => {
    const valBuf = Buffer.from(value, "utf8");
    const rec = Buffer.alloc(8 + valBuf.length);
    rec.writeUInt32BE(type, 0);
    rec.writeUInt32BE(rec.length, 4);
    valBuf.copy(rec, 8);
    exthRecords.push(rec);
  };
  if (opts.author) pushExth(100, opts.author);
  if (opts.isbn) pushExth(104, opts.isbn);
  if (opts.year) pushExth(106, opts.year);
  if (opts.asin) pushExth(113, opts.asin);
  if (opts.title) pushExth(503, opts.title);

  const exthBody = Buffer.concat(exthRecords);
  const exthLen = exthRecords.length ? 12 + exthBody.length : 0;
  const exthHeader = Buffer.alloc(exthLen);
  if (exthLen) {
    exthHeader.write("EXTH", 0, "latin1");
    exthHeader.writeUInt32BE(exthLen, 4);
    exthHeader.writeUInt32BE(exthRecords.length, 8);
    exthBody.copy(exthHeader, 12);
  }

  const mobiHeaderLen = 232;
  const fullNameOffset = 16 + mobiHeaderLen + exthLen;
  const record0 = Buffer.alloc(fullNameOffset + titleBuf.length);
  record0.writeUInt16BE(opts.encryption ?? 0, 12);
  record0.write("MOBI", 16, "latin1");
  record0.writeUInt32BE(mobiHeaderLen, 20);
  record0.writeUInt32BE(65001, 28); // UTF-8
  record0.writeUInt32BE(fullNameOffset, 84);
  record0.writeUInt32BE(titleBuf.length, 88);
  record0.writeUInt32BE(exthLen ? 0x40 : 0, 128);
  if (exthLen) exthHeader.copy(record0, 16 + mobiHeaderLen);
  titleBuf.copy(record0, fullNameOffset);

  const pdbHeader = Buffer.alloc(96);
  pdbHeader.write("BOOKMOBI", 60, "latin1");
  pdbHeader.writeUInt16BE(1, 76);
  pdbHeader.writeUInt32BE(96, 78);
  return Buffer.concat([pdbHeader, record0]);
}

function makeRichEpub(opts: { title: string; author?: string; year?: string; isbn?: string; asin?: string; text?: string }): Buffer {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="id">${opts.isbn ? `urn:isbn:${opts.isbn}` : "test-id"}</dc:identifier>
  ${opts.asin ? `<dc:identifier>urn:asin:${opts.asin}</dc:identifier>` : ""}
  <dc:title>${opts.title}</dc:title>
  ${opts.author ? `<dc:creator>${opts.author}</dc:creator>` : ""}
  ${opts.year ? `<dc:date>${opts.year}-05-01</dc:date>` : ""}
  <dc:language>en</dc:language>
</metadata>
<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine>
</package>`;
  return Buffer.from(zipSync({
    "mimetype": strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/ch1.xhtml": strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${opts.title}</h1><p>${opts.text ?? "Chapter paragraph words."}</p></body></html>`),
  }));
}

/** A readable EPUB whose folder entries are deflated and empty, as Calibre and some publishers write them. */
function deflatedDirectoryZip(): Uint8Array {
  const chapter = Buffer.from(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Visible chapter text.</p></body></html>`);
  const container = Buffer.from(`<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const opf = Buffer.from(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  const entries = [
    { name: "mimetype", method: 0, raw: Buffer.from("application/epub+zip") },
    { name: "META-INF/", method: 8, raw: Buffer.alloc(0) },
    { name: "META-INF/container.xml", method: 0, raw: container },
    { name: "OEBPS/", method: 8, raw: Buffer.alloc(0) },
    { name: "OEBPS/content.opf", method: 0, raw: opf },
    { name: "OEBPS/ch1.xhtml", method: 0, raw: chapter },
  ].map(entry => ({ ...entry, stored: entry.method === 8 ? deflateRawSync(entry.raw) : entry.raw }));
  const le = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); b.writeUIntLE(n, 0, bytes); return b; };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.raw);
    const local = Buffer.concat([
      le(0x04034b50, 4), le(20, 2), le(0, 2), le(entry.method, 2), le(0, 2), le(0, 2),
      le(crc, 4), le(entry.stored.length, 4), le(entry.raw.length, 4), le(name.length, 2), le(0, 2),
      name, entry.stored,
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      le(0x02014b50, 4), le(20, 2), le(20, 2), le(0, 2), le(entry.method, 2), le(0, 2), le(0, 2),
      le(crc, 4), le(entry.stored.length, 4), le(entry.raw.length, 4), le(name.length, 2), le(0, 2), le(0, 2),
      le(0, 2), le(0, 2), le(0, 4), le(offset, 4), name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    le(0x06054b50, 4), le(0, 2), le(0, 2), le(entries.length, 2), le(entries.length, 2),
    le(central.length, 4), le(offset, 4), le(0, 2),
  ]);
  return new Uint8Array(Buffer.concat([...locals, central, end]));
}

beforeEach(() => {
  root = tempDir();
  makeLibrary(root, "main", [
    { id: 1, title: "The Same Book", authors: ["Ada Lovelace"], pubdate: "2021-01-01", isbn: "9780306406157", files: { pdf: existingPdf } },
    { id: 2, title: "Unique Existing", authors: ["Grace Hopper"], pubdate: "2019-01-01", files: { epub: existingEpub } },
  ]);
  config = {
    booksRoot: root,
    libraries: ["main"],
    excludeTags: [],
    dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"),
    backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"),
    shelvesLibrary: "main",
    host: "127.0.0.1",
    port: 0,
    citekeyPreset: "author-year-word",
    vocabularyPath: path.resolve("tests/vocabulary.json"),
  };
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  db.close();
  c = {
    db: openDatabase(config.dbPath, { readonly: true }),
    data: openDataStore(config.dataDbPath),
    booksRoot: root,
    citekeyPreset: "author-year-word",
    vocabulary: Vocabulary.load(config.vocabularyPath),
  };
});

afterEach(() => {
  c.db.close();
  c.data.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const wait = async (r: JobRunner, id: number) => {
  for (let i = 0; i < 60; i++) {
    const j = r.get(id);
    if (j.status !== "running") return j;
    await new Promise(ok => setTimeout(ok, 10));
  }
  throw new Error("Timed out");
};

it("blocks exact file duplicates and offers add_format when a matched book lacks the uploaded format", () => {
  // 1. Exact duplicate of main:1's PDF
  const exact = stageUpload(c, config, "Same Copy.pdf", existingPdf, "me@example.com");
  expect(exact.exact_matches).toEqual([expect.objectContaining({ id: "main:1", matched_format: "PDF" })]);
  expect(exact.blockers[0]).toContain("Identical file is already in Calibre: main:1");
  expect(exact.suggested_action).toBe("skip");
  expect(exact.allowed_actions).toEqual(["skip"]);
  expect(() => uploadBatchPlan(c, config, [{ id: exact.id, sha256: exact.sha256, action: "add_book" }])).toThrow(/Identical file/);

  // 2. An EPUB of the same book (matching by ISBN-10 and title/author, even with "Lovelace, Ada" author order): main:1 only has PDF, so add_format is suggested!
  const epubForMain1 = makeRichEpub({ title: "The Same Book", author: "Lovelace, Ada", year: "2021", isbn: "0-306-40615-2" });
  const addFmt = stageUpload(c, config, "The Same Book.epub", epubForMain1, "me@example.com");
  expect(addFmt.extracted.authors).toEqual(["Ada Lovelace"]);
  expect(addFmt.exact_matches).toEqual([]);
  expect(addFmt.matches).toHaveLength(1);
  expect(addFmt.matches[0]).toMatchObject({
    book: expect.objectContaining({ id: "main:1" }),
    evidence: expect.arrayContaining(["Matching identifier", "Matching title and authors"]),
    missing_formats: ["EPUB"],
    can_add_format: true,
  });
  expect(addFmt.suggested_action).toBe("add_format");
  expect(addFmt.suggested_target).toBe("main:1");
  expect(addFmt.allowed_actions).toEqual(["skip", "add_format", "add_book"]);

  // 3. Another EPUB matching main:2 (which already has EPUB): intercepts as skip, disables add_format, allows add_book override
  const anotherEpubForMain2 = makeRichEpub({ title: "Unique Existing", author: "Grace Hopper", year: "2022", text: "Second edition text." });
  const sameFmt = stageUpload(c, config, "Unique Existing 2nd Ed.epub", anotherEpubForMain2, "me@example.com");
  expect(sameFmt.matches).toHaveLength(1);
  expect(sameFmt.matches[0]).toMatchObject({
    book: expect.objectContaining({ id: "main:2" }),
    can_add_format: false,
    conflicting_formats: ["EPUB"],
    edition_warning: "Publication years differ; these may be different editions.",
  });
  expect(sameFmt.suggested_action).toBe("skip");
  expect(sameFmt.allowed_actions).toEqual(["skip", "add_book"]);
  expect(() => uploadBatchPlan(c, config, [{ id: sameFmt.id, sha256: sameFmt.sha256, action: "add_format", target_book_id: "main:2" }])).toThrow(/already has EPUB/);
});

it("extracts MOBI EXTH metadata, sniffs DRM and print-replica KFX, and validates draft edits", () => {
  const mobi = makeMobiBuffer({ title: "The Same Book", author: "Ada Lovelace", isbn: "9780306406157", asin: "B00TEST123", year: "2021" });
  const stagedMobi = stageUpload(c, config, "book.mobi", mobi);
  expect(stagedMobi.extracted).toMatchObject({
    title: "The Same Book",
    authors: ["Ada Lovelace"],
    year: 2021,
    identifiers: { isbn: "9780306406157", asin: "B00TEST123" },
    metadata_source: "embedded",
  });
  expect(stagedMobi.target_formats).toEqual(["MOBI", "EPUB"]);
  expect(stagedMobi.converts_to).toBe("EPUB");
  // Because main:1 has only PDF, uploading a MOBI (which converts to EPUB) offers add_format to main:1!
  expect(stagedMobi.suggested_action).toBe("add_format");
  expect(stagedMobi.suggested_target).toBe("main:1");

  // Encrypted MOBI and DRMION KFX are blocked immediately
  const lockedMobi = stageUpload(c, config, "locked.azw3", makeMobiBuffer({ title: "Locked", encryption: 2 }));
  expect(lockedMobi.blockers[0]).toMatch(/DRM-encrypted/);
  expect(lockedMobi.allowed_actions).toEqual(["skip"]);

  const drmion = Buffer.concat([Buffer.from([0xea]), Buffer.from("DRMION"), Buffer.from([0xee]), Buffer.alloc(32)]);
  const lockedKfx = stageUpload(c, config, "locked.kfx", drmion);
  expect(lockedKfx.blockers[0]).toMatch(/DRM-encrypted/);

  // Encrypted .kfx-zip containing a DRMION member is also blocked at staging
  const lockedKfxZip = Buffer.from(zipSync({ "book.kfx": new Uint8Array(drmion) }));
  const stagedKfxZip = stageUpload(c, config, "locked.kfx-zip", lockedKfxZip);
  expect(stagedKfxZip.blockers[0]).toMatch(/DRM-encrypted \(KFX DRMION\)/);
  expect(stagedKfxZip.allowed_actions).toEqual(["skip"]);

  // Re-staging identical bytes under a different supported extension moves the payload to the new extension
  const restaged = stageUpload(c, config, "locked-renamed.azw", drmion);
  expect(restaged.id).toBe(lockedKfx.id);
  expect(restaged.ext).toBe("azw");
  expect(fs.existsSync(path.join(uploadDir(config), `${restaged.id}.kfx`))).toBe(false);
  expect(fs.existsSync(path.join(uploadDir(config), `${restaged.id}.azw`))).toBe(true);
  expect(listStagedUploads(c, config).items.some(i => i.id === restaged.id && i.ext === "azw")).toBe(true);

  // Bounded zip decompression rejects zip bombs / excessive uncompressed size or entry counts before expanding
  const bombEntry = new Uint8Array(2 * 1024 * 1024); // 2 MB of zeroes compresses to ~2 KB (>200x ratio)
  const ratioZip = zipSync({ "META-INF/container.xml": bombEntry });
  expect(() => unzipBounded(ratioZip)).toThrow(/compression ratio exceeds safety limit/);
  expect(() => unzipBounded(new Uint8Array(existingEpub), { maxTotalBytes: 10 })).toThrow(/uncompressed size exceeds/);
  expect(() => unzipBounded(new Uint8Array(existingEpub), { maxEntries: 1 })).toThrow(/more than 1 entries/);
  // Publishers and Calibre store META-INF/ and OEBPS/ as deflated empty directories. Those entries are readable.
  const deflatedDir = deflatedDirectoryZip();
  expect(unzipBounded(deflatedDir)["META-INF/"]).toEqual(new Uint8Array());
  expect(epubProfile(deflatedDir).words).toBeGreaterThan(0);
  const bombEpub = stageUpload(c, config, "bomb.epub", Buffer.from(ratioZip));
  expect(bombEpub.blockers[0]).toMatch(/compression ratio exceeds safety limit/);

  // Print-replica KFX targets PDF
  const replicaKfx = Buffer.from("CONT\x02\x00yj_textbook yj_fixed_layout %PDF-1.4", "latin1");
  const stagedReplica = stageUpload(c, config, "New Textbook - Jane Doe (2024).kfx", replicaKfx);
  expect(stagedReplica.target_formats).toEqual(["KFX", "PDF"]);
  expect(stagedReplica.primary_format).toBe("PDF");
  expect(stagedReplica.extracted).toMatchObject({ title: "New Textbook", authors: ["Jane Doe"], year: 2024, metadata_source: "filename" });

  // Draft updates and citekey preview
  const updated = updateStagedUpload(c, config, stagedReplica.id, {
    title: "Advanced Systems",
    authors: ["Jane Doe", "John Smith"],
    year: 2025,
    tags: ["trivia"],
    action: "add_book",
  });
  expect(updated.draft).toMatchObject({
    title: "Advanced Systems",
    authors: ["Jane Doe", "John Smith"],
    year: 2025,
    tags: ["trivia"],
    action: "add_book",
  });
  expect(updated.proposed_citekey).toMatchObject({ key: "doe2025advanced", blockers: [], provisional: true });
  expect(() => updateStagedUpload(c, config, stagedReplica.id, { authors: ["Jane & John"] })).toThrow(/reserved & separator/);
  expect(() => updateStagedUpload(c, config, stagedReplica.id, { year: 999 })).toThrow(/1001 to 9999/);

  // Editing title/authors to match an existing book automatically switches the default action to add_format
  // unless the user explicitly clicked the action radio button.
  const unmatched = stageUpload(c, config, "Misnamed.epub", makeRichEpub({ title: "Temporary Title", author: "Ada Lovelace", year: "2021" }));
  expect(unmatched.draft.action).toBe("add_book");
  const afterTitleEdit = updateStagedUpload(c, config, unmatched.id, { title: "The Same Book" });
  expect(afterTitleEdit.suggested_action).toBe("add_format");
  expect(afterTitleEdit.draft.action).toBe("add_format");
  expect(afterTitleEdit.draft.target_book_id).toBe("main:1");

  removeStagedUpload(config, lockedMobi.id);
  expect(listStagedUploads(c, config).items.some(i => i.id === lockedMobi.id)).toBe(false);
  clearStagedUploads(config);
  expect(listStagedUploads(c, config).items).toEqual([]);
});

it("previews and applies uploads through JobRunner, recording changes, deduplicating refresh logs, and removing applied staged files", async () => {
  const newEpub = makeRichEpub({ title: "Brand New Work", author: "Alan Turing", year: "2023" });
  const formatEpub = makeRichEpub({ title: "The Same Book", author: "Ada Lovelace", year: "2021" });
  const sNew = stageUpload(c, config, "Brand New Work.epub", newEpub, "me@example.com");
  const sFmt = stageUpload(c, config, "The Same Book.epub", formatEpub, "me@example.com");
  await profilesSettled();

  let refreshes = 0;
  const commands: JobCommands = {
    refresh: async () => { refreshes++; },
    calibre: async (command, stdin, log) => {
      const payload = JSON.parse(stdin!);
      expect(payload.items[0].data_base64).toBeTruthy();
      if (command === "upload-preview") {
        for (const it of payload.items) {
          const { data_base64: _d, ...planClean } = it;
          log("@@change " + JSON.stringify({
            calibre_id: it.target?.id ?? 0,
            uuid: it.target?.uuid ?? null,
            title: it.title,
            upload_review: {
              plan: { ...planClean, reviewed: "fp-" + it.id },
              action: it.action,
              filename: it.filename,
              source_format: it.format,
              convert_to: it.converts_to,
              add_formats: it.target_formats,
              target: it.target,
              blockers: [],
            },
          }) + "\n");
        }
      } else {
        expect(c.writesPaused).toContain("Book upload is running");
        log("@@change " + JSON.stringify({
          calibre_id: 3,
          uuid: "uuid-3",
          title: "Brand New Work",
          added: ["trivia"],
          upload_applied: { id: sNew.id, action: "add_book", formats: ["EPUB"], backup: "saved.db" },
        }) + "\n");
        log("@@change " + JSON.stringify({
          calibre_id: 1,
          uuid: "uuid-1",
          title: "The Same Book",
          added_format: "epub",
          source_format: "epub",
          upload_applied: { id: sFmt.id, action: "add_format", formats: ["EPUB"], backup: "saved.db" },
        }) + "\n");
      }
    },
  };
  const r = new JobRunner(c, config, commands);
  const previewId = r.start("upload", "preview", {
    upload: [
      { id: sNew.id, sha256: sNew.sha256, action: "add_book", title: "Brand New Work", authors: ["Alan Turing"], year: 2023, tags: ["trivia"] },
      { id: sFmt.id, sha256: sFmt.sha256, action: "add_format", target_book_id: "main:1" },
    ],
  }, "me@example.com");
  const preview = await wait(r, previewId);
  expect(preview.status).toBe("succeeded");
  // Ensure data.db params do not store the raw base64 file bytes
  expect(JSON.stringify(preview.params)).not.toContain("data_base64");

  const apply = await wait(r, r.start("upload", "apply", { previewOf: preview.id }, "me@example.com"));
  expect(apply.status).toBe("succeeded");
  expect(refreshes).toBe(1);
  // Applied staged files are automatically cleaned up
  expect(listStagedUploads(c, config).items).toEqual([]);

  const changes = c.data.prepare("SELECT kind, book_id, detail FROM changes WHERE job_id = ? ORDER BY id").all(apply.id);
  expect(changes).toEqual([
    { kind: "tag_added", book_id: "main:3", detail: "trivia" },
    { kind: "book_added", book_id: "main:3", detail: "epub" },
    { kind: "format_added", book_id: "main:1", detail: "epub → epub" },
  ]);

  // Follow-up refresh sees main:3 as book_added and main:1 as book_reextracted; notYetLogged deduplicates both!
  const remaining = notYetLogged(c.data, [
    { kind: "book_added", source: "calibre", book_id: "main:3", detail: "epub" },
    { kind: "book_reextracted", source: "calibre", book_id: "main:1", detail: "pdf → epub" },
  ]);
  expect(remaining).toEqual([]);
});

it("executes tools/calibre-upload.py for preview and apply, converting MOBI to EPUB and checking live duplicates", () => {
  // Set up a mock calibre module and conversion binaries to test calibre-upload.py directly.
  const pyRoot = path.join(root, "py");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "ebook-convert"), `#!/bin/sh\ncp "${path.join(root, "seed.epub")}" "$2"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "seed.epub"), existingEpub);

  for (const dir of ["calibre", "calibre/db", "calibre/customize", "calibre/ebooks", "calibre/ebooks/metadata", "calibre/ebooks/metadata/book", "calibre/utils"]) {
    fs.mkdirSync(path.join(pyRoot, dir), { recursive: true });
    fs.writeFileSync(path.join(pyRoot, dir, "__init__.py"), "");
  }
  fs.writeFileSync(path.join(pyRoot, "calibre/utils/date.py"), "UNDEFINED_DATE = None\n");
  fs.writeFileSync(path.join(pyRoot, "calibre/ebooks/metadata/__init__.py"), "def title_sort(t, lang=None): return t\n");
  fs.writeFileSync(path.join(pyRoot, "calibre/ebooks/metadata/book/base.py"), `class Metadata:
 def __init__(self, title, authors):
  self.title = title; self.authors = list(authors); self.tags = []; self.pubdate = None; self.identifiers = {}
 def set_identifiers(self, d): self.identifiers = dict(d)
`);
  fs.writeFileSync(path.join(pyRoot, "calibre/customize/ui.py"), "def run_plugins_on_import(path): return path\n");
  fs.writeFileSync(path.join(pyRoot, "calibre/db/legacy.py"), `from contextlib import nullcontext
from types import SimpleNamespace
import pathlib, shutil

class LibraryDatabase:
 def __init__(self, library):
  self.lib = pathlib.Path(library)
  self.new_api = self
  self.write_lock = nullcontext()
  self.books = {
   1: {'uuid': 'uuid-1', 'title': 'The Same Book', 'authors': ['Ada Lovelace'], 'path': 'Ada Lovelace/The Same Book (1)',
       'formats': {'PDF': 'Ada Lovelace/The Same Book (1)/The Same Book - Ada Lovelace.pdf'}},
  }
  self.next_id = 10
 def close(self): pass
 def all_book_ids(self): return list(self.books.keys())
 def has_id(self, book_id): return book_id in self.books
 def get_metadata(self, book_id):
  b = self.books[book_id]
  return SimpleNamespace(uuid=b['uuid'], title=b['title'], authors=b['authors'], identifiers=b.get('identifiers', {'isbn': '978-0-306-40615-7'}))
 def field_for(self, field, book_id):
  return self.books[book_id]['path'] if field == 'path' else self.books[book_id]['uuid']
 def formats(self, book_id): return list(self.books[book_id]['formats'].keys())
 def format_abspath(self, book_id, fmt): return str(self.lib / self.books[book_id]['formats'][fmt.upper()])
 def author_sort_from_authors(self, authors): return '; '.join(authors)
 def create_book_entry(self, mi):
  bid = self.next_id; self.next_id += 1
  rel = f'New/{mi.title} ({bid})'
  (self.lib / rel).mkdir(parents=True, exist_ok=True)
  self.books[bid] = {'uuid': f'uuid-{bid}', 'title': mi.title, 'authors': mi.authors, 'path': rel, 'formats': {}}
  return bid
 def add_format(self, book_id, fmt, src, replace=False, run_hooks=False):
  if self.books[book_id]['title'] == 'Fail Add Format':
   return False
  if book_id == 1 and fmt.upper() == 'EPUB' and (self.lib / 'fail_second_format').exists():
   return False
  rel = f"{self.books[book_id]['path']}/book.{fmt.lower()}"
  dst = self.lib / rel
  shutil.copy2(src, dst)
  self.books[book_id]['formats'][fmt.upper()] = rel
  return True
 def remove_formats(self, fmt_map):
  for bid, fmts in fmt_map.items():
   for f in fmts:
    rel = self.books[bid]['formats'].pop(f.upper(), None)
    if rel:
     (self.lib / rel).unlink(missing_ok=True)
   with (self.lib / 'removed_formats.log').open('a') as out:
    out.write(f"{bid}:{','.join(f.upper() for f in fmts)}\\n")
 def remove_books(self, ids, permanent=False):
  for bid in ids:
   b = self.books.pop(bid, None)
   if b:
    shutil.rmtree(self.lib / b['path'], ignore_errors=True)
  with (self.lib / 'removed.log').open('a') as f:
   f.write(','.join(str(i) for i in ids) + f':permanent={permanent}\\n')
 def set_cover(self, data): pass
 def dump_metadata(self, ids): pass
`);

  const script = path.resolve("tools/calibre-upload.py");
  const libDir = path.join(root, "main");
  const runPy = (input: string, apply = false) =>
    spawnSync("python3", ["-B", script, libDir, ...(apply ? ["--apply"] : [])], {
      input,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: pyRoot, CALIBRE_BIN: binDir },
    });

  // 1. Invalid JSON / plan fails concisely without traceback, including path traversal ids
  const bad = runPy('{"items":[]}');
  expect(bad.status).toBe(1);
  expect(bad.stderr.trim()).toBe("Select at least one file to upload.");
  expect(bad.stderr).not.toContain("Traceback");

  const traversal = runPy(JSON.stringify({
    library: "main",
    items: [{
      id: "../../outside", filename: "test.epub", ext: "epub", format: "EPUB",
      target_formats: ["EPUB"], primary_format: "EPUB", converts_to: null,
      sha256: "a".repeat(64), size: 10, action: "add_book", target: null,
      title: "Test", authors: ["Author"], year: 2020, tags: [], known_matches: [], data_base64: "dGVzdA==",
    }],
  }));
  expect(traversal.status).toBe(1);
  expect(traversal.stderr.trim()).toBe("Invalid upload file identity.");

  // 2. Preview adding a MOBI as a new book and an EPUB as a format on book 1
  const mobiBytes = makeMobiBuffer({ title: "Fresh Mobi", author: "Donald Knuth", year: "2020" });
  const epubBytes = makeRichEpub({ title: "The Same Book", author: "Ada Lovelace", year: "2021" });
  const plan = {
    library: "main",
    items: [
      {
        id: "u1", filename: "Fresh Mobi.mobi", ext: "mobi", format: "MOBI",
        target_formats: ["MOBI", "EPUB"], primary_format: "EPUB", converts_to: "EPUB",
        sha256: createHash("sha256").update(mobiBytes).digest("hex"), size: mobiBytes.length,
        action: "add_book", target: null, title: "Fresh Mobi", authors: ["Donald Knuth"], year: 2020, tags: ["trivia"],
        known_matches: [], data_base64: mobiBytes.toString("base64"),
      },
      {
        id: "u2", filename: "Same.epub", ext: "epub", format: "EPUB",
        target_formats: ["EPUB"], primary_format: "EPUB", converts_to: null,
        sha256: createHash("sha256").update(epubBytes).digest("hex"), size: epubBytes.length,
        action: "add_format", target: { id: 1, uuid: "uuid-1", title: "The Same Book" },
        title: "The Same Book", authors: ["Ada Lovelace"], year: 2021, tags: [],
        known_matches: [], data_base64: epubBytes.toString("base64"),
      },
    ],
  };

  const prev = runPy(JSON.stringify(plan), false);
  expect(prev.status, prev.stderr).toBe(0);
  const prevItems = prev.stdout.split("\n").filter(l => l.startsWith("@@change ")).map(l => JSON.parse(l.slice(9)));
  expect(prevItems).toHaveLength(2);
  expect(prevItems[0].upload_review).toMatchObject({
    action: "add_book",
    source_format: "MOBI",
    convert_to: "EPUB",
    add_formats: ["MOBI", "EPUB"],
    blockers: [],
  });
  expect(prevItems[1].upload_review).toMatchObject({
    action: "add_format",
    source_format: "EPUB",
    add_formats: ["EPUB"],
    blockers: [],
  });

  // 3. Apply the reviewed plan
  const applyPlan = {
    library: "main",
    items: prevItems.map((it, idx) => ({ ...it.upload_review.plan, data_base64: plan.items[idx].data_base64 })),
  };
  const applied = runPy(JSON.stringify(applyPlan), true);
  expect(applied.status, applied.stderr).toBe(0);
  const appliedItems = applied.stdout.split("\n").filter(l => l.startsWith("@@change ")).map(l => JSON.parse(l.slice(9)));
  expect(appliedItems).toHaveLength(2);
  expect(appliedItems[0]).toMatchObject({
    calibre_id: 10,
    title: "Fresh Mobi",
    added: ["trivia"],
    upload_applied: { id: "u1", action: "add_book", formats: ["MOBI", "EPUB"] },
  });
  expect(appliedItems[1]).toMatchObject({
    calibre_id: 1,
    title: "The Same Book",
    added_format: "epub",
    upload_applied: { id: "u2", action: "add_format", formats: ["EPUB"] },
  });
  expect(fs.readdirSync(libDir).some(f => f.startsWith("metadata.db.before-upload-"))).toBe(true);

  // 4. Live identifier match (ISBN-10 matching book 1's ISBN-13 with different title/author) blocks unreviewed add_book, unless in known_matches
  const idMatchPlan = {
    library: "main",
    items: [{
      id: "u3", filename: "Different Title.epub", ext: "epub", format: "EPUB",
      target_formats: ["EPUB"], primary_format: "EPUB", converts_to: null,
      sha256: createHash("sha256").update(epubBytes).digest("hex"), size: epubBytes.length,
      action: "add_book", target: null, title: "Edited Title", authors: ["Edited Author"], year: 2021, tags: [],
      identifiers: { isbn: "0306406152" }, known_matches: [], data_base64: epubBytes.toString("base64"),
    }],
  };
  const idBlocked = JSON.parse(runPy(JSON.stringify(idMatchPlan), false).stdout.trim().slice(9));
  expect(idBlocked.upload_review.blockers).toEqual([
    "Matches Calibre book 1 (The Same Book) in the live library. Refresh Corpus and review the match first.",
  ]);
  const idReviewedPlan = {
    library: "main",
    items: [{ ...idMatchPlan.items[0], known_matches: [{ id: 1, uuid: "uuid-1" }] }],
  };
  const idAllowed = JSON.parse(runPy(JSON.stringify(idReviewedPlan), false).stdout.trim().slice(9));
  expect(idAllowed.upload_review.blockers).toEqual([]);

  // 5. Rollback of create_book_entry when add_format fails during apply
  const failPlan = {
    library: "main",
    items: [{
      id: "u4", filename: "Fail.epub", ext: "epub", format: "EPUB",
      target_formats: ["EPUB"], primary_format: "EPUB", converts_to: null,
      sha256: createHash("sha256").update(epubBytes).digest("hex"), size: epubBytes.length,
      action: "add_book", target: null, title: "Fail Add Format", authors: ["Author"], year: 2021, tags: [],
      known_matches: [], data_base64: epubBytes.toString("base64"),
    }],
  };
  const failPrev = JSON.parse(runPy(JSON.stringify(failPlan), false).stdout.trim().slice(9));
  const failApply = runPy(JSON.stringify({
    library: "main",
    items: [{ ...failPrev.upload_review.plan, data_base64: failPlan.items[0].data_base64 }],
  }), true);
  expect(failApply.status).toBe(1);
  expect(failApply.stderr).toContain("Could not add EPUB to new book 10.");
  expect(fs.readFileSync(path.join(libDir, "removed.log"), "utf8").trim()).toBe("10:permanent=True");
  expect(fs.existsSync(path.join(libDir, "New", "Fail Add Format (10)"))).toBe(false);

  // 6. Rollback of partial add_format when MOBI succeeds on book 1 but converted EPUB fails
  fs.writeFileSync(path.join(libDir, "fail_second_format"), "1");
  const partialFmtPlan = {
    library: "main",
    items: [{
      id: "u5", filename: "Same.mobi", ext: "mobi", format: "MOBI",
      target_formats: ["MOBI", "EPUB"], primary_format: "EPUB", converts_to: "EPUB",
      sha256: createHash("sha256").update(mobiBytes).digest("hex"), size: mobiBytes.length,
      action: "add_format", target: { id: 1, uuid: "uuid-1", title: "The Same Book" },
      title: "The Same Book", authors: ["Ada Lovelace"], year: 2021, tags: [],
      known_matches: [], data_base64: mobiBytes.toString("base64"),
    }],
  };
  const partialPrev = JSON.parse(runPy(JSON.stringify(partialFmtPlan), false).stdout.trim().slice(9));
  const partialApply = runPy(JSON.stringify({
    library: "main",
    items: [{ ...partialPrev.upload_review.plan, data_base64: partialFmtPlan.items[0].data_base64 }],
  }), true);
  expect(partialApply.status).toBe(1);
  expect(partialApply.stderr).toContain("Could not add format EPUB to book 1.");
  expect(fs.readFileSync(path.join(libDir, "removed_formats.log"), "utf8").trim()).toBe("1:MOBI");
  expect(fs.existsSync(path.join(libDir, "Ada Lovelace/The Same Book (1)/book.mobi"))).toBe(false);
});

it("renders the upload page script and keeps unmatched uploads ready immediately even with PDF workers active", async () => {
  const scripts = [...UPLOAD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(scripts).toHaveLength(2);
  expect(() => new Function(scripts.join("\n;\n"))).not.toThrow();

  usePdfWorkers();
  const unmatchedPdf = makePdf({ pages: [["Completely unrelated brand new upload", "Copyright 2024 by Someone Else"]] });
  const staged = stageUpload(c, config, "Unrelated New Upload.pdf", unmatchedPdf, "me@example.com");
  expect(staged.matches).toEqual([]);
  expect(staged.contents_pending).toEqual([]);
  expect(staged.draft.action).toBe("add_book");
});
