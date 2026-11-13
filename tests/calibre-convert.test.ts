import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeLibrary, tempDir } from "./fixtures.js";

const script = path.resolve("tools/calibre-convert.sh");
let root: string, library: string, bin: string;

/** A PalmDB/MOBI header whose record 0 carries the given encryption type. */
function mobi(encryption: number) {
  const b = Buffer.alloc(120);
  b.write("BOOKMOBI", 60, "latin1");
  b.writeUInt32BE(90, 78);
  b.writeUInt16BE(encryption, 90 + 12);
  return b;
}
const drmion = Buffer.concat([Buffer.from([0xea]), Buffer.from("DRMION"), Buffer.from([0xee]), Buffer.alloc(32)]);
const kfx = (body: string) => Buffer.from("CONT\x02\x00" + body, "latin1");

beforeEach(() => {
  root = tempDir();
  library = path.join(root, "main");
  makeLibrary(root, "main", [
    { id: 1, title: "Plain Mobi", files: { mobi: mobi(0) } },
    { id: 2, title: "Locked Azw3", files: { azw3: mobi(2) } },
    { id: 3, title: "Locked Kfx In Azw", files: { azw: drmion } },
    { id: 4, title: "Print Replica", files: { kfx: kfx("yj_textbook yj_fixed_layout %PDF-1.4") } },
    { id: 5, title: "Reflowable", files: { kfx: kfx("reflow-style") } },
    { id: 6, title: "Has Epub", files: { kfx: kfx("reflow-style"), epub: Buffer.from("epub") } },
    { id: 7, title: "Has Pdf", files: { mobi: mobi(0), pdf: Buffer.from("%PDF-1.4") } },
    { id: 8, title: "Topaz", files: { azw: Buffer.from("TPZ0 topaz book") } },
    { id: 9, title: "Replica Without Pdf", files: { kfx: kfx("yj_textbook %PDF- nopdf") } },
    { id: 10, title: "Replica That Hangs", files: { kfx: kfx("yj_textbook %PDF- hang") } },
  ]);
  bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub("ebook-convert", 'echo "converted $1" > "$2"');
  // KFX Input: -r "KFX Input" -- -p IN OUT; exits 0 without a PDF for a book that has none.
  stub("calibre-debug", 'in="$5" out="$6"; grep -q hang "$in" && exit 124; grep -q nopdf "$in" && { echo "ERROR: Book format does not support PDF conversion"; exit 0; }; echo "%PDF-1.4" > "$out"');
  stub("calibredb", `echo "$5 \${6##*.}" >> "${path.join(root, "added.log")}"`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (...args: string[]) => spawnSync("bash", [script, ...args, library], { encoding: "utf8", env: { ...process.env, CALIBRE_BIN: bin } });
const items = (stdout: string) => stdout.split("\n").filter(l => l.startsWith("@@change ")).map(l => JSON.parse(l.slice(9)));

it("lists books with neither EPUB nor PDF, sniffing DRM and print replicas whatever the extension", () => {
  const r = run();
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain("8 book(s)");
  expect(r.stdout).toContain("5 can be converted");
  const byId = Object.fromEntries(items(r.stdout).map(i => [i.calibre_id, i.added_format ?? `skip:${i.convert_skipped}`]));
  expect(byId).toEqual({ 1: "epub", 2: "skip:encrypted", 3: "skip:encrypted", 4: "pdf", 5: "epub", 8: "skip:unrecognized", 9: "pdf", 10: "pdf" });
  expect(r.stdout).toContain("Locked Kfx In Azw → SKIP: DRM-encrypted");
  expect(fs.existsSync(path.join(root, "added.log"))).toBe(false);
});

it("extracts print-replica PDFs, falls back to EPUB when none comes out, and fails a hung extraction", () => {
  const r = run("--apply");
  expect(r.status).toBe(1);
  expect(fs.readFileSync(path.join(root, "added.log"), "utf8").trim().split("\n")).toEqual(["1 epub", "4 pdf", "5 epub", "9 epub"]);
  const applied = items(r.stdout);
  expect(applied.filter(i => i.added_format).map(i => [i.calibre_id, i.added_format])).toEqual([[1, "epub"], [4, "pdf"], [5, "epub"], [9, "epub"]]);
  expect(applied.filter(i => i.convert_skipped).map(i => i.calibre_id)).toEqual([2, 3, 8]);
  expect(r.stdout).toContain("9  no print-replica PDF; converting to EPUB instead");
  expect(r.stdout).toMatch(/FAILED\s+10\s+Replica That Hangs/);
  expect(r.stdout).toContain("4 converted, 1 failed, 3 skipped");
  expect(fs.readdirSync(library).some(f => f.startsWith("metadata.db.before-epub-"))).toBe(true);
});

it("prefers a readable lower-priority source to a locked preferred one", () => {
  makeLibrary(root, "other", [{ id: 1, title: "Mixed", files: { azw3: mobi(2), mobi: mobi(0) } }]);
  const r = spawnSync("bash", [script, path.join(root, "other")], { encoding: "utf8", env: { ...process.env, CALIBRE_BIN: bin } });
  expect(items(r.stdout)).toEqual([{ calibre_id: 1, uuid: "uuid-1", title: "Mixed", source_format: "mobi", added_format: "epub" }]);
});

it("applies only the previewed books, skipping any that changed since", () => {
  const plan = { books: [
    { calibre_id: 1, uuid: "uuid-1", source_format: "mobi", added_format: "epub" },
    { calibre_id: 4, uuid: "uuid-4", source_format: "kfx", added_format: "pdf" },
    { calibre_id: 5, uuid: "other-uuid", source_format: "kfx", added_format: "epub" },
    { calibre_id: 7, uuid: "uuid-7", source_format: "mobi", added_format: "epub" },
    { calibre_id: 99, uuid: "uuid-99", source_format: "mobi", added_format: "epub" },
  ] };
  const r = spawnSync("bash", [script, "--apply", library], { encoding: "utf8",
    env: { ...process.env, CALIBRE_BIN: bin, CONVERT_PLAN: Buffer.from(JSON.stringify(plan)).toString("base64") } });
  expect(r.status).toBe(1);
  expect(fs.readFileSync(path.join(root, "added.log"), "utf8").trim().split("\n")).toEqual(["1 epub", "4 pdf"]);
  expect(Object.fromEntries(items(r.stdout).map(i => [i.calibre_id, i.added_format ?? i.convert_skipped]))).toEqual({
    1: "epub", 4: "pdf", 5: "changed since preview", 7: "changed since preview", 99: "no longer in the library" });
  expect(r.stdout).toContain("2 converted, 0 failed, 0 skipped, 3 changed since preview");
});
