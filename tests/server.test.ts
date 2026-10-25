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
      async calibre(command, stdin, log) { calibreCalls.push({ command, stdin }); log(`ran ${command}\n`); },
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
  expect(refreshes).toBe(before + 1); // an apply refreshes the index afterwards

  const convert = await waitForJob((await (await startJob({ kind: "convert", mode: "preview" })).json()).id);
  expect(calibreCalls.at(-1)).toEqual({ command: "convert-preview", stdin: undefined });
  expect((await (await startJob({ kind: "tags", mode: "apply", preview_of: convert.id })).json()).error).toMatch(/not a successful tags preview/);

  const jobs = await (await fetch(`${base}/api/admin/jobs`)).json();
  expect(jobs.jobs.map((j: { kind: string; mode: string }) => `${j.kind}:${j.mode}`).slice(0, 4))
    .toEqual(["convert:preview", "tags:apply", "tags:preview", "backup:apply"]);
});
