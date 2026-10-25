import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import { serveHttp } from "../src/server.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

let root: string;
let server: Awaited<ReturnType<typeof serveHttp>>;
let base: string;
let token: string;
let otherToken: string;
const calibreCalls: { command: string; stdin?: string }[] = [];
let refreshes = 0;

beforeAll(async () => {
  root = tempDir();
  makeLibrary(root, "main", [{ id: 1, title: "Networks", authors: ["Ann Author"], files: { pdf: makePdf({ pages: [["Weak ties carry novel information"]] }) } }]);
  const team = "https://team.example.com";
  const config: Config = { booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
    admin: { access: { teamDomain: team, audience: "corpus-aud" }, neighbors: [], source: "x", sshKey: "x", refreshUnit: "x",
      refreshLog: path.join(root, "refresh.log"), syncStatus: path.join(root, "sync-status.json") } };
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  db.close();

  // A stand-in Cloudflare Access: its own signing key, and tokens for the corpus audience and another one.
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const sign = (audience: string) => new SignJWT({ email: "me@example.com" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(team).setAudience(audience).setSubject("user-1").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  token = await sign("corpus-aud");
  otherToken = await sign("some-other-app");
  server = await serveHttp(config, {
    accessKeys: createLocalJWKSet({ keys: [jwk] }),
    jobCommands: {
      async refresh(log) { refreshes++; log("refreshed\n"); },
      async calibre(command, stdin, log) {
        calibreCalls.push({ command, stdin });
        log(`ran ${command}\n`);
        // Like calibre-tags.sh: one structured line per book, split across chunks to test reassembly.
        for (const book of stdin ? (JSON.parse(stdin) as { books: { calibre_id: number; uuid: string; title: string; add?: string[] }[] }).books : []) {
          const line = `@@change ${JSON.stringify({ calibre_id: book.calibre_id, uuid: book.uuid, title: book.title, added: book.add ?? [], removed: [] })}\n`;
          log(line.slice(0, 10));
          log(line.slice(10));
        }
      },
    },
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("answers health checks", async () => {
  expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, books: 1 });
});

it("answers CORS preflight and refuses GET instead of holding a stream open", async () => {
  const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  const get = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
  expect(get.status).toBe(405);
  expect(get.headers.get("allow")).toBe("POST, OPTIONS");
});

it("serves the tools over Streamable HTTP", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "cite_passage", "cite_quote", "corpus_status", "delete_quote", "get_book_outline", "get_quote", "get_tag_vocabulary", "list_books", "list_shelves",
    "list_tags", "pin_citekey", "propose_tags", "read_book", "render_page", "save_quote", "search_corpus", "search_quotes", "tagging_worklist", "update_quote",
  ]);
  const search = await client.callTool({ name: "search_corpus", arguments: { query: "novel information" } });
  expect(JSON.parse((search.content as { text: string }[])[0].text).results[0]).toMatchObject({ book_id: "main:1", page: 1 });
  const missing = await client.callTool({ name: "get_book_outline", arguments: { book_id: "main:99" } });
  expect(missing.isError).toBe(true);
  const image = await client.callTool({ name: "render_page", arguments: { book_id: "main:1", page: 1 } });
  expect((image.content as { type: string }[])[0].type).toBe("image");
  await client.close();
});

it("serves the tag review page and its API", async () => {
  const old = await fetch(`${base}/review`, { redirect: "manual" });
  expect([old.status, old.headers.get("location")]).toEqual([302, "/admin/proposals"]);
  const page = await fetch(`${base}/admin/proposals`);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("<title>Proposals</title>");
  expect((await (await fetch(`${base}/api/vocabulary`)).json()).tags).toContainEqual({
    tag: "social-sciences.psychology.social-psychology", label: "Social Sciences › Psychology › Social Psychology",
  });

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const proposed = await client.callTool({ name: "propose_tags", arguments: {
    book_id: "main:1", tags: ["Social Sciences.Sociology"], rationale: "About weak ties in social networks." } });
  expect(proposed.isError).toBeFalsy();
  await client.close();

  const list = await (await fetch(`${base}/api/tag-proposals?status=pending`)).json();
  expect(list.counts.pending).toBe(1);
  const uuid = list.proposals[0].calibre_uuid;
  const notJson = await fetch(`${base}/api/tag-proposals/${uuid}`, { method: "POST", body: "action=approve" });
  expect(notJson.status).toBe(401);
  const approve = (headers: Record<string, string>) => fetch(`${base}/api/tag-proposals/${uuid}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ action: "approve", tags: ["social-sciences.sociology"] }),
  });
  // Direct LAN requests carry no Access token, so they cannot change anything.
  expect((await approve({})).status).toBe(401);
  expect((await approve({ "cf-access-jwt-assertion": otherToken })).status).toBe(403);
  const approved = await approve({ "cf-access-jwt-assertion": token });
  expect(await approved.json()).toEqual({ status: "approved", tags: ["social-sciences.sociology"] });
  expect(approved.headers.get("access-control-allow-origin")).toBeNull();
  expect((await (await fetch(`${base}/api/tag-plan`)).json()).books[0].add).toEqual(["social-sciences.sociology"]);
});

const waitForJob = async (id: number) => {
  for (let i = 0; i < 50; i++) {
    const job = await (await fetch(`${base}/api/admin/jobs/${id}`)).json();
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} did not finish`);
};

const startJob = (body: object, headers: Record<string, string> = { "cf-access-jwt-assertion": token }) =>
  fetch(`${base}/api/admin/jobs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

it("serves the admin dashboard and metrics, read-only without Access", async () => {
  expect(await (await fetch(`${base}/admin`)).text()).toContain("<title>Corpus Admin</title>");
  const metrics = await (await fetch(`${base}/api/admin/metrics`)).json();
  expect(metrics).toMatchObject({ service: { access_configured: true }, index: { counts: expect.any(Array) }, neighbors: [] });
  expect(metrics.index.runs[0]).toMatchObject({ extracted: 1 });
  expect(await (await fetch(`${base}/api/whoami`)).json()).toMatchObject({ can_write: false });
  expect(await (await fetch(`${base}/api/whoami`, { headers: { "cf-access-jwt-assertion": token } })).json())
    .toEqual({ can_write: true, identity: { subject: "user-1", email: "me@example.com" } });
  expect((await startJob({ kind: "backup" }, {})).status).toBe(401);
});

it("runs jobs: local ones directly, Calibre changes only as an apply of their own preview", async () => {
  const backup = await waitForJob((await (await startJob({ kind: "backup" })).json()).id);
  expect(backup).toMatchObject({ status: "succeeded", requested_by: "me@example.com" });
  expect(backup.log).toMatch(/Backed up to .*data-\d{4}-\d{2}-\d{2}\.db/);

  // The approved proposal from the review test is the tag plan.
  expect(await (await startJob({ kind: "tags", mode: "apply" })).json()).toEqual({ error: "Preview first, then apply that preview." });
  const preview = await waitForJob((await (await startJob({ kind: "tags", mode: "preview" })).json()).id);
  expect(preview.status).toBe("succeeded");
  expect(calibreCalls.at(-1)?.command).toBe("tags-preview");
  const plan = JSON.parse(calibreCalls.at(-1)!.stdin!);
  expect(plan.books[0]).toMatchObject({ calibre_id: 1, add: ["social-sciences.sociology"] });

  const before = refreshes;
  const apply = await waitForJob((await (await startJob({ kind: "tags", mode: "apply", preview_of: preview.id })).json()).id);
  expect(apply).toMatchObject({ status: "succeeded", preview_of: preview.id });
  expect(calibreCalls.at(-1)).toEqual({ command: "tags-apply", stdin: JSON.stringify(plan) });
  // Structured lines become the job's items, stay out of its log, and an apply's go to the change log.
  expect(preview.items).toEqual([{ calibre_id: 1, uuid: "uuid-1", title: "Networks", added: ["social-sciences.sociology"], removed: [] }]);
  expect(apply.log).not.toContain("@@change");
  const logged = await (await fetch(`${base}/api/changes?job=${apply.id}`)).json();
  expect(logged.rows.map((r: { kind: string; detail: string; actor: string; source: string }) => [r.kind, r.detail, r.actor, r.source]))
    .toEqual([["tag_added", "social-sciences.sociology", "me@example.com", "admin-job"]]);
  expect((await (await fetch(`${base}/api/changes?job=${preview.id}`)).json()).total).toBe(0);
  expect(refreshes).toBe(before + 1); // an apply refreshes the index afterwards

  const convert = await waitForJob((await (await startJob({ kind: "convert", mode: "preview" })).json()).id);
  expect(calibreCalls.at(-1)).toEqual({ command: "convert-preview", stdin: undefined });
  expect((await (await startJob({ kind: "tags", mode: "apply", preview_of: convert.id })).json()).error).toMatch(/not a successful tags preview/);

  const jobs = await (await fetch(`${base}/api/admin/jobs`)).json();
  expect(jobs.jobs.map((j: { kind: string; mode: string }) => `${j.kind}:${j.mode}`).slice(0, 4))
    .toEqual(["convert:preview", "tags:apply", "tags:preview", "backup:apply"]);
});

it("serves page scripts that parse, with no escapes lost to the TypeScript template literal", async () => {
  for (const page of ["admin", "admin/books", "admin/books/main:1", "admin/categories", "admin/citekeys", "admin/proposals", "admin/shelves",
    "admin/jobs", "admin/jobs/1", "admin/changes", "admin/quotes", "admin/quotes/1", "admin/books/main:1/read"]) {
    const html = await (await fetch(`${base}/${page}`)).text();
    expect(html).toContain('aria-label="Admin pages"');
    // The layout's helpers and the page's own script are separate classic scripts sharing one scope.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(2);
    expect(() => new Function(scripts.join("\n;\n"))).not.toThrow();
  }
});

const asAdmin = (path: string, body: object, headers: Record<string, string> = { "cf-access-jwt-assertion": token }) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

it("lists books with derived states and facets, and shows one book", async () => {
  const list = await (await fetch(`${base}/api/books`)).json();
  expect(list.total).toBe(1);
  expect(list.rows[0]).toMatchObject({ book_id: "main:1", format: "pdf", citekey_state: expect.any(String), isbn_state: "none" });
  expect(list.facets.format).toEqual({ pdf: 1 });
  expect((await (await fetch(`${base}/api/books?format=epub`)).json()).total).toBe(0);
  expect((await fetch(`${base}/api/books?category=bogus`)).status).toBe(400);
  const book = await (await fetch(`${base}/api/books/main%3A1`)).json();
  expect(book).toMatchObject({ book_id: "main:1", title: "Networks", file: { format: "pdf", pages: 1 }, calibre_web_url: null });
});

it("lets a signed-in person set a book's categories and citekey; LAN requests cannot", async () => {
  expect((await asAdmin("/api/books/main%3A1/categories", { tags: ["trivia"] }, {})).status).toBe(401);
  const set = await (await asAdmin("/api/books/main%3A1/categories", { tags: ["Trivia"] })).json();
  expect(set).toMatchObject({ status: "approved", tags: ["trivia"], pending_in_calibre: { add: ["trivia"], remove: [] } });
  const book = await (await fetch(`${base}/api/books/main%3A1`)).json();
  expect(book.categories).toMatchObject({ state: "not_applied", approved: [{ tag: "trivia" }], proposal: { proposed_by: "me@example.com" } });

  // A book page previews just that book.
  const preview = await waitForJob((await (await startJob({ kind: "tags", mode: "preview", books: ["main:1"] })).json()).id);
  expect(preview.params).toMatchObject({ books: ["main:1"], plan: { books: [{ calibre_id: 1, add: ["trivia"] }] } });

  expect((await (await asAdmin("/api/books/main%3A1/citekey", { citekey: "author2000networks" })).json())).toMatchObject({ status: "pinned" });
  expect((await (await asAdmin("/api/books/main%3A1/citekey", { citekey: null })).json())).toEqual({ status: "unpinned", book_id: "main:1", citekey: "author2000networks" });
  const changes = await (await fetch(`${base}/api/changes?q=main:1&source=admin`)).json();
  expect(changes.rows.map((r: { kind: string }) => r.kind)).toEqual(["citekey_unpinned", "citekey_pinned", "categories_edited"]);
});

it("summarizes categories, citekeys, and shelves", async () => {
  const cats = await (await fetch(`${base}/api/categories`)).json();
  expect(cats).toMatchObject({ books: 1, tree: expect.any(Array), free: expect.any(Array) });
  expect(cats.tree.find((n: { tag: string }) => n.tag === "social-sciences").children.length).toBeGreaterThan(0);
  expect(await (await fetch(`${base}/api/citekeys`)).json()).toEqual({ pinned: [] });
  expect((await (await fetch(`${base}/api/shelves`)).json()).shelves).toEqual([]);
});

it("saves quotes from the admin only with Access, and serves the reader's pages", async () => {
  expect((await asAdmin("/api/quotes", { book_id: "main:1", text: "Weak ties" }, {})).status).toBe(401);
  const saved = await (await asAdmin("/api/quotes", { book_id: "main:1", text: "novel information", page: 1, labels: ["test"] })).json();
  expect(saved).toMatchObject({ saved: true, quote: { text: "novel information", created_by: "me@example.com", source: "admin" } });
  const reader = await (await fetch(`${base}/api/books/main%3A1/pages?start=1&count=2`)).json();
  expect(reader).toMatchObject({ book_id: "main:1", page_count: 1, start: 1, end: 1, quotes: [{ id: saved.quote.id, start_page: 1 }] });
  expect((await (await fetch(`${base}/api/quotes?label=test`)).json()).total).toBe(1);
  expect((await (await asAdmin(`/api/quotes/${saved.quote.id}`, { note: "edited" })).json()).note).toBe("edited");
  expect(await (await asAdmin(`/api/quotes/${saved.quote.id}/delete`, {})).json()).toEqual({ deleted: saved.quote.id });
});
