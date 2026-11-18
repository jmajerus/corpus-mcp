import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as mupdf from "mupdf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { type OtlBook, coverNet, findCover, imageLook, intakeImage, isPlainCover, matchOtl, otlCatalogue, otlCover, otlCoverUrl, otlFetch, otlUrl, titleKey } from "../src/covers.js";
import { openDataStore } from "../src/data.js";
import { scanLibraries } from "../src/indexer.js";
import { openDatabase } from "../src/db.js";
import { type JobCommands, JobRunner } from "../src/jobs.js";
import { attachUploadPayloads, listStagedUploads, stageUpload, stagedCoversSettled, updateStagedUpload, uploadBatchPlan } from "../src/upload.js";
import { Vocabulary } from "../src/vocabulary.js";
import { makeLibrary, makePdf } from "./fixtures.js";

/** A JPEG `w`×`h` of one colour. */
function image(rgb: [number, number, number], w = 60, h = 90): Buffer {
  const p = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = p.getPixels();
  for (let i = 0; i < px.length; i += 3) { px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; }
  return Buffer.from(p.asJPEG(90));
}
const RED = image([200, 30, 40]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const otl = (id: number, title: string, authors: string[], extra: Partial<OtlBook> = {}): OtlBook =>
  ({ id, title, authors, isbns: [], year: 2020, url: `https://open.umn.edu/opentextbooks/textbooks/b${id}`, ...extra });

describe("cover looks", () => {
  it("tells a plain white page from cover art, including black and white art", () => {
    expect(isPlainCover(imageLook(image([252, 252, 252]))!)).toBe(true);
    expect(isPlainCover(imageLook(RED)!)).toBe(false);
    expect(isPlainCover(imageLook(image([30, 30, 30]))!)).toBe(false);
  });
});

describe("matching the Open Textbook Library", () => {
  const books = [
    otl(1, "Physical Geology", ["Steven Earle"]),
    otl(2, "Physical Geology", ["Karla Panchuk"]),
    otl(3, "Nursing Fundamentals", ["Kimberly Ernstmeyer", "Elizabeth Christman"]),
    otl(4, "A Computational Introduction to Number Theory", ["Victor Shoup"]),
    otl(5, "Bioethics", ["Jane Doe"]),
    otl(6, "Some Other Title", [], { isbns: ["9780306406157"] }),
  ];

  it("ignores edition statements and bracketed notes in titles", () => {
    expect(titleKey("Nursing Fundamentals 2e")).toBe(titleKey("Nursing Fundamentals"));
    expect(titleKey("Introduction to Earth Science, Second Edition (low resolution)")).toBe(titleKey("Introduction to Earth Science"));
  });

  it("matches by ISBN, or by title with a shared author", () => {
    expect(matchOtl(books, { title: "Anything", authors: [], isbns: ["0-306-40615-2"] })?.id).toBe(6);
    expect(matchOtl(books, { title: "Nursing Fundamentals 2e", authors: ["Ernstmeyer, Kimberly"], isbns: [] })?.id).toBe(3);
    expect(matchOtl(books, { title: "Physical Geology", authors: ["Karla Panchuk"], isbns: [] })?.id).toBe(2);
  });

  it("matches nothing when the title differs, the authors differ, or two editions can't be told apart", () => {
    expect(matchOtl(books, { title: "Introduction to Number Theory", authors: ["Someone Else"], isbns: [] })).toBeNull();
    expect(matchOtl(books, { title: "Nursing Fundamentals", authors: ["Someone Else"], isbns: [] })).toBeNull();
    expect(matchOtl(books, { title: "Physical Geology", authors: [], isbns: [] })).toBeNull();
  });

  it("accepts the title before a colon only with a shared author", () => {
    expect(matchOtl(books, { title: "Bioethics: A Coursebook", authors: ["Jane Doe"], isbns: [] })?.id).toBe(5);
    expect(matchOtl(books, { title: "Bioethics: A Coursebook", authors: ["John Roe"], isbns: [] })).toBeNull();
  });
});

describe("finding covers", () => {
  let dir: string;
  const realFetch = coverNet.fetch, realPause = coverNet.pause;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "covers-")); coverNet.pause = async () => {}; });
  afterEach(() => { coverNet.fetch = realFetch; coverNet.pause = realPause; fs.rmSync(dir, { recursive: true, force: true }); });

  /** Serves a two-page catalogue, one book page and its cover; counts requests. */
  function fakeOtl(requests: string[] = []) {
    coverNet.fetch = (async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("textbooks.json?page=1")) {
        return Response.json({ data: [{ id: 11, title: "General Microbiology", url: "https://open.umn.edu/opentextbooks/textbooks/general-microbiology", copyright_year: 2020,
          contributors: [{ contribution: "Author", first_name: "Linda", last_name: "Bruslind" }] }], links: { next: "https://open.umn.edu/opentextbooks/textbooks.json?page=2" } });
      }
      if (url.endsWith("textbooks.json?page=2")) return Response.json({ data: [], links: { next: null } });
      if (url.endsWith("/general-microbiology")) {
        return new Response('<html><head><meta content="https://open.umn.edu/social-card.jpg" property="og:image"></head><body>' +
          '<img alt="Library Home" src="/assets/library/otl_logo.webp" />' +
          '<img alt="Read more" class="cover" loading="lazy" src="https://open.umn.edu/rails/active_storage/representations/redirect/BLOB--sig/VAR--sig/Cover-Front.jpg?disposition=inline" /></body></html>');
      }
      if (url === "https://open.umn.edu/rails/active_storage/blobs/redirect/BLOB--sig/Cover-Front.jpg") return new Response(RED, { headers: { "content-type": "image/jpeg" } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return requests;
  }

  it("downloads the catalogue once a week and finds a plain book's cover", async () => {
    const requests = fakeOtl();
    expect((await otlCatalogue(dir)).map(b => b.title)).toEqual(["General Microbiology"]);
    expect(await otlCatalogue(dir)).toHaveLength(1);
    expect(requests.filter(r => r.includes("textbooks.json"))).toHaveLength(2);

    const book = path.join(dir, "book.pdf");
    fs.writeFileSync(book, makePdf({ pages: [["General Microbiology"], ["Chapter 1"]] }));
    const result = await findCover({ title: "General Microbiology", authors: ["Linda Bruslind"], isbns: [], current: { book, format: "pdf" } }, { dataDir: dir, online: true });
    expect(result.plain).toBe(true);
    expect(result.cover).toMatchObject({ source: "otl", label: "General Microbiology", ext: "jpg" });
    expect(sha(result.cover!.bytes)).toBe(sha(RED));
  });

  it("takes the original of the page's cover image, not its placeholder or social card", () => {
    expect(otlCoverUrl('<img class="cover" src="/assets/common/placeholder-a2a9b833.webp">', "https://open.umn.edu/x")).toBeNull();
    expect(otlCoverUrl('<meta property="og:image" content="https://open.umn.edu/card.jpg">', "https://open.umn.edu/x")).toBeNull();
    expect(String(otlCoverUrl('<img title="t" class="cover" src="https://open.umn.edu/rails/active_storage/representations/redirect/b1/v1/A%20B.jpg?disposition=inline&amp;x=1">', "https://open.umn.edu/x")))
      .toBe("https://open.umn.edu/rails/active_storage/blobs/redirect/b1/A%20B.jpg");
  });

  it("talks only to the OTL site, and stops reading a response that passes its limit", async () => {
    expect(otlUrl("https://open.umn.edu/a")?.href).toBe("https://open.umn.edu/a");
    for (const bad of ["http://open.umn.edu/a", "https://open.umn.edu.evil.example/a", "https://user@open.umn.edu/a", "https://open.umn.edu:8443/a", "https://127.0.0.1/a"]) expect(otlUrl(bad)).toBeNull();
    expect(otlCoverUrl('<img class="cover" src="https://evil.example/rails/active_storage/representations/redirect/b/v/x.jpg">', "https://open.umn.edu/x")).toBeNull();
    await expect(otlFetch("https://169.254.169.254/latest", { max: 10, timeoutMs: 1000 })).rejects.toThrow(/Not an Open Textbook Library address/);

    let pulled = 0;
    coverNet.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/hop")) return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/internal" } });
      if (url.endsWith("/big")) {
        // No content-length: a stream that would go on for 100 MB.
        return new Response(new ReadableStream({ pull(ctl) { pulled++; ctl.enqueue(new Uint8Array(1024 * 1024)); if (pulled >= 100) ctl.close(); } }));
      }
      return new Response("ok");
    }) as typeof fetch;
    await expect(otlFetch("https://open.umn.edu/hop", { max: 10, timeoutMs: 1000 })).rejects.toThrow(/redirected off its site/);
    expect((await otlFetch("https://open.umn.edu/big", { max: 3 * 1024 * 1024, timeoutMs: 5000 })).body).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(await otlCover({ id: 1, title: "X", authors: [], isbns: [], year: null, url: "https://elsewhere.example/x" }).catch(e => (e as Error).message)).toMatch(/Not an Open Textbook Library address/);
  });

  it("leaves a colour cover alone and doesn't look it up", async () => {
    const requests = fakeOtl();
    const cover = path.join(dir, "cover.jpg");
    fs.writeFileSync(cover, RED);
    const result = await findCover({ title: "General Microbiology", authors: [], isbns: [], current: { image: cover } }, { dataDir: dir, online: true });
    expect(result).toEqual({ plain: false, cover: null, matched: null });
    expect(requests).toEqual([]);
  });

  it("prefers an image saved beside the book in the intake folder, offline", async () => {
    fs.writeFileSync(path.join(dir, "OER-Textbook-Cover-General-Microbiology-350x453.png"), Buffer.from(new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 10, 10], false).asPNG()));
    fs.writeFileSync(path.join(dir, "Unrelated-Cover.jpg"), RED);
    expect(intakeImage(dir, "General Microbiology.pdf", "General Microbiology")).toMatchObject({ source: "intake", label: "OER-Textbook-Cover-General-Microbiology-350x453.png", ext: "png" });
    expect(intakeImage(dir, "Other Book.pdf", "Other Book")).toBeNull();
    const result = await findCover({ title: "General Microbiology", authors: [], isbns: [], current: { image: path.join(dir, "none.jpg") }, intake: { dir, file: "General Microbiology.pdf" } },
      { dataDir: dir, online: false });
    expect(result.cover?.source).toBe("intake");
  });
});

describe("covers for staged uploads", () => {
  let root: string, config: Config, c: any;
  const realFetch = coverNet.fetch, realPause = coverNet.pause;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "staged-covers-"));
    makeLibrary(root, "main", [
      { id: 1, title: "Unrelated", authors: ["Grace Hopper"], pubdate: "2019-01-01", files: {} },
      { id: 2, title: "General Microbiology", authors: ["Linda Bruslind"], pubdate: "2020-01-01", files: {} },
      { id: 3, title: "Colourful Book", authors: ["Ada Lovelace"], pubdate: "2020-01-01", files: {} },
    ]);
    config = {
      booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"), dataDbPath: path.join(root, "data.db"),
      backupDir: path.join(root, "backups"), shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
      citekeyPreset: "author-year-word", vocabularyPath: path.resolve("tests/vocabulary.json"), coverLookup: true,
    };
    const db = openDatabase(config.dbPath);
    scanLibraries(config, db);
    db.close();
    c = { db: openDatabase(config.dbPath, { readonly: true }), data: openDataStore(config.dataDbPath), booksRoot: root, citekeyPreset: "author-year-word", vocabulary: Vocabulary.load(config.vocabularyPath) };
    coverNet.pause = async () => {};
    coverNet.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("textbooks.json")) {
        return Response.json({ data: [{ id: 11, title: "General Microbiology", url: "https://open.umn.edu/opentextbooks/textbooks/gm",
          contributors: [{ contribution: "Author", first_name: "Linda", last_name: "Bruslind" }] }], links: { next: null } });
      }
      if (url.endsWith("/gm")) return new Response('<img class="cover" src="https://open.umn.edu/rails/active_storage/representations/proxy/B/V/c.jpg">');
      if (url === "https://open.umn.edu/rails/active_storage/blobs/redirect/B/c.jpg") return new Response(RED);
      return new Response("", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    coverNet.fetch = realFetch; coverNet.pause = realPause;
    c.db.close(); c.data.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("looks for a cover in the background, sends it with the book, and leaves it out when unticked", async () => {
    const pdf = makePdf({ pages: [["General Microbiology", "Linda Bruslind"], ["Chapter 1 Introduction"]] });
    const staged = stageUpload(c, config, "General Microbiology - Linda Bruslind.pdf", pdf, "me@example.com");
    expect(staged.cover).toEqual({ status: "pending" });
    updateStagedUpload(c, config, staged.id, { title: "General Microbiology", authors: ["Linda Bruslind"] });
    expect(() => uploadBatchPlan(c, config, [{ id: staged.id, sha256: staged.sha256, action: "add_book" }])).toThrow(/still being looked for/);
    await stagedCoversSettled();

    const listed = listStagedUploads(c, config).items[0];
    expect(listed.cover).toMatchObject({ status: "found", source: "otl", label: "General Microbiology", use: true, url: `/api/upload/files/${staged.id}/cover` });
    const plan = uploadBatchPlan(c, config, [{ id: staged.id, sha256: staged.sha256, action: "add_book" }]);
    expect(plan.items[0].cover).toEqual({ sha256: sha(RED), ext: "jpg", source: "otl", label: "General Microbiology" });
    const payload = attachUploadPayloads(config, plan).items[0] as { cover_base64?: string };
    expect(Buffer.from(payload.cover_base64!, "base64").equals(RED)).toBe(true);

    updateStagedUpload(c, config, staged.id, { use_cover: false });
    const without = uploadBatchPlan(c, config, [{ id: staged.id, sha256: staged.sha256, action: "add_book" }]);
    expect(without.items[0].cover).toBeUndefined();
  });

  it("previews covers for library books with plain covers and applies exactly those", async () => {
    const folder = (id: number) => c.db.prepare("SELECT folder FROM books WHERE id = ?").pluck().get(`main:${id}`) as string;
    const white = image([252, 252, 252]);
    fs.writeFileSync(path.join(root, folder(2), "cover.jpg"), white);
    fs.writeFileSync(path.join(root, folder(3), "cover.jpg"), RED);
    let sent: any = null, refreshes = 0;
    const commands: JobCommands = {
      refresh: async () => { refreshes++; },
      calibre: async (command, stdin, log) => {
        expect(command).toBe("covers-apply");
        sent = JSON.parse(stdin!);
        log("@@change " + JSON.stringify({ calibre_id: 2, uuid: "uuid-2", title: "General Microbiology", cover_set: { source: "otl", label: "General Microbiology", backup: "b.files" } }) + "\n");
      },
    };
    const r = new JobRunner(c, config, commands);
    const wait = async (id: number) => {
      for (let i = 0; i < 200; i++) { const j = r.get(id); if (j.status !== "running") return j; await new Promise(ok => setTimeout(ok, 10)); }
      throw new Error("Timed out");
    };
    const preview = await wait(r.start("covers", "preview", {}, "me@example.com"));
    expect(preview.status, preview.log).toBe("succeeded");
    expect(preview.items).toEqual([expect.objectContaining({ calibre_id: 2, uuid: "uuid-2",
      cover_found: { source: "otl", label: "General Microbiology", page_url: "https://open.umn.edu/opentextbooks/textbooks/gm", sha256: sha(RED), ext: "jpg", old_cover_sha256: sha(white) } })]);
    expect(preview.log).toMatch(/have plain or missing covers; the Open Textbook Library has a cover for 1\./);
    expect(sent).toBeNull();

    const apply = await wait(r.start("covers", "apply", { previewOf: preview.id }, "me@example.com"));
    expect(apply.status, apply.log).toBe("succeeded");
    expect(sent.books).toHaveLength(1);
    expect(sent.books[0]).toMatchObject({ calibre_id: 2, uuid: "uuid-2", cover: { sha256: sha(RED) } });
    expect(Buffer.from(sent.books[0].cover_base64, "base64").equals(RED)).toBe(true);
    expect(refreshes).toBe(1);
    expect(c.data.prepare("SELECT kind, book_id, detail FROM changes WHERE job_id = ?").all(apply.id))
      .toEqual([{ kind: "cover_set", book_id: "main:2", detail: "Open Textbook Library: General Microbiology" }]);
  });

  it("leaves a book whose cover changes during the lookup for the next preview", async () => {
    const folder = c.db.prepare("SELECT folder FROM books WHERE id = 'main:2'").pluck().get() as string;
    const coverFile = path.join(root, folder, "cover.jpg");
    fs.writeFileSync(coverFile, image([252, 252, 252]));
    const fetchBefore = coverNet.fetch;
    coverNet.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith("/gm")) fs.writeFileSync(coverFile, image([10, 120, 200])); // someone sets a cover in Calibre meanwhile
      return fetchBefore(input, init);
    }) as typeof fetch;
    const r = new JobRunner(c, config, { refresh: async () => {}, calibre: async () => { throw new Error("not expected"); } });
    const id = r.start("covers", "preview", {}, "me@example.com");
    let j = r.get(id);
    for (let i = 0; i < 200 && j.status === "running"; i++) { await new Promise(ok => setTimeout(ok, 10)); j = r.get(id); }
    expect(j.status, j.log).toBe("succeeded");
    expect(j.items).toEqual([]);
    expect(j.log).toMatch(/main:2 General Microbiology: its cover changed during the lookup/);
  });

  it("shows a failed lookup as a plain cover, with the error", async () => {
    coverNet.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const staged = stageUpload(c, config, "General Microbiology.pdf", makePdf({ pages: [["General Microbiology"]] }), "me@example.com");
    await stagedCoversSettled();
    expect(listStagedUploads(c, config).items.find((x: { id: string }) => x.id === staged.id)!.cover)
      .toEqual({ status: "plain", error: "Open Textbook Library catalogue: HTTP 503" });
  });

  it("looks nothing up when lookups are off and the file has no intake folder", async () => {
    config.coverLookup = false;
    const staged = stageUpload(c, config, "General Microbiology.pdf", makePdf({ pages: [["General Microbiology"]] }), "me@example.com");
    expect(staged.cover).toEqual({ status: "none", error: null });
  });
});

describe("tools/calibre-covers.py", () => {
  it("sets a cover only while the book's cover is still the one judged plain, backing up the old one", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "covers-py-"));
    try {
      const pyRoot = path.join(root, "py"), lib = path.join(root, "main"), backups = path.join(root, "backups");
      for (const d of ["calibre", "calibre/db"]) { fs.mkdirSync(path.join(pyRoot, d), { recursive: true }); fs.writeFileSync(path.join(pyRoot, d, "__init__.py"), ""); }
      fs.writeFileSync(path.join(pyRoot, "calibre/db/legacy.py"), `from contextlib import nullcontext
import pathlib
class LibraryDatabase:
 def __init__(self, library):
  self.lib = pathlib.Path(library); self.new_api = self; self.write_lock = nullcontext()
  self.books = {1: ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A/One (1)'), 2: ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B/Two (2)')}
 def close(self): pass
 def has_id(self, i): return i in self.books
 def field_for(self, f, i): return self.books[i][0] if f == 'uuid' else self.books[i][1]
 def set_cover(self, m):
  for i, data in m.items(): (self.lib / self.books[i][1] / 'cover.jpg').write_bytes(data)
`);
      fs.mkdirSync(path.join(lib, "A/One (1)"), { recursive: true });
      fs.mkdirSync(path.join(lib, "B/Two (2)"), { recursive: true });
      const white = image([252, 252, 252]);
      fs.writeFileSync(path.join(lib, "A/One (1)/cover.jpg"), white);
      fs.writeFileSync(path.join(lib, "B/Two (2)/cover.jpg"), RED); // changed since the preview
      const meta = new Database(path.join(lib, "metadata.db"));
      meta.exec("CREATE TABLE t (x)"); meta.close();
      fs.mkdirSync(backups);
      const book = (id: number, uuid: string) => ({ calibre_id: id, uuid, title: `Book ${id}`,
        cover: { source: "otl", label: `Book ${id}`, page_url: null, sha256: sha(RED), ext: "jpg", old_cover_sha256: sha(white) }, cover_base64: RED.toString("base64") });
      const run = spawnSync("python3", ["-B", path.resolve("tools/calibre-covers.py"), lib, "--apply"], {
        input: JSON.stringify({ library: "main", books: [book(1, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), book(2, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")] }),
        encoding: "utf8", env: { ...process.env, PYTHONPATH: pyRoot, CORPUS_BACKUP_DIR: backups },
      });
      expect(run.status, run.stderr).toBe(0);
      const events = run.stdout.split("\n").filter(l => l.startsWith("@@change ")).map(l => JSON.parse(l.slice(9)));
      expect(events).toEqual([
        expect.objectContaining({ calibre_id: 2, cover_skipped: expect.stringMatching(/changed since the preview/) }),
        expect.objectContaining({ calibre_id: 1, cover_set: expect.objectContaining({ source: "otl", label: "Book 1" }) }),
      ]);
      expect(fs.readFileSync(path.join(lib, "A/One (1)/cover.jpg")).equals(RED)).toBe(true);
      const saved = fs.readdirSync(backups).find(n => n.endsWith(".files"))!;
      expect(fs.readFileSync(path.join(backups, saved, "1-cover.jpg")).equals(white)).toBe(true);

      const tampered = spawnSync("python3", ["-B", path.resolve("tools/calibre-covers.py"), lib, "--apply"], {
        input: JSON.stringify({ library: "main", books: [{ ...book(1, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), cover_base64: white.toString("base64") }] }),
        encoding: "utf8", env: { ...process.env, PYTHONPATH: pyRoot, CORPUS_BACKUP_DIR: backups },
      });
      expect(tampered.status).toBe(1);
      expect(tampered.stderr.trim()).toBe("The cover for book 1 does not match its checksum.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
