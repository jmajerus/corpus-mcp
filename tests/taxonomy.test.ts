import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDataStore } from "../src/data.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import { serveHttp } from "../src/server.js";
import { Overlay } from "../src/taxonomy/overlay.js";
import { mergeOverlay } from "../src/taxonomy/taxonomy.js";
import { Vocabulary, type VocabularyFile } from "../src/vocabulary.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "vocabulary.json"), "utf8")) as VocabularyFile;
const withTerm = (file: VocabularyFile, id: string, label: string, version: string): VocabularyFile => ({
  ...file, version, terms: [...file.terms, { id, label, parent: id.slice(0, id.lastIndexOf(".")) }],
});

describe("the overlay and its merge", () => {
  let root: string;
  let overlay: Overlay;
  beforeAll(() => {
    root = tempDir();
    overlay = new Overlay(openDataStore(path.join(root, "data.db")));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("adds provisional terms under supplied ones, with scope notes and status", () => {
    const term = overlay.add({ parent: "social-sciences.psychology", label: "Moral Injury", scopeNote: "Harm from violating one's own moral code." }, "agent");
    expect(term).toMatchObject({ path: "social-sciences.psychology.moral-injury", status: "provisional", id: expect.stringMatching(/^t_/) });
    const { vocabulary, orphans } = mergeOverlay(new Vocabulary(FIXTURE), overlay.list());
    expect(orphans).toEqual([]);
    expect(vocabulary.find("Moral Injury")).toMatchObject({
      tag: "social-sciences.psychology.moral-injury", label: "Social Sciences › Psychology › Moral Injury", status: "provisional",
      scopeNote: "Harm from violating one's own moral code.",
    });
    expect(vocabulary.version).toMatch(/^test-1\+overlay\./);
    expect(() => overlay.add({ parent: "social-sciences.psychology", label: "Moral injury" }, "agent")).toThrow(/already has/);
    expect(() => overlay.add({ parent: null, label: "Bad.Label" }, "agent")).toThrow(/contains/);
  });

  it("leaves the supplied version alone while the overlay adds nothing", () => {
    expect(mergeOverlay(new Vocabulary(FIXTURE), []).vocabulary.version).toBe("test-1");
  });

  it("gives way when the supplied vocabulary gains the same path, and books keep the tag", () => {
    const base = new Vocabulary(withTerm(FIXTURE, "social-sciences.psychology.moral-injury", "Moral Injury", "test-2"));
    const superseded = overlay.supersede(new Set(base.terms.map((t) => t.tag)), "vocabulary");
    expect(superseded.map((t) => t.path)).toEqual(["social-sciences.psychology.moral-injury"]);
    const merged = mergeOverlay(base, overlay.list()).vocabulary;
    expect(merged.find("social-sciences.psychology.moral-injury")?.status).toBeUndefined();
    expect(merged.version).toBe("test-2");
    expect(overlay.events({ limit: 5 }).map((e) => e.kind)).toEqual(["superseded", "added"]);
  });

  it("reports a term whose parent is gone instead of failing the merge", () => {
    const parent = overlay.add({ parent: "social-sciences.sociology", label: "Care Work" }, "admin");
    const child = overlay.add({ parent: parent.path, label: "Elder Care" }, "admin");
    const shrunk: VocabularyFile = { ...FIXTURE, version: "test-3", terms: FIXTURE.terms.filter((t) => !t.id.startsWith("social-sciences.sociology")) };
    const { vocabulary, orphans } = mergeOverlay(new Vocabulary(shrunk), overlay.list());
    expect(orphans.map((o) => o.path).sort()).toEqual([child.path, parent.path].sort());
    expect(vocabulary.has(parent.path)).toBe(false);
    expect(() => overlay.retire(parent.id, null, "admin")).toThrow(/below it/);
    overlay.retire(child.id, null, "admin");
    overlay.retire(parent.id, null, "admin");
  });

  it("moves a term and retires its old path in favour of the new one", () => {
    const term = overlay.add({ parent: "social-sciences.sociology", label: "Gig Work" }, "admin");
    overlay.move(term.id, "interdisciplinary-studies.science-technology-society.gig-work", "admin");
    const merged = mergeOverlay(new Vocabulary(FIXTURE), overlay.list()).vocabulary;
    expect(merged.retired("social-sciences.sociology.gig-work")).toEqual(["interdisciplinary-studies.science-technology-society.gig-work"]);
    expect(merged.find("social-sciences.sociology.gig-work")?.tag).toBe("interdisciplinary-studies.science-technology-society.gig-work");
    expect(overlay.get(term.id)?.former_paths).toEqual(["social-sciences.sociology.gig-work"]);
  });

  it("retires a term in favour of another, or for a person to decide", () => {
    const term = overlay.add({ parent: "social-sciences.sociology", label: "Platform Labour" }, "admin");
    overlay.retire(term.id, "social-sciences.sociology.social-change", "admin");
    const merged = mergeOverlay(new Vocabulary(FIXTURE), overlay.list()).vocabulary;
    expect(merged.retired("social-sciences.sociology.platform-labour")).toEqual(["social-sciences.sociology.social-change"]);
    // Care Work and Elder Care were retired with no replacement.
    expect(merged.retired("social-sciences.sociology.care-work")).toEqual([]);
  });
});

describe("the intake and the taxonomy over HTTP and MCP", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof serveHttp>>;
  let base: string;
  let vocabularyPath: string;
  let userToken: string;
  let pushToken: string;
  let wrongServiceToken: string;
  let pushTokenForCorpus: string;

  beforeAll(async () => {
    root = tempDir();
    makeLibrary(root, "main", [{ id: 1, title: "Networks", authors: ["Ann Author"], files: { pdf: makePdf({ pages: [["Weak ties carry novel information"]] }) } }]);
    vocabularyPath = path.join(root, "vocabulary.json");
    fs.writeFileSync(vocabularyPath, JSON.stringify(FIXTURE));
    const team = "https://team.example.com";
    const config: Config = { booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"),
      dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"),
      shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
      citekeyPreset: "author-year-word", vocabularyPath,
      admin: { access: { teamDomain: team, audience: "corpus-aud", vocabularyPush: { clientId: "push-client.access", audience: "intake-aud" } },
        neighbors: [], source: "x", sshKey: "x", refreshUnit: "x", refreshLog: path.join(root, "refresh.log"), syncStatus: path.join(root, "sync-status.json") } };
    const db = openDatabase(config.dbPath);
    scanLibraries(config, db);
    db.close();

    // A stand-in Cloudflare Access. A service token's JWT has an empty subject and names the token in common_name.
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const jwt = (claims: Record<string, unknown>, audience: string, subject: string) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(team).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    userToken = await jwt({ email: "me@example.com" }, "corpus-aud", "user-1");
    pushToken = await jwt({ common_name: "push-client.access" }, "intake-aud", "");
    wrongServiceToken = await jwt({ common_name: "someone-else.access" }, "intake-aud", "");
    pushTokenForCorpus = await jwt({ common_name: "push-client.access" }, "corpus-aud", "");
    server = await serveHttp(config, { accessKeys: createLocalJWKSet({ keys: [jwk] }), jobCommands: { async refresh() {}, async calibre() {} }, zoteroTimer: false });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const push = (body: unknown, token?: string) => fetch(`${base}/api/intake/vocabulary`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { "cf-access-jwt-assertion": token } : {}) }, body: JSON.stringify(body),
  });
  const write = (url: string, body: unknown, token = userToken) => fetch(`${base}${url}`, {
    method: "POST", headers: { "content-type": "application/json", "cf-access-jwt-assertion": token }, body: JSON.stringify(body),
  });

  it("accepts only the intake's service token", async () => {
    const next = withTerm(FIXTURE, "social-sciences.sociology.care-work", "Care Work", "test-2");
    expect((await push(next)).status).toBe(401);
    expect((await push(next, userToken)).status).toBe(403);
    expect((await push(next, wrongServiceToken)).status).toBe(403);
    expect((await push(next, pushTokenForCorpus)).status).toBe(403);
    // ...and the service token unlocks no other write.
    expect((await write("/api/taxonomy/terms", { parent: "social-sciences", label: "X" }, pushTokenForCorpus)).status).toBe(403);
  });

  it("installs a pushed vocabulary, says when it is unchanged, and refuses an invalid one with its problems", async () => {
    const next = withTerm(FIXTURE, "social-sciences.sociology.care-work", "Care Work", "test-2");
    const first = await push(next, pushToken);
    expect([first.status, await first.json()]).toEqual([200, { version: "test-2", terms: 10, overlay: { terms: 0, orphans: 0 } }]);
    expect(JSON.parse(fs.readFileSync(vocabularyPath, "utf8")).version).toBe("test-2");
    const again = await push(next, pushToken);
    expect(await again.json()).toMatchObject({ version: "test-2", unchanged: true });
    const bad = await push({ ...next, version: "test-3", terms: [...next.terms, { id: "Bad Id", label: "Bad" }] }, pushToken);
    expect(bad.status).toBe(422);
    expect((await bad.json()).problems).toEqual(expect.arrayContaining([expect.stringContaining('"Bad Id"')]));
    expect(JSON.parse(fs.readFileSync(vocabularyPath, "utf8")).version).toBe("test-2");
    const overview = await (await fetch(`${base}/api/taxonomy`)).json();
    expect(overview.base).toMatchObject({ version: "test-2", installed: { by: "service:push-client.access", detail: { version: "test-2", terms: 10 } } });
  });

  it("lets agents coin provisional terms that tagging accepts at once, shown with status and scope note", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const added = await client.callTool({ name: "add_provisional_term", arguments: {
      parent: "Social Sciences › Psychology", label: "Moral Injury", scope_note: "Harm from violating one's own moral code.",
    } });
    expect(JSON.parse((added.content as { text: string }[])[0].text).term).toMatchObject({ path: "social-sciences.psychology.moral-injury", status: "provisional" });
    const taken = await client.callTool({ name: "add_provisional_term", arguments: { parent: "social-sciences.sociology", label: "Care Work", scope_note: "x" } });
    expect(taken.isError).toBe(true);
    const vocabulary = JSON.parse(((await client.callTool({ name: "get_tag_vocabulary", arguments: { under: "social-sciences.psychology" } })).content as { text: string }[])[0].text);
    expect(vocabulary.tags).toContainEqual({
      tag: "social-sciences.psychology.moral-injury", label: "Social Sciences › Psychology › Moral Injury", status: "provisional",
      scopeNote: "Harm from violating one's own moral code.",
    });
    const proposed = await client.callTool({ name: "propose_tags", arguments: { book_id: "main:1", tags: ["Moral Injury"], rationale: "About moral injury." } });
    expect(proposed.isError).toBeFalsy();
    const report = JSON.parse(((await client.callTool({ name: "vocabulary_report", arguments: {} })).content as { text: string }[])[0].text);
    expect(report.overlay.provisional).toEqual(["social-sciences.psychology.moral-injury"]);
    await client.close();
  });

  it("lets a signed-in person confirm, edit, and move terms; LAN requests cannot", async () => {
    const { terms } = await (await fetch(`${base}/api/taxonomy`)).json();
    const id = terms.find((t: { path: string }) => t.path === "social-sciences.psychology.moral-injury").id;
    const lan = await fetch(`${base}/api/taxonomy/terms/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "confirm" }) });
    expect(lan.status).toBe(401);
    expect((await (await write(`/api/taxonomy/terms/${id}`, { action: "confirm" })).json()).term.status).toBe("confirmed");
    expect((await (await write(`/api/taxonomy/terms/${id}`, { action: "edit", alt_labels: ["Moral Distress"] })).json()).term.alt_labels).toEqual(["Moral Distress"]);
    const moved = await (await write(`/api/taxonomy/terms/${id}`, { action: "move", parent: "social-sciences.sociology" })).json();
    expect(moved.term).toMatchObject({ path: "social-sciences.sociology.moral-injury", former_paths: ["social-sciences.psychology.moral-injury"] });
    const below = await write(`/api/taxonomy/terms/${id}`, { action: "move", parent: "social-sciences.sociology.moral-injury" });
    expect(below.status).toBe(400);
    const vocabulary = await (await fetch(`${base}/api/vocabulary`)).json();
    expect(vocabulary.tags.map((t: { tag: string }) => t.tag)).toContain("social-sciences.sociology.moral-injury");
    expect((await (await fetch(`${base}/admin/taxonomy`)).text())).toContain("<title>Taxonomy</title>");
  });

  it("supersedes an overlay term when a push brings the same path", async () => {
    const next = withTerm(withTerm(FIXTURE, "social-sciences.sociology.care-work", "Care Work", "x"), "social-sciences.sociology.moral-injury", "Moral Injury", "test-4");
    expect((await push(next, pushToken)).status).toBe(200);
    const overview = await (await fetch(`${base}/api/taxonomy`)).json();
    expect(overview.terms.find((t: { path: string }) => t.path === "social-sciences.sociology.moral-injury").status).toBe("superseded");
    expect(overview.merged.version).toMatch(/^test-4\+overlay\./); // the moved term's old path is still retired by the overlay
    expect(overview.events[0].kind).toBe("superseded");
  });
});
