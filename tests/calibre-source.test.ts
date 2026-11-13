import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCatalogue } from "../src/calibre.js";
import { makeEpub, makeLibrary, makePdf, tempDir } from "./fixtures.js";

// deploy/corpus-source.sh (the sync key's forced command on the Calibre-Web host) and
// deploy/corpus-sync.sh (the refresh pull on the corpus LXC). The library's location comes only
// from Calibre-Web's settings in app.db.

const sourceScript = fs.readFileSync(new URL("../deploy/corpus-source.sh", import.meta.url), "utf8");
const syncScript = new URL("../deploy/corpus-sync.sh", import.meta.url).pathname;
const epub = makeEpub("Echoes", [{ title: "Alpha", paragraphs: ["The echo chamber amplifies familiar claims."] }]);
const pdf = makePdf({ pages: [["One page"]] });

let root: string;
let host: string;
let appDb: string;
let tools: string;
let installed: string;

/** Calibre-Web's settings row, as its app.db holds it. */
function setLibrary(settings: { dir: string; split?: boolean; splitDir?: string }): void {
  const app = new Database(appDb);
  app.prepare("UPDATE settings SET config_calibre_dir = ?, config_calibre_split = ?, config_calibre_split_dir = ?")
    .run(settings.dir, settings.split ? 1 : 0, settings.splitDir ?? null);
  app.close();
}

/** Runs the forced command as sshd would, for SSH_ORIGINAL_COMMAND `command`. */
function source(command: string, input = "") {
  return spawnSync("sh", [installed], { env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, input, encoding: "utf8" });
}

beforeEach(() => {
  root = tempDir();
  host = path.join(root, "host");
  // Calibre-Web's data dir holds app.db; in split mode it also holds metadata.db.
  fs.mkdirSync(path.join(host, "cw-data"), { recursive: true });
  appDb = path.join(host, "cw-data", "app.db");
  const app = new Database(appDb);
  app.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY, config_calibre_dir TEXT, config_calibre_split INTEGER, config_calibre_split_dir TEXT);
    INSERT INTO settings (id) VALUES (1);
    CREATE TABLE shelf (id INTEGER PRIMARY KEY, name TEXT, is_public INTEGER);
    CREATE TABLE book_shelf_link (id INTEGER PRIMARY KEY, book_id INTEGER, "order" INTEGER, shelf INTEGER);
    INSERT INTO shelf VALUES (1, 'Misinformation', 1), (2, 'Diary', 0);
    INSERT INTO book_shelf_link (book_id, "order", shelf) VALUES (53, 1, 1), (7, 2, 1), (99, 1, 2);`);
  app.close();
  makeLibrary(host, "main", [{ id: 1, title: "Echoes", authors: ["Cy Writer"], files: { epub } }]);
  setLibrary({ dir: path.join(host, "main") });
  tools = path.join(root, "tools");
  fs.mkdirSync(tools);
  // Stand-ins that report how they were called.
  fs.writeFileSync(path.join(tools, "calibre-tags.sh"), 'echo "tags $* plan=$(printf %s "$TAG_PLAN" | base64 -d)"\n');
  fs.writeFileSync(path.join(tools, "calibre-convert.sh"), 'echo "convert $*${CONVERT_PLAN:+ plan=$(printf %s "$CONVERT_PLAN" | base64 -d)}"\n');
  fs.writeFileSync(path.join(tools, "calibre-metadata.py"), 'import sys; print("metadata " + " ".join(sys.argv[1:]) + " plan=" + sys.stdin.read())\n');
  installed = path.join(tools, "corpus-source");
  fs.writeFileSync(installed, sourceScript.replace(/^APP_DB=.*$/m, `APP_DB="${appDb}"`).replace(/^TOOLS_DIR=.*$/m, `TOOLS_DIR="${tools}"`), { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Moves the library to Calibre-Web's split layout: metadata.db in its data dir, a stale copy left behind. */
function splitLibrary(): void {
  fs.copyFileSync(path.join(host, "main", "metadata.db"), path.join(host, "cw-data", "metadata.db"));
  setLibrary({ dir: path.join(host, "cw-data"), split: true, splitDir: path.join(host, "main") });
}

describe("corpus-source (forced command)", () => {
  it("exports only public shelves from app.db and refuses anything it doesn't name", () => {
    expect(JSON.parse(source("shelves").stdout).shelves).toEqual([{ id: 1, name: "Misinformation", books: [{ book_id: 53, order: 1 }, { book_id: 7, order: 2 }] }]);
    const refused = source("cat /etc/passwd");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/only 'library', 'calibre-library', 'catalogue', read-only rsync, 'shelves'/);
    expect(source("tags-apply; id").status).toBe(1);
  });

  it("reports where Calibre-Web's settings put the library, split or not", () => {
    expect(JSON.parse(source("library").stdout)).toEqual({ metadata_dir: path.join(host, "main"), books_dir: path.join(host, "main"), split: false });
    splitLibrary();
    expect(JSON.parse(source("library").stdout)).toEqual({ metadata_dir: path.join(host, "cw-data"), books_dir: path.join(host, "main"), split: true });
  });

  it("explains a library location Calibre-Web can't be serving", () => {
    setLibrary({ dir: path.join(host, "nowhere") });
    expect(source("library")).toMatchObject({ status: 1, stderr: expect.stringMatching(/library location \(config_calibre_dir\) .*nowhere is not a directory/) });
    setLibrary({ dir: path.join(host, "cw-data") });
    expect(source("catalogue")).toMatchObject({ status: 1, stderr: expect.stringMatching(/no metadata.db in Calibre-Web's library location/) });
  });

  it("snapshots the metadata.db Calibre-Web uses", () => {
    splitLibrary();
    const live = new Database(path.join(host, "cw-data", "metadata.db"));
    live.prepare("INSERT INTO books (id, title, path, uuid) VALUES (2, 'Added in Calibre-Web', 'X/Added (2)', 'uuid-2')").run();
    live.close();
    const out = spawnSync("sh", [installed], { env: { ...process.env, SSH_ORIGINAL_COMMAND: "catalogue" } });
    expect(out.status).toBe(0);
    const copy = path.join(root, "copy.db");
    fs.writeFileSync(copy, out.stdout);
    const db = new Database(copy, { readonly: true });
    expect(db.prepare("SELECT title FROM books ORDER BY id").pluck().all()).toEqual(["Echoes", "Added in Calibre-Web"]);
    db.close();
  });

  it("won't serve book files from a directory that holds app.db", () => {
    fs.copyFileSync(path.join(host, "main", "metadata.db"), path.join(host, "cw-data", "metadata.db"));
    setLibrary({ dir: path.join(host, "cw-data") });
    expect(source("rsync --server --sender -logDtpre.iLsfxCIvu . ./")).toMatchObject({ status: 1, stderr: expect.stringMatching(/also holds app.db, so it won't be served/) });
  });

  it("runs the admin's named Calibre commands on Calibre-Web's library, with the plan on stdin", () => {
    const lib = path.join(host, "main");
    const run = (command: string, input = "") => source(command, input).stdout.trim();
    expect(run("tags-preview", '{"books":[]}')).toBe(`tags ${lib} plan={"books":[]}`);
    expect(run("tags-apply", '{"books":[1]}')).toBe(`tags --apply ${lib} plan={"books":[1]}`);
    expect(run("convert-preview")).toBe(`convert ${lib}`);
    expect(run("convert-apply", '{"books":[1]}')).toBe(`convert --apply ${lib} plan={"books":[1]}`);
    expect(source("convert-apply", "")).toMatchObject({ status: 1, stderr: expect.stringMatching(/needs the previewed books/) });
    expect(run("metadata-preview", '{"books":[]}')).toBe(`metadata ${lib} plan={"books":[]}`);
    expect(run("metadata-apply", '{"books":[1]}')).toBe(`metadata --apply ${lib} plan={"books":[1]}`);
    expect(run("calibre-library")).toBe(lib);
  });

  it("refuses the Calibre write commands when Calibre-Web keeps the library split", () => {
    splitLibrary();
    for (const command of ["tags-apply", "convert-apply", "metadata-preview", "duplicates-apply", "calibre-library"]) {
      const out = source(command, "{}");
      expect(out.status, command).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toMatch(/keeps this library split .*can't write to a split library/);
    }
  });

  it("lets the hand-run scripts default to Calibre-Web's library", () => {
    const script = path.join(tools, "calibre-convert.sh");
    fs.copyFileSync(new URL("../tools/calibre-convert.sh", import.meta.url), script);
    // Without --apply it only lists; an empty library lists nothing, but it must find the library first.
    const unsplit = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, CALIBRE_BIN: "/nonexistent" } });
    expect(unsplit.stderr).not.toMatch(/split/);
    expect(unsplit.status).toBe(0);
    splitLibrary();
    const split = spawnSync("bash", [script], { encoding: "utf8" });
    expect(split.status).not.toBe(0);
    expect(split.stderr).toMatch(/keeps this library split/);
  });
});

describe("corpus-sync (refresh pull)", () => {
  let mirror: string;
  let state: string;

  /** Runs the sync with an ssh stand-in that runs the forced command locally, as sshd would. */
  function sync() {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -i|-o) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
SSH_ORIGINAL_COMMAND="$*" exec sh "${installed}"
`, { mode: 0o755 });
    return spawnSync("sh", [syncScript], {
      encoding: "utf8",
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, CORPUS_SOURCE: "calibre-web", CORPUS_BOOKS_ROOT: mirror, CORPUS_LIBRARIES: "main",
        CORPUS_SSH_KEY: "/dev/null", CORPUS_SHELVES_FILE: path.join(state, "shelves.json"), CORPUS_SYNC_STATUS: path.join(state, "sync-status.json"),
        CORPUS_LIBRARY_FILE: path.join(state, "calibre-library.json"),
      },
    });
  }
  const status = () => JSON.parse(fs.readFileSync(path.join(state, "sync-status.json"), "utf8"));
  const mirrored = () => readCatalogue(path.join(mirror, "main")).map((b) => b.metadata.title);

  beforeEach(() => {
    mirror = path.join(root, "mirror");
    state = path.join(root, "state");
    fs.mkdirSync(state);
  });

  it("mirrors the library Calibre-Web uses, following it into split mode and noting the move", () => {
    const first = sync();
    expect(first.status, first.stderr).toBe(0);
    expect(mirrored()).toEqual(["Echoes"]);
    expect(status()).toMatchObject({ libraries: { main: "ok" }, shelves: "ok", calibre_library: { split: false }, library_changed: null });

    // Calibre-Web moves metadata.db to its data dir; the old one stays behind, stale, beside the files.
    splitLibrary();
    makeLibrary(path.join(root, "added"), "lib", [{ id: 2, title: "Bullied At Work", authors: ["J. David"], files: { pdf } }]);
    fs.cpSync(path.join(root, "added", "lib", "J. David"), path.join(host, "main", "J. David"), { recursive: true });
    const live = new Database(path.join(host, "cw-data", "metadata.db"));
    live.exec(`ATTACH '${path.join(root, "added", "lib", "metadata.db")}' AS added;
      INSERT INTO books SELECT * FROM added.books; INSERT INTO data (book, format, name) SELECT book, format, name FROM added.data;`);
    live.close();

    const second = sync();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/Calibre-Web's library moved/);
    expect(mirrored()).toEqual(["Echoes", "Bullied At Work"]);
    expect(fs.existsSync(path.join(mirror, "main", "J. David", "Bullied At Work (2)", "Bullied At Work - J. David.pdf"))).toBe(true);
    expect(status()).toMatchObject({
      libraries: { main: "ok" },
      calibre_library: { metadata_dir: path.join(host, "cw-data"), books_dir: path.join(host, "main"), split: true },
      library_changed: { at: expect.any(String), from: { metadata_dir: path.join(host, "main"), split: false } },
    });
    // No move, no new notice.
    expect(sync().stdout).not.toMatch(/moved/);
  });

  it("keeps the previous mirror when the source can't say where the library is", () => {
    expect(sync().status).toBe(0);
    setLibrary({ dir: path.join(host, "nowhere") });
    const failed = sync();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/not a directory/);
    expect(mirrored()).toEqual(["Echoes"]);
    expect(status()).toMatchObject({ libraries: { main: "failed" }, shelves: "ok" });
  });
});
