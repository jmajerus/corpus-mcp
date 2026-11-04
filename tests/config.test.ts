import os from "node:os";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

it("gives the public catalogue its own port unless it's turned off", () => {
  expect(loadConfig({ CORPUS_PUBLIC: "catalogue" }).public?.port).toBe(8001);
  expect(loadConfig({ CORPUS_PUBLIC: "catalogue", CORPUS_PUBLIC_PORT: "8080" }).public?.port).toBe(8080);
  expect(loadConfig({ CORPUS_PUBLIC: "catalogue", CORPUS_PUBLIC_PORT: "off" }).public?.port).toBeUndefined();
});

it("knows the server's LAN names, and who LAN edits are recorded as", () => {
  const access = loadConfig({}).admin!.access;
  expect(access.lanHosts).toContain(os.hostname());
  expect(access.lanActor).toBe("LAN");
  expect(loadConfig({ CORPUS_LAN_HOSTS: "corpus-mcp.localdomain, corpus" }).admin!.access.lanHosts).toEqual(["corpus-mcp.localdomain", "corpus"]);
  expect(loadConfig({ CORPUS_LAN_EDITS: "off" }).admin!.access.lanActor).toBeUndefined();
});

it("reads Zotero from zotero.org with a key, or from holdings-mcp without one", () => {
  const library = "users/1234567";
  expect(loadConfig({ CORPUS_ZOTERO_LIBRARY: library }).zotero).toBeUndefined();
  expect(loadConfig({ CORPUS_ZOTERO_LIBRARY: library, CORPUS_ZOTERO_API_KEY: "k" }).zotero)
    .toEqual({ library, apiKey: "k", apiBase: "https://api.zotero.org", intervalMinutes: 30 });
  const holdings = "http://holdings-mcp.localdomain:8000/zotero";
  // The key isn't sent anywhere but zotero.org.
  expect(loadConfig({ CORPUS_ZOTERO_LIBRARY: library, CORPUS_ZOTERO_API_KEY: "k", CORPUS_ZOTERO_API: holdings }).zotero)
    .toEqual({ library, apiKey: undefined, apiBase: holdings, intervalMinutes: 5 });
  expect(loadConfig({ CORPUS_ZOTERO_LIBRARY: library, CORPUS_ZOTERO_API: holdings, CORPUS_ZOTERO_INTERVAL_MINUTES: "2" }).zotero?.intervalMinutes).toBe(2);
  expect(loadConfig({ CORPUS_ZOTERO_LIBRARY: library, CORPUS_ZOTERO_API: holdings, CORPUS_ZOTERO_INTERVAL_MINUTES: "-1" }).zotero?.intervalMinutes).toBe(5);
  expect(loadConfig({ CORPUS_ZOTERO_API: holdings }).zotero).toBeUndefined();
});

it("follows terminology-mcp unless it's off, never polling faster than every 5 seconds", () => {
  expect(loadConfig({}).terminology).toEqual({ url: "http://terminology-mcp.localdomain:8000", intervalSeconds: 30 });
  expect(loadConfig({ CORPUS_TERMINOLOGY_URL: "off" }).terminology).toBeUndefined();
  expect(loadConfig({ CORPUS_TERMINOLOGY_INTERVAL_SECONDS: "10" }).terminology?.intervalSeconds).toBe(10);
  for (const typo of ["-30", "0", "1", "soon"]) expect(loadConfig({ CORPUS_TERMINOLOGY_INTERVAL_SECONDS: typo }).terminology?.intervalSeconds).toBe(30);
});
