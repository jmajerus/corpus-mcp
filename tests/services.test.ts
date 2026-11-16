import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { dependencyTargets, SUBSCRIBER_FRESH_MS, terminologySubscribers } from "../src/admin.js";
import { loadConfig } from "../src/config.js";

let server: http.Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/** A terminology-mcp stand-in answering /api/subscribers with the given body. */
async function terminology(body: unknown): Promise<string> {
  server = http.createServer((req, res) => {
    if (req.url !== "/api/subscribers") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

it("probes the services corpus-mcp is configured to use, from the settings it uses them by", () => {
  const config = loadConfig({
    CORPUS_CALIBRE_WEB_URL: "http://books.lan:8083", CORPUS_TERMINOLOGY_URL: "http://terms.lan:8000/",
    CORPUS_QUOTE_MCP_URL: "http://quotes.lan:8000", CORPUS_ZOTERO_API: "http://zotero.lan:23119/api", CORPUS_ZOTERO_LIBRARY: "users/1",
  });
  expect(dependencyTargets(config)).toEqual([
    { name: "calibre-web", url: "http://books.lan:8083", setting: "CORPUS_CALIBRE_WEB_URL" },
    { name: "zotero", url: "http://zotero.lan:23119/api", setting: "CORPUS_ZOTERO_API" },
    { name: "terminology-mcp", url: "http://terms.lan:8000/", setting: "CORPUS_TERMINOLOGY_URL" },
    { name: "quote-mcp", url: "http://quotes.lan:8000/", setting: "CORPUS_QUOTE_MCP_URL" },
  ]);
  // A service turned off isn't probed, and nothing else is listed unless CORPUS_NEIGHBORS names it.
  const off = loadConfig({ CORPUS_TERMINOLOGY_URL: "off", CORPUS_QUOTE_MCP_URL: "off" });
  expect(dependencyTargets(off).map((t) => t.name)).toEqual(["calibre-web"]);
  expect(off.admin!.neighbors).toEqual([]);
  expect(loadConfig({ CORPUS_NEIGHBORS: "portal=http://portal.lan:8080/" }).admin!.neighbors).toEqual([{ name: "portal", url: "http://portal.lan:8080/" }]);
});

it("lists the other terminology subscribers, fresh when they reported progress recently", async () => {
  const now = Date.parse("2026-11-16T15:30:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  const url = await terminology({ subscribers: [
    { id: "concept-clusters", label: "Concept Clusters", lastSeen: at(60_000), pending: 0, pendingBreaking: 0, blocked: null },
    { id: "corpus-mcp", label: "corpus-mcp", lastSeen: at(1000), pending: 0 },
    { id: "iasp-mcp", label: "IASP Authoring MCP", lastSeen: at(SUBSCRIBER_FRESH_MS + 60_000), pending: 3, pendingBreaking: 1 },
    { id: "quote-mcp", label: "Quote MCP", lastSeen: at(5000), pending: 2, blocked: { at: 400 } },
  ] });
  const result = await terminologySubscribers(loadConfig({ CORPUS_TERMINOLOGY_URL: url }), now);
  expect(result).toEqual({ url, subscribers: [
    { id: "concept-clusters", label: "Concept Clusters", last_seen: at(60_000), fresh: true, pending: 0, pending_breaking: 0, blocked: false },
    { id: "iasp-mcp", label: "IASP Authoring MCP", last_seen: at(SUBSCRIBER_FRESH_MS + 60_000), fresh: false, pending: 3, pending_breaking: 1, blocked: false },
    { id: "quote-mcp", label: "Quote MCP", last_seen: at(5000), fresh: true, pending: 2, pending_breaking: 0, blocked: true },
  ] });
});

it("says why when the subscriber list can't be read, and skips it when terminology is off", async () => {
  const url = await terminology({});
  server!.close();
  const result = await terminologySubscribers(loadConfig({ CORPUS_TERMINOLOGY_URL: url }));
  expect(result).toMatchObject({ url, subscribers: [] });
  expect(result!.error).toMatch(/can't be read/);
  server = undefined;
  expect(await terminologySubscribers(loadConfig({ CORPUS_TERMINOLOGY_URL: "off" }))).toBeNull();
});
