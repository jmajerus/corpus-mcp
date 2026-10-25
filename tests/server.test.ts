import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import { serveHttp } from "../src/server.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

let root: string;
let server: Awaited<ReturnType<typeof serveHttp>>;
let base: string;

beforeAll(async () => {
  root = tempDir();
  makeLibrary(root, "main", [{ id: 1, title: "Networks", authors: ["Ann Author"], files: { pdf: makePdf({ pages: [["Weak ties carry novel information"]] }) } }]);
  const config: Config = { booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0 };
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  db.close();
  server = await serveHttp(config);
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
    "cite_passage", "corpus_status", "get_book_outline", "get_tag_vocabulary", "list_books", "list_shelves", "list_tags", "pin_citekey",
    "propose_tags", "read_book", "render_page", "search_corpus", "tagging_worklist",
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
  const page = await fetch(`${base}/review`);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("<title>Tag Review</title>");
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
  expect(notJson.status).toBe(400);
  const approved = await fetch(`${base}/api/tag-proposals/${uuid}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve", tags: ["social-sciences.sociology"] }),
  });
  expect(await approved.json()).toEqual({ status: "approved", tags: ["social-sciences.sociology"] });
  expect(approved.headers.get("access-control-allow-origin")).toBeNull();
  expect((await (await fetch(`${base}/api/tag-plan`)).json()).books[0].add).toEqual(["social-sciences.sociology"]);
});
