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
