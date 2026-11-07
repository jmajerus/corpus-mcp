import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { tempDir } from "./fixtures.js";

let root: string, backup: string, snapshot: string, manifest: any;
beforeEach(() => {
  root = tempDir(); backup = path.join(root, "saved.db"); snapshot = backup + ".files/book";
  fs.mkdirSync(snapshot, { recursive: true });
  const db = new Database(backup);
  db.exec(`CREATE TABLE books(id INTEGER PRIMARY KEY,uuid TEXT,title TEXT,path TEXT,pubdate TEXT,sort TEXT,author_sort TEXT);
    CREATE TABLE authors(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE books_authors_link(id INTEGER PRIMARY KEY,book INTEGER,author INTEGER);
    CREATE TABLE data(book INTEGER,format TEXT,name TEXT);
    INSERT INTO books VALUES(1,'uuid','Saved title','saved/book','2020-05-17T12:00:00+00:00','Saved sort','Writer');
    INSERT INTO authors VALUES(1,'Writer'); INSERT INTO books_authors_link VALUES(1,1,1);
    INSERT INTO data VALUES(1,'PDF','Saved title');`);
  db.close();
  manifest = { book_id: 1, uuid: "uuid", folder: "saved/book", formats: [["PDF", "Saved title"]], files: {} };
  for (const name of ["Saved title.pdf", "notes.txt"]) {
    fs.writeFileSync(path.join(snapshot, name), name);
    manifest.files[name] = createHash("sha256").update(name).digest("hex");
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function recover() {
  fs.writeFileSync(backup + ".files/manifest.json", JSON.stringify(manifest));
  return spawnSync("python3", [path.resolve("tools/calibre-metadata-recover.py"), root, backup, "--apply"], { encoding: "utf8", env: { ...process.env, PYTHONPATH: root } });
}
it.each(["omitted-format", "omitted-extra", "wrong-formats", "wrong-folder", "missing-snapshot", "unlisted-snapshot", "missing-indexed-format"])("rejects %s before opening Calibre for writes", kind => {
  // A sentinel module proves validation finishes before even opening the native API.
  fs.mkdirSync(path.join(root, "calibre"));
  fs.writeFileSync(path.join(root, "calibre/__init__.py"), "raise RuntimeError('CALIBRE_OPENED')\n");
  if (kind === "omitted-format") delete manifest.files["Saved title.pdf"];
  if (kind === "omitted-extra") delete manifest.files["notes.txt"];
  if (kind === "wrong-formats") manifest.formats = [];
  if (kind === "wrong-folder") manifest.folder = "wrong/book";
  if (kind === "missing-snapshot") fs.unlinkSync(path.join(snapshot, "notes.txt"));
  if (kind === "unlisted-snapshot") fs.writeFileSync(path.join(snapshot, "unlisted.txt"), "unexpected");
  if (kind === "missing-indexed-format") { delete manifest.files["Saved title.pdf"]; fs.unlinkSync(path.join(snapshot, "Saved title.pdf")); }
  const result = recover();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/does not match|do not match|indexed format is missing/);
  expect(result.stderr).not.toContain("CALIBRE_OPENED");
});
it("refuses a different restored path before restoring missing files or reporting success", () => {
  for (const directory of ["calibre", "calibre/db", "calibre/utils"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, "__init__.py"), "");
  }
  fs.writeFileSync(path.join(root, "calibre/utils/date.py"), "UNDEFINED_DATE = None\n");
  fs.writeFileSync(path.join(root, "calibre/db/legacy.py"), `from contextlib import nullcontext
from types import SimpleNamespace
import pathlib
class LibraryDatabase:
 def __init__(self, library):
  self.new_api=self; self.write_lock=nullcontext(); self.changed=False; self.log=pathlib.Path(library)/'writes'
 def close(self):pass
 def get_metadata(self, book):return SimpleNamespace(uuid='uuid',title='Current title',authors=['Writer'],pubdate=None)
 def field_for(self, field, book):return 'wrong/book' if self.changed else 'current/book'
 def format_abspath(self, book, fmt):return None
 def set_field(self, field, values):
  with self.log.open('a') as out:out.write(field+'\\n')
  self.changed=True
 def add_format(self,*args,**kwargs):raise RuntimeError('FILE_RESTORE_ATTEMPTED')
`);
  const result = recover();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Calibre restored a different folder");
  expect(result.stderr).not.toContain("FILE_RESTORE_ATTEMPTED");
  expect(result.stdout).not.toContain('"recovered": true');
  expect(fs.readFileSync(path.join(root, "writes"), "utf8").trim().split("\n")).toEqual(["title", "authors", "pubdate", "sort", "author_sort"]);
});
