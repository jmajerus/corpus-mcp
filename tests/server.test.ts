import fs from "node:fs";
import http from "node:http";
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
let mcpToken: string;
const calibreCalls: { command: string; stdin?: string }[] = [];
let refreshes = 0;
// A stand-in quote-mcp: its /api/corpus/quotes, holding what the reader saved.
let quoteMcp: http.Server;
const saves: Record<string, unknown>[] = [];
let quoteMcpQuotes: unknown[] = [];

beforeAll(async () => {
  root = tempDir();
  makeLibrary(root, "main", [{ id: 1, title: "Networks", authors: ["Ann Author"], files: { pdf: makePdf({ pages: [["Weak ties carry novel information"]] }) } }]);
  const team = "https://team.example.com";
  quoteMcp = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET" && req.url?.startsWith("/api/corpus/quotes?book=")) return send(200, { book: {}, quotes: quoteMcpQuotes });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    saves.push(body);
    if (body.text === "not in the book") return send(422, { error: "no-match", message: "The passage isn't in the book.", closest: [{ page: 1 }], book: {} });
    send(201, { saved: true, status: "verified", anchored: true, warnings: [], book: {}, quote: { id: 900 } });
  });
  await new Promise<void>((done) => quoteMcp.listen(0, "127.0.0.1", done));
  const config: Config = { booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
    citekeyPreset: "author-year-word", vocabularyPath: path.join(import.meta.dirname, "vocabulary.json"),
    admin: { access: { teamDomain: team }, neighbors: [], source: "x", sshKey: "x", refreshUnit: "x",
      refreshLog: path.join(root, "refresh.log"), syncStatus: path.join(root, "sync-status.json"),
      quoteMcpUrl: `http://127.0.0.1:${(quoteMcp.address() as AddressInfo).port}` } };
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  db.close();

  // A stand-in Cloudflare Access: its own signing key, tokens from two of its applications, and a token
  // signed by a key that is not the team's.
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const sign = (audience: string, key = privateKey) => new SignJWT({ email: "me@example.com" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(team).setAudience(audience).setSubject("user-1").setIssuedAt().setExpirationTime("5m").sign(key);
  token = await sign("corpus-aud");
  otherToken = await sign("corpus-aud", (await generateKeyPair("RS256")).privateKey);
  mcpToken = await sign("mcp-aud");
  server = await serveHttp(config, {
    requestAccess: {teamDomain:team, lanHosts:["corpus-mcp", "corpus-mcp.localdomain"]},
    accessKeys: createLocalJWKSet({ keys: [jwk] }),
    jobCommands: {
      async refresh(log) { refreshes++; log("refreshed\n"); },
      async calibre(command, stdin, log) {
        calibreCalls.push({ command, stdin });
        log(`ran ${command}\n`);
        if (command === "metadata-preview") return;
        if (command === "metadata-apply") {
          const book = JSON.parse(stdin!).books[0];
          log("@@change " + JSON.stringify({calibre_id:book.calibre_id,uuid:book.uuid,title:book.after.title,metadata:{before:book.before,after:book.after}}) + "\n");
          return;
        }
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
  quoteMcp.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("answers health checks, with what the last deploy installed", async () => {
  expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, books: 1, deployed: null });
  const record = path.join(root, "deployed.json");
  fs.writeFileSync(record, JSON.stringify({ branch: "fix", pr: 7, commit: "abc1234" }));
  try {
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, deployed: { branch: "fix", pr: 7 } });
  } finally {
    fs.rmSync(record);
  }
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
    "add_provisional_term", "cite_passage", "cite_quote", "corpus_status", "delete_quote", "get_book_outline", "get_quote", "get_tag_vocabulary", "list_books", "list_shelves",
    "list_tags", "pin_citekey", "propose_tags", "read_book", "render_page", "save_quote", "search_corpus", "search_quotes", "tagging_worklist", "update_quote", "vocabulary_report",
  ]);
  const search = await client.callTool({ name: "search_corpus", arguments: { query: "novel information" } });
  expect(JSON.parse((search.content as { text: string }[])[0].text).results[0]).toMatchObject({ book_id: "main:1", page: 1 });
  const missing = await client.callTool({ name: "get_book_outline", arguments: { book_id: "main:99" } });
  expect(missing.isError).toBe(true);
  const image = await client.callTool({ name: "render_page", arguments: { book_id: "main:1", page: 1 } });
  expect((image.content as { type: string }[])[0].type).toBe("image");
  const retired = await client.callTool({ name: "save_quote", arguments: { book_id: "main:1", text: "novel information" } });
  expect(retired.isError).toBe(true);
  expect((retired.content as { text: string }[])[0].text).toContain("quote-mcp's add_quote");
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
    .toEqual({ can_write: true, identity: { subject: "user-1", email: "me@example.com", via: "access" } });
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

it("reports Zotero as unconfigured, and refuses its job", async () => {
  expect(await (await fetch(`${base}/api/zotero`)).json()).toMatchObject({ configured: false, books: { total: 1, not_found: 1 } });
  expect((await (await fetch(`${base}/api/books/main:1`)).json()).zotero).toBeNull();
  const job = await (await fetch(`${base}/api/admin/jobs`, { method: "POST", headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
    body: JSON.stringify({ kind: "zotero", mode: "apply" }) })).json();
  let row;
  for (let i = 0; i < 50 && (!row || row.status === "running"); i++) {
    await new Promise((r) => setTimeout(r, 20));
    row = await (await fetch(`${base}/api/admin/jobs/${job.id}`)).json();
  }
  expect(row).toMatchObject({ kind: "zotero", status: "failed", log: expect.stringMatching(/Zotero is not configured/) });
});

it("serves page scripts that parse, with no escapes lost to the TypeScript template literal", async () => {
  for (const page of ["admin", "admin/books", "admin/books/main:1", "admin/categories", "admin/citekeys", "admin/proposals", "admin/shelves",
    "admin/jobs", "admin/jobs/1", "admin/changes", "admin/books/main:1/read", "admin/zotero"]) {
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

it("shows a book's quotes from quote-mcp in the reader, and saves selections there with Access", async () => {
  const { file } = await (await fetch(`${base}/api/books/main%3A1`)).json();
  const anchor = { sha256: file.sha256, start_page: 0, start_offset: 10, end_page: 0, end_offset: 33 };
  quoteMcpQuotes = [
    { id: 7, comment: "why", tags: ["ties"], flags: [], admin_path: "/admin/quotes/7", anchor },
    { id: 8, comment: null, tags: ["lost"], flags: ["anchor_lost"], admin_path: "/admin/quotes/8", anchor: { ...anchor, sha256: "an-earlier-file" } },
  ];
  const reader = await (await fetch(`${base}/api/books/main%3A1/pages?start=1&count=2`)).json();
  expect(reader).toMatchObject({ book_id: "main:1", start: 1, end: 1 });
  expect(reader.quotes).toEqual([{ id: 7, start_page: 1, start_offset: 10, end_page: 1, end_offset: 33, comment: "why", tags: ["ties"], flags: [], admin_path: "/admin/quotes/7" }]);
  // Suggestions come from all the book's quotes, highlighted or not.
  expect(reader.quote_tags).toEqual(["lost", "ties"]);

  expect((await asAdmin("/api/books/main%3A1/quotes", { text: "novel information" }, {})).status).toBe(401);
  const saved = await (await asAdmin("/api/books/main%3A1/quotes", { text: "novel information", page: 1, comment: "c", tags: ["t"], request_id: "r1" })).json();
  expect(saved).toEqual({ saved: true, quote: { id: 900 }, warnings: [] });
  expect(saves.at(-1)).toMatchObject({ work: expect.any(String), text: "novel information", page: 1, comment: "c", tags: ["t"], request_id: "r1", by: "me@example.com" });
  const missed = await (await asAdmin("/api/books/main%3A1/quotes", { text: "not in the book" })).json();
  expect(missed).toEqual({ saved: false, reason: "The passage isn't in the book.", closest: [{ page: 1 }] });

  // /admin/quotes opens quote-mcp's admin: on this host with quote-mcp's name, else at CORPUS_QUOTE_MCP_URL.
  const redirect = await fetch(`${base}/admin/quotes?work=x`, { redirect: "manual" });
  expect([redirect.status, redirect.headers.get("location")]).toEqual([302, `http://127.0.0.1:${(quoteMcp.address() as AddressInfo).port}/admin/quotes?work=x`]);
  const named = await new Promise<http.IncomingMessage>((done) => http.get(`${base}/admin/quotes/7`, { headers: { host: "corpus-mcp.localdomain:8000" } }, done));
  expect([named.statusCode, named.headers.location]).toEqual([302, "http://quote-mcp.localdomain:8000/admin/quotes/7"]);
  named.resume();
  const tunnelled = await new Promise<http.IncomingMessage>((done) => http.get(`${base}/admin/quotes`,
    { headers: { host: "corpus-mcp.majerus.us", "cf-ray": "test", "x-forwarded-proto": "https", "cf-access-jwt-assertion": token } }, done));
  expect([tunnelled.statusCode, tunnelled.headers.location]).toEqual([302, "https://quote-mcp.majerus.us/admin/quotes"]);
  tunnelled.resume();
});

it("accepts a team-signed token from any Access application at the HTTP boundary", async () => {
  const request = (path: string, assertion?: string) => fetch(base+path,{headers:{Host:"public.example","cf-ray":"test", ...(assertion ? {"cf-access-jwt-assertion":assertion} : {})}});
  expect((await request("/api/whoami")).status).toBe(401);
  expect((await request("/api/whoami", otherToken)).status).toBe(403);
  expect((await request("/api/whoami", mcpToken)).status).toBe(200);
  expect((await request("/api/whoami", token)).status).toBe(200);
  expect((await request("/mcp", otherToken)).status).toBe(403);
  expect((await request("/mcp", token)).status).toBe(405);
});

it("serves the holdings feed on the LAN, with a 304 for an unchanged ETag, and never through the tunnel", async () => {
  const res = await fetch(`${base}/api/holdings/books`);
  expect(res.status).toBe(200);
  const etag = res.headers.get("etag")!;
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  expect(await res.json()).toMatchObject({ version: 1, books: [{ book_id: "main:1", title: "Networks", has_text: true }] });
  const again = await fetch(`${base}/api/holdings/books`, { headers: { "if-none-match": etag } });
  expect([again.status, again.headers.get("etag")]).toEqual([304, etag]);
  const tunnelled = await fetch(`${base}/api/holdings/books`, { headers: { Host: "public.example", "cf-ray": "test", "cf-access-jwt-assertion": token } });
  expect(tunnelled.status).toBe(403);
});

it("verifies and anchors quote-mcp's quotes on the LAN only", async () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const verified = await post("/api/verify", { book: "main:1", text: "Weak ties carry novel information" });
  expect(verified.status).toBe(200);
  const { anchor } = await verified.json();
  expect((await post("/api/anchors", { quote_id: 41, anchor })).status).toBe(201);
  const feed = await (await fetch(`${base}/api/anchors/changes?since=0`)).json();
  expect(feed.changes.map((c: { quote_id: number; kind: string }) => [c.quote_id, c.kind])).toEqual([[41, "stored"]]);
  expect((await fetch(`${base}/api/anchors/41`, { method: "DELETE" })).status).toBe(204);
  expect((await fetch(`${base}/api/anchors/41`, { method: "DELETE" })).status).toBe(404);
  expect((await fetch(`${base}/api/verify`, { method: "POST", body: "book=main:1" })).status).toBe(400);
  const tunnel = { Host: "public.example", "cf-ray": "test", "cf-access-jwt-assertion": token };
  expect((await post("/api/verify", { book: "main:1", text: "Weak ties" }, tunnel)).status).toBe(403);
  expect((await post("/api/anchors", { quote_id: 42, anchor }, tunnel)).status).toBe(403);
  expect((await fetch(`${base}/api/anchors/changes`, { headers: tunnel })).status).toBe(403);
});

it("applies reviewed metadata in one authenticated job using identical preview/apply plans", async () => {
  const book = await (await fetch(`${base}/api/books/main%3A1`)).json();
  const body = { title: "Networks, revised", authors: ["Ann Author", "Bob Writer"], year:2024, before: { title: book.title, authors: book.authors, year:book.publication_year.calibre } };
  const send = (headers: Record<string,string>, value = body) => fetch(`${base}/api/books/main%3A1/metadata`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  expect((await send({})).status).toBe(401);
  expect((await send({"cf-access-jwt-assertion":token},{...body,before:{title:"stale",authors:[]}})).status).toBe(400);
  const count = refreshes;
  const response = await send({"cf-access-jwt-assertion":token});expect(response.status).toBe(202);
  const job = await waitForJob((await response.json()).id);
  expect(job.status).toBe("succeeded");
  expect(calibreCalls.slice(-2).map(c=>c.command)).toEqual(["metadata-preview","metadata-apply"]);
  expect(calibreCalls.at(-2)?.stdin).toBe(calibreCalls.at(-1)?.stdin);
  expect(JSON.parse(calibreCalls.at(-1)!.stdin!).books[0]).toMatchObject({calibre_id:1,uuid:book.uuid,before:body.before,after:{title:body.title,authors:body.authors,year:body.year}});
  expect(refreshes).toBe(count+1);
  expect(job.items).toHaveLength(1);expect(job.items[0].metadata).toEqual({before:body.before,after:{title:body.title,authors:body.authors,year:body.year}});
  const audit=await(await fetch(`${base}/api/changes?job=${job.id}`)).json();
  expect(audit.rows).toEqual([expect.objectContaining({kind:"metadata_corrected",actor:"me@example.com"})]);
});

it("renders an actual PDF cover for metadata review", async () => {
  const response = await fetch(`${base}/api/books/main%3A1/cover`);
  expect(response.status).toBe(200);expect(response.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await response.arrayBuffer()).subarray(1,4).toString()).toBe("PNG");
});

it("accepts year-only corrections and rejects invalid or stale reviewed years", async () => {
  const book=await(await fetch(`${base}/api/books/main%3A1`)).json();
  const body={title:book.title,authors:book.authors,year:2023,before:{title:book.title,authors:book.authors,year:book.publication_year.calibre}};
  const send=(value:unknown)=>fetch(`${base}/api/books/main%3A1/metadata`,{method:"POST",headers:{"content-type":"application/json","cf-access-jwt-assertion":token},body:JSON.stringify(value)});
  expect((await send({...body,year:2023.5})).status).toBe(400);
  expect((await send({...body,before:{...body.before,year:1900}})).status).toBe(400);
  const response=await send(body);expect(response.status).toBe(202);
  const job=await waitForJob((await response.json()).id);expect(job.status).toBe("succeeded");
  expect(job.params.plan.books[0]).toMatchObject({before:body.before,after:{title:book.title,authors:book.authors,year:2023}});
});
