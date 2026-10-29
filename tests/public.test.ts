import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateAddress } from "../src/access.js";
import type { Config } from "../src/config.js";
import { openDataStore } from "../src/data.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import { d1Http } from "../src/public/d1-http.js";
import { openReplicaState, pending, tick } from "../src/public/drain.js";
import { replicaScript, snapshotRows } from "../src/public/replica.js";
import { SNAPSHOT_SCHEMA, buildSnapshot, fetchSites, type LinkedSite, type SnapshotOptions } from "../src/public/snapshot.js";
import { renderPublic } from "../src/public/site.js";
import { sqliteStore } from "../src/public/store.js";
import { serveHttp } from "../src/server.js";
import type { Corpus } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { FAVICON_BASE64 } from "../src/web/favicon.js";
import { type D1Database } from "../worker/d1.js";
import { handle } from "../worker/index.js";
import { type ProxyEnv, handleProxy } from "../worker/proxy.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

let root: string;
let config: Config;
let c: Corpus;
const vocabularyPath = path.join(import.meta.dirname, "vocabulary.json");

const quotesSite: LinkedSite = {
  url: "https://quotes.example.org", name: "Quotes", kind: "quotes", fetched_at: "2026-10-28T00:00:00Z",
  keys: { citekeys: { author2001networks: "/works/7" }, zotero_keys: { "users/1/ITEM2": "/works/9" } },
};

const options = (sites: LinkedSite[] = []): SnapshotOptions =>
  ({ title: "Test Library", url: "https://library.example.org", excludeTags: ["private"], zoteroLibrary: "users/1", sites });

beforeAll(() => {
  root = tempDir();
  makeLibrary(root, "main", [
    { id: 1, title: "Networks", authors: ["Ann Author"], pubdate: "2001-01-01", tags: ["social-sciences.sociology.social-change"],
      files: { pdf: makePdf({ pages: [["Weak ties carry novel information"]] }) } },
    { id: 2, title: "Crowds", authors: ["Bob Writer"], pubdate: "1999-01-01", tags: ["social-sciences.psychology", "not-a-term"],
      files: { pdf: makePdf({ pages: [["Crowds and their moods"]] }) } },
    { id: 3, title: "Diary", authors: ["Cy Self"], tags: ["private"], files: { pdf: makePdf({ pages: [["Not for anyone"]] }) } },
  ]);
  config = {
    booksRoot: root, libraries: ["main"], excludeTags: ["private"], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
    citekeyPreset: "author-year-word", vocabularyPath,
  };
  fs.writeFileSync(config.shelvesFile, JSON.stringify({
    exported_at: "2026-10-25T00:00:00Z",
    shelves: [{ id: 4, name: "Favourites", books: [{ book_id: 2, order: 0 }, { book_id: 1, order: 1 }, { book_id: 3, order: 2 }] }],
  }));
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  const data = openDataStore(config.dataDbPath);
  data.prepare("INSERT INTO citekeys (calibre_uuid, citekey, book_id, title, pinned_at) VALUES ('uuid-1', 'author2001networks', 'main:1', 'Networks', '2026-10-28')").run();
  data.prepare("INSERT INTO zotero_items (key, version, item_type, title, calibre_uuid, citekey, synced_at) VALUES ('ITEM2', 1, 'book', 'Crowds', 'uuid-2', 'writer1999crowds', '2026-10-28')").run();
  c = { db, data, booksRoot: root, vocabulary: Vocabulary.load(vocabularyPath) };
});

afterAll(() => {
  c.db.close();
  c.data.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the snapshot", () => {
  it("holds the catalogue and nothing else", () => {
    const file = path.join(root, "public.db");
    const s = buildSnapshot(c, options(), file);
    expect(s).toMatchObject({ changed: true, books: 2, shelves: 1 });
    const snap = new Database(file, { readonly: true });
    const tables = snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'books_fts_%'").pluck().all();
    expect(tables.sort()).toEqual(["book_shelves", "book_subjects", "books", "books_fts", "links", "meta", "shelves", "sites", "subjects"]);
    const dump = JSON.stringify(snap.prepare("SELECT * FROM books").all());
    expect(dump).not.toContain("Weak ties");
    expect(dump).not.toContain("Diary");
    // The private book is left off its shelf too.
    expect(snap.prepare("SELECT books FROM shelves WHERE id = 4").pluck().get()).toBe(2);
    // A subject's count includes books under narrower subjects; tags outside the vocabulary aren't subjects.
    expect(snap.prepare("SELECT tag, books FROM subjects ORDER BY tag").all()).toEqual([
      { tag: "social-sciences", books: 2 }, { tag: "social-sciences.psychology", books: 1 },
      { tag: "social-sciences.sociology", books: 1 }, { tag: "social-sciences.sociology.social-change", books: 1 },
    ]);
    // Real keys only: the pin, and the Zotero item the mirror matched with its citekey.
    expect(snap.prepare("SELECT id, citekeys, zotero_keys FROM books ORDER BY id").all()).toEqual([
      { id: "main:1", citekeys: '["author2001networks"]', zotero_keys: "[]" },
      { id: "main:2", citekeys: '["writer1999crowds"]', zotero_keys: '["users/1/ITEM2"]' },
    ]);
    snap.close();
  });

  it("leaves an unchanged snapshot alone", () => {
    const file = path.join(root, "same.db");
    buildSnapshot(c, options(), file);
    const before = fs.statSync(file).mtimeMs;
    expect(buildSnapshot(c, options(), file).changed).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});

describe("the pages", () => {
  let store: ReturnType<typeof sqliteStore>;
  beforeAll(() => {
    const file = path.join(root, "linked.db");
    buildSnapshot(c, options([quotesSite]), file);
    store = sqliteStore(new Database(file, { readonly: true }));
  });
  const get = async (p: string, q = "") => (await renderPublic(store, p, new URLSearchParams(q)))!;

  it("serves a front page, books, subjects, and shelves", async () => {
    expect((await get("/")).body).toContain("Test Library");
    expect((await get("/books")).body).toMatch(/Networks[\s\S]*Crowds|Crowds[\s\S]*Networks/);
    expect((await get("/books", "q=crow")).body).toContain("Crowds");
    expect((await get("/books", "q=crow")).body).not.toContain(">Networks<");
    expect((await get("/books", 'q=" OR')).status).toBe(200);
    const subject = (await get("/subjects/social-sciences.sociology")).body;
    expect(subject).toContain("Networks");
    expect(subject).not.toContain("Crowds");
    expect((await get("/shelves/4")).body).toMatch(/Crowds[\s\S]*Networks/);
    expect((await get("/books/nope")).status).toBe(404);
    expect(await renderPublic(store, "/admin")).toBeNull();
  });

  it("shows a book's entry with its links to other sites", async () => {
    const page = (await get(`/books/${encodeURIComponent("main:1")}`)).body;
    expect(page).toContain("author2001networks");
    expect(page).toContain('href="https://quotes.example.org/works/7"');
    expect(page).toContain("Quotes from this book on Quotes");
    // main:2 matches by its Zotero item key.
    expect((await get("/books/main:2")).body).toContain("https://quotes.example.org/works/9");
  });

  it("marks a preview's pages as not yet published", async () => {
    expect((await renderPublic(store, "/books", new URLSearchParams(), { preview: true }))!.body).toContain("not yet published");
    expect((await get("/books")).body).not.toContain("not yet published");
  });

  it("describes itself for other sites", async () => {
    expect(JSON.parse((await get("/site.json")).body)).toEqual({
      version: 1, name: "Test Library", kind: "library", url: "https://library.example.org", level: "catalogue", citekeys: "/api/public/citekeys",
    });
    expect(JSON.parse((await get("/api/public/citekeys")).body)).toEqual({
      citekeys: { author2001networks: "/books/main%3A1", writer1999crowds: "/books/main%3A2" },
      zotero_keys: { "users/1/ITEM2": "/books/main%3A2" },
    });
  });
});

describe("linked sites", () => {
  const fake = (routes: Record<string, unknown>): typeof fetch => (async (url: URL | string) => {
    const body = routes[String(url)];
    return body === undefined ? new Response("no", { status: 404 }) : Response.json(body);
  }) as typeof fetch;

  it("fetches site.json and the key list, and keeps the last ones when a site is down", async () => {
    const file = path.join(root, "fetched.db");
    const up = fake({
      "https://quotes.example.org/site.json": { version: 1, name: "Quotes", kind: "quotes", citekeys: "/api/public/citekeys" },
      "https://quotes.example.org/api/public/citekeys": { citekeys: { author2001networks: "/works/7", bad: "http://elsewhere" }, zotero_keys: {} },
    });
    const first = await fetchSites(["https://quotes.example.org/"], file, up);
    expect(first.errors).toEqual([]);
    expect(first.sites[0].keys).toEqual({ citekeys: { author2001networks: "/works/7" }, zotero_keys: {} });
    buildSnapshot(c, options(first.sites), file);
    const down = await fetchSites(["https://quotes.example.org"], file, fake({}));
    expect(down.errors[0]).toContain("HTTP 404");
    expect(down.sites[0].keys.citekeys).toEqual({ author2001networks: "/works/7" });
  });

  it("stays on the linked site's origin", async () => {
    const file = path.join(root, "nowhere.db");
    const site = (citekeys: string) => ({ "https://quotes.example.org/site.json": { version: 1, name: "Q", kind: "quotes", citekeys } });
    for (const citekeys of ["http://10.0.0.1/keys", "//10.0.0.1/keys", "api/keys"]) {
      const r = await fetchSites(["https://quotes.example.org"], file, fake(site(citekeys)));
      expect(r.errors[0], citekeys).toContain("isn't version 1");
    }
    const redirect = (to: string): typeof fetch => (async (url: URL | string) => String(url).endsWith("/site.json")
      ? new Response(null, { status: 302, headers: { location: to } })
      : Response.json({ citekeys: {}, zotero_keys: {} })) as typeof fetch;
    expect((await fetchSites(["https://quotes.example.org"], file, redirect("http://10.0.0.1/site.json"))).errors[0]).toContain("leads off the site");
    const same = redirect("/v1/site.json");
    const followed = await fetchSites(["https://quotes.example.org"], file, (async (url: URL | string) => String(url).endsWith("/v1/site.json")
      ? Response.json({ version: 1, name: "Q", kind: "quotes", citekeys: "/api/public/citekeys" })
      : same(url)) as typeof fetch);
    expect(followed.errors).toEqual([]);
  });
});

describe("keys that are also object properties", () => {
  it("lists them and never matches a missing one", async () => {
    c.data.prepare("UPDATE citekeys SET citekey = 'constructor' WHERE calibre_uuid = 'uuid-1'").run();
    try {
      const file = path.join(root, "proto.db");
      buildSnapshot(c, options([quotesSite]), file);
      const store = sqliteStore(new Database(file, { readonly: true }));
      expect((await renderPublic(store, "/books/main:1"))!.body).not.toContain("quotes.example.org");
      expect(JSON.parse((await renderPublic(store, "/api/public/citekeys"))!.body).citekeys.constructor).toBe("/books/main%3A1");
    } finally {
      c.data.prepare("UPDATE citekeys SET citekey = 'author2001networks' WHERE calibre_uuid = 'uuid-1'").run();
    }
  });
});

describe("the server", () => {
  let server: Awaited<ReturnType<typeof serveHttp>>;
  let base: string;
  let publicBase: string;
  const file = () => path.join(root, "served.db");

  beforeAll(async () => {
    c.db.close();
    c.db = openDatabase(config.dbPath);
    server = await serveHttp({
      ...config, admin: { access: { lanActor: "me@lan" }, neighbors: [], source: "x", sshKey: "x", refreshUnit: "x", refreshLog: "x", syncStatus: "x" },
      public: { level: "catalogue", file: file(), port: 0, title: "Served", url: "", links: [], intervalMinutes: 10 },
    }, { publishTimer: false, zoteroTimer: false });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    publicBase = `http://127.0.0.1:${(server.publicServer!.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("says how to build the snapshot, then serves it on its own port", async () => {
    expect((await fetch(`${publicBase}/`)).status).toBe(503);
    buildSnapshot(c, { ...options(), title: "Served" }, file());
    const res = await fetch(`${publicBase}/books/main%3A1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    expect(await res.text()).toContain("Networks");
    const again = await fetch(`${publicBase}/books/main%3A1`, { headers: { "if-none-match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);
    // Without D1, the public port is the public site, so it isn't marked as a preview.
    expect(await (await fetch(`${publicBase}/`)).text()).not.toContain("not yet published");
  });

  it("keeps the main port for working on the corpus", async () => {
    const root = await fetch(`${base}/`, { redirect: "manual" });
    expect([root.status, root.headers.get("location")]).toEqual([302, "/admin"]);
    for (const p of ["/books", "/site.json", "/subjects"]) expect((await fetch(`${base}${p}`)).status, p).toBe(404);
  });

  it("lets edits made directly on the LAN through, and never one through Cloudflare without a token", async () => {
    const whoami = (headers: Record<string, string> = {}) => fetch(`${base}/api/whoami`, { headers }).then((r) => r.json());
    expect(await whoami()).toEqual({ can_write: true, identity: { subject: "lan", email: "me@lan", via: "lan" } });
    expect(await whoami({ "cf-ray": "8a1b2c3d4e5f-LAX" })).toMatchObject({ can_write: false });
    expect(await whoami({ "cf-connecting-ip": "203.0.113.9" })).toMatchObject({ can_write: false });
    const job = await fetch(`${base}/api/admin/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "backup" }) });
    expect(job.status).toBe(202);
  });

  it("answers a malformed request target with 400 and keeps running", async () => {
    const raw = (port: number) => new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "//" }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      }).on("error", reject);
    });
    expect(await raw((server.address() as AddressInfo).port)).toBe(400);
    expect(await raw((server.publicServer!.address() as AddressInfo).port)).toBe(400);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("serves the icon on both listeners, and the pages link it", async () => {
    const png = fs.readFileSync(path.join(import.meta.dirname, "..", "assets", "favicon.png"));
    expect(FAVICON_BASE64).toBe(png.toString("base64"));
    for (const at of [base, publicBase]) {
      const res = await fetch(`${at}/favicon.png`);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    }
    expect(await (await fetch(`${publicBase}/books`)).text()).toContain('rel="icon"');
    expect(await (await fetch(`${base}/admin`)).text()).toContain('rel="icon"');
  });

  it("serves only public paths on the public port", async () => {
    expect((await fetch(`${publicBase}/books`)).status).toBe(200);
    expect((await fetch(`${publicBase}/site.json`)).status).toBe(200);
    for (const p of ["/admin", "/api/books", "/mcp", "/api/books/main%3A1/pages", "/health"]) {
      expect((await fetch(`${publicBase}${p}`)).status, p).toBe(404);
    }
  });
});

describe("the LAN", () => {
  it("is private, loopback, or link-local addresses", () => {
    for (const a of ["192.168.1.20", "10.0.0.5", "172.16.0.1", "172.31.255.1", "127.0.0.1", "::1", "::ffff:192.168.1.20", "fd12:3456::1", "fe80::1", "169.254.1.1"]) {
      expect(privateAddress(a), a).toBe(true);
    }
    for (const a of ["203.0.113.9", "172.32.0.1", "8.8.8.8", "2001:db8::1", "::ffff:8.8.8.8", undefined]) expect(privateAddress(a), String(a)).toBe(false);
  });
});

describe("the replica in D1", () => {
  const MIGRATION = path.join(import.meta.dirname, "..", "worker", "migrations", "0001_snapshot.sql");
  const TOKEN = "test-token";

  /** better-sqlite3 as the D1 binding the proxy uses, with batch() as one transaction, as D1's is. */
  function proxyBinding(db: Database.Database): ProxyEnv["DB"] {
    const run = (sql: string, params: unknown[]) => {
      const s = db.prepare(sql);
      return { success: true, results: s.reader ? s.all(...params) : (s.run(...params), []) };
    };
    const prepared = (sql: string, params: unknown[] = []) => ({ sql, params, bind: (...v: unknown[]) => prepared(sql, v), all: async () => run(sql, params) });
    return {
      prepare: (sql) => prepared(sql),
      batch: async (statements) => db.transaction(() => statements.map((p) => {
        const { sql, params } = p as unknown as { sql: string; params: unknown[] };
        return run(sql, params);
      }))(),
    };
  }

  /** better-sqlite3 as the D1 binding the public Worker reads. */
  function workerBinding(db: Database.Database): D1Database {
    const prepared = (sql: string, params: unknown[] = []): ReturnType<D1Database["prepare"]> => ({
      bind: (...v: unknown[]) => prepared(sql, v),
      all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[] }),
      first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    });
    return { prepare: (sql) => prepared(sql) };
  }

  function setup(name: string) {
    const file = path.join(root, `${name}.db`);
    buildSnapshot(c, options([quotesSite]), file);
    const replica = new Database(":memory:");
    replica.exec(fs.readFileSync(MIGRATION, "utf8"));
    const env: ProxyEnv = { DB: proxyBinding(replica), D1_PROXY_TOKEN: TOKEN };
    let fail = false;
    let lose = false;
    const calls: { sql: string; params?: unknown[] }[][] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (fail) {
        fail = false;
        throw new Error("connection reset");
      }
      const body = JSON.parse(String(init.body));
      calls.push(body.batch ?? [body]);
      const response = await handleProxy(new Request(url, init), env);
      if (lose) {
        // D1 committed the batch, but its response never arrived.
        lose = false;
        throw new Error("response lost");
      }
      return response;
    }) as typeof fetch;
    const d1 = d1Http({ endpoint: "https://proxy.example/query", token: TOKEN }, fetchImpl);
    const state = openReplicaState(path.join(root, `${name}-replica.db`));
    const same = () => {
      const rows = (db: Database.Database) => [...snapshotRows(db)].map((r) => JSON.stringify(r));
      const snap = new Database(file, { readonly: true });
      try {
        return JSON.stringify(rows(replica)) === JSON.stringify(rows(snap));
      } finally {
        snap.close();
      }
    };
    return { file, replica, state, calls, same, failNext: () => (fail = true), loseNext: () => (lose = true), run: () => tick(file, state, d1) };
  }

  it("is created with the snapshot's schema", () => {
    const strip = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
    expect(strip(fs.readFileSync(MIGRATION, "utf8"))).toBe(strip(SNAPSHOT_SCHEMA));
  });

  it("ships the snapshot, then only what changed, and keeps a failed batch queued", async () => {
    const r = setup("drain");
    const first = await r.run();
    expect(first.shipped).toBeGreaterThan(10);
    expect(r.same()).toBe(true);
    expect(await r.run()).toEqual({ queued: 0, shipped: 0 });

    // A new pin changes one book's row, the key list behind its link, and meta.
    c.data.prepare("INSERT INTO citekeys (calibre_uuid, citekey, book_id, title, pinned_at) VALUES ('uuid-2', 'writer1999crowds2', 'main:2', 'Crowds', '2026-10-28')").run();
    try {
      buildSnapshot(c, options([quotesSite]), r.file);
      r.failNext();
      await expect(r.run()).rejects.toThrow(/connection reset/);
      expect(pending(r.state).rows).toBeGreaterThan(0);
      const second = await r.run();
      expect(second.shipped).toBeLessThan(first.shipped);
      expect(r.same()).toBe(true);
    } finally {
      c.data.prepare("DELETE FROM citekeys WHERE calibre_uuid = 'uuid-2'").run();
    }

    // A site dropped from the settings is removed from the replica, links and all.
    buildSnapshot(c, options(), r.file);
    await r.run();
    expect(r.same()).toBe(true);
    expect(r.replica.prepare("SELECT COUNT(*) FROM links").pluck().get()).toBe(0);
    expect(pending(r.state)).toMatchObject({ rows: 0, removals: 0 });
  });

  it("writes meta's hash last, so the Worker never serves half a publication", async () => {
    const r = setup("order");
    await r.run();
    const last = r.calls.at(-1)!.at(-1)!;
    expect(last.sql).toMatch(/INTO meta/);
    expect(last.params?.[0]).toBe("hash");
  });

  it("resends what a lost response may have applied", async () => {
    const r = setup("lost");
    await r.run();
    const pin = (key: string | null) => {
      c.data.prepare("DELETE FROM citekeys WHERE calibre_uuid = 'uuid-2'").run();
      if (key) c.data.prepare("INSERT INTO citekeys (calibre_uuid, citekey, book_id, title, pinned_at) VALUES ('uuid-2', ?, 'main:2', 'Crowds', '2026-10-28')").run(key);
    };
    try {
      // A change that reached D1 unacknowledged, then reverted: the reverted value is sent again.
      pin("lostkey2026");
      buildSnapshot(c, options([quotesSite]), r.file);
      r.loseNext();
      await expect(r.run()).rejects.toThrow(/response lost/);
      pin(null);
      buildSnapshot(c, options([quotesSite]), r.file);
      await r.run();
      expect(r.same()).toBe(true);
      // Rows that reached D1 unacknowledged and then left the snapshot are deleted.
      buildSnapshot(c, options(), r.file);
      buildSnapshot(c, options([{ ...quotesSite, url: "https://other.example.org" }]), r.file);
      r.loseNext();
      await expect(r.run()).rejects.toThrow(/response lost/);
      buildSnapshot(c, options(), r.file);
      await r.run();
      expect(r.same()).toBe(true);
    } finally {
      pin(null);
    }
  });

  it("lets one tick at a time ship", async () => {
    const r = setup("lease");
    const [a, b] = await Promise.all([r.run(), r.run()]);
    expect([a.busy, b.busy].filter(Boolean)).toHaveLength(1);
    expect(r.same()).toBe(true);
    expect((await r.run()).busy).toBeUndefined();
  });

  it("writes a SQL file that loads the snapshot into an empty replica", () => {
    const file = path.join(root, "script.db");
    buildSnapshot(c, options([quotesSite]), file);
    const snap = new Database(file, { readonly: true });
    const local = new Database(":memory:");
    local.exec(fs.readFileSync(MIGRATION, "utf8"));
    local.exec(replicaScript(snap));
    const rows = (db: Database.Database) => [...snapshotRows(db)].map((x) => JSON.stringify(x));
    expect(rows(local)).toEqual(rows(snap));
    expect(rows(snap).some((x) => x.includes("\\u0000"))).toBe(true);
    snap.close();
  });

  it("is what the Worker serves, and nothing else", async () => {
    const r = setup("worker");
    const env = { DB: workerBinding(r.replica) };
    const get = (p: string, init?: RequestInit) => handle(new Request(`https://library.example.org${p}`, init), env);
    expect((await get("/")).status).toBe(503);
    await r.run();
    const page = await get("/books/main%3A1");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Quotes from this book on Quotes");
    expect((await get("/books/main%3A1", { headers: { "if-none-match": page.headers.get("etag")! } })).status).toBe(304);
    expect(JSON.parse(await (await get("/site.json")).text()).kind).toBe("library");
    expect((await get("/favicon.png")).headers.get("content-type")).toBe("image/png");
    expect((await get("/books", { method: "POST" })).status).toBe(405);
    for (const p of ["/admin", "/mcp", "/api/books", "/query"]) expect((await get(p)).status, p).toBe(404);
  });
});
