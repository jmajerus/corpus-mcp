import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { scanLibraries } from "../src/indexer.js";
import { serveHttp } from "../src/server.js";
import { openDataStore } from "../src/data.js";
import { type TerminologyTerm, TerminologyFollower, buildVocabulary } from "../src/taxonomy/terminology.js";
import { type VocabularyFile, VocabularySource } from "../src/vocabulary.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "vocabulary.json"), "utf8")) as VocabularyFile;

/** cc-subjects as terminology-mcp would serve the fixture's subjects: `path` is built from labels, so it is never the tag. */
function subjects(): TerminologyTerm[] {
  const term = (id: string, slug: string, label: string, broader: string | null, extra: Partial<TerminologyTerm> = {}) =>
    ({ id, scheme: "cc-subjects", slug, label, status: "active", broader: broader ? [broader] : [], scopeNote: "", formerSlugs: [], replacedBy: [], path: label.toLowerCase(), ...extra });
  return [
    term("t_ss", "social-sciences", "Social Sciences", null),
    term("t_soc", "sociology", "Sociology", "t_ss"),
    term("t_chg", "social-change", "Social Change", "t_soc"),
    term("t_psy", "psychology", "Psychology", "t_ss"),
    term("t_sp", "social-psychology", "Social Psychology", "t_psy"),
    term("t_is", "interdisciplinary-studies", "Interdisciplinary Studies", null),
    term("t_sts", "science-technology-society", "Science, Technology & Society", "t_is"),
    term("t_twc", "technology-work-control", "Technology, Work & Control", "t_sts"),
  ];
}

describe("building the vocabulary from cc-subjects", () => {
  it("matches the pushed vocabulary on the first build, except the puzzle kinds cc-subjects leaves out", () => {
    const built = buildVocabulary(subjects(), new Map());
    const pushed = FIXTURE.terms.filter((t) => t.id !== "trivia")
      .map((t) => ({ id: t.id, label: t.label, parent: t.parent ?? null, ...(t.assignable === false ? { assignable: false } : {}) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(built.terms).toEqual(pushed);
    expect(built.retired).toEqual([]);
    expect(built.version).toMatch(/^terminology:[0-9a-f]{16}$/);
    expect(buildVocabulary(subjects(), new Map()).version).toBe(built.version);
  });

  it("marks provisional terms and keeps scope notes; a retired tag's replacement resolves to a live tag", () => {
    const terms = [...subjects(), { ...subjects()[2], id: "t_old", slug: "old-change", status: "retired", replacedBy: ["t_chg"] },
      { ...subjects()[2], id: "t_mi", slug: "moral-injury", label: "Moral Injury", broader: ["t_psy"], status: "provisional", scopeNote: "Harm from violating one's code." }];
    const built = buildVocabulary(terms, new Map([["social-sciences.sociology.gone", ["t_old"]], ["social-sciences.sociology.social-change", ["t_chg"]]]));
    expect(built.terms).toContainEqual({ id: "social-sciences.psychology.moral-injury", label: "Moral Injury", parent: "social-sciences.psychology", scopeNote: "Harm from violating one's code.", status: "provisional" });
    expect(built.terms.map((t) => t.id)).not.toContain("social-sciences.sociology.old-change");
    // A tag that is live again isn't retired.
    expect(built.retired).toEqual([{ id: "social-sciences.sociology.gone", replacedBy: ["social-sciences.sociology.social-change"] }]);
  });

  it("keeps labels free of the file's path separators", () => {
    const terms = subjects().map((t) => (t.id === "t_soc" ? { ...t, label: "U.S. Society › Groups" } : t));
    expect(buildVocabulary(terms, new Map()).terms.find((t) => t.id === "social-sciences.sociology")?.label).toBe("US Society - Groups");
  });
});

/** A stand-in terminology-mcp: its state, changelog, progress reports, and proposals. */
function stubTerminology() {
  const store = { log: "log-1", version: 10, terms: subjects(), changes: [] as Record<string, unknown>[], reports: [] as Record<string, unknown>[], proposals: [] as Record<string, unknown>[] };
  const change = (kind: string, afterTerms: TerminologyTerm[]) => {
    store.version++;
    for (const t of afterTerms) if (t.scheme === "cc-subjects") store.terms = [...store.terms.filter((x) => x.id !== t.id), t];
    store.changes.push({ n: store.version, kind, afterTerms, ...(kind === "added" ? { after: afterTerms[0] } : {}) });
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === "/api/state") return send(200, { log: store.log, version: store.version, head: store.version, terms: store.terms });
    if (url.pathname === "/api/changes") {
      const since = Number(url.searchParams.get("since"));
      return send(200, { log: store.log, version: store.version, changes: store.changes.filter((c) => (c.n as number) > since) });
    }
    if (url.pathname === "/api/subscribers/corpus-mcp/progress") { store.reports.push(body); return send(200, { through: body.through }); }
    if (url.pathname === "/api/proposals") {
      store.proposals.push(body);
      if (!body.source) return send(422, { error: "Pass source: search a reference vocabulary first (search_terms).", hint: "search_terms" });
      const term = { ...subjects()[0], id: `t_p${store.proposals.length}`, slug: body.slug ?? body.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: body.label,
        broader: [body.broader], status: "provisional", scopeNote: body.scopeNote };
      change("added", [term]);
      return send(201, { id: term.id, slug: term.slug, status: "provisional", change: store.version, term });
    }
    send(404, { error: "API route not found." });
  });
  return { store, change, server };
}

async function setup(root: string, terminologyUrl?: string) {
  makeLibrary(root, "main", [{ id: 1, title: "Networks", authors: ["Ann Author"], tags: ["social-sciences.sociology.social-change"],
    files: { pdf: makePdf({ pages: [["Weak ties carry novel information"]] }) } }]);
  const vocabularyPath = path.join(root, "vocabulary.json");
  fs.writeFileSync(vocabularyPath, JSON.stringify(FIXTURE));
  const team = "https://team.example.com";
  const config: Config = { booksRoot: root, libraries: ["main"], excludeTags: [], dbPath: path.join(root, "corpus.db"),
    dataDbPath: path.join(root, "data.db"), backupDir: path.join(root, "backups"),
    shelvesFile: path.join(root, "shelves.json"), shelvesLibrary: "main", host: "127.0.0.1", port: 0,
    citekeyPreset: "author-year-word", vocabularyPath, ...(terminologyUrl ? { terminology: { url: terminologyUrl, intervalSeconds: 30 } } : {}),
    admin: { access: { teamDomain: team, vocabularyPush: { clientId: "push-client.access" } },
      neighbors: [], source: "x", sshKey: "x", refreshUnit: "x", refreshLog: path.join(root, "refresh.log"), syncStatus: path.join(root, "sync-status.json") } };
  const db = openDatabase(config.dbPath);
  scanLibraries(config, db);
  db.close();
  // A stand-in Cloudflare Access. A service token's JWT has an empty subject and names the token in common_name.
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const jwt = (claims: Record<string, unknown>, audience: string, subject: string) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(team).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const tokens = {
    user: await jwt({ email: "me@example.com" }, "corpus-aud", "user-1"),
    push: await jwt({ common_name: "push-client.access" }, "intake-aud", ""),
    wrongService: await jwt({ common_name: "someone-else.access" }, "intake-aud", ""),
    forged: await new SignJWT({ common_name: "push-client.access" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(team).setAudience("intake-aud").setSubject("").setIssuedAt().setExpirationTime("5m").sign((await generateKeyPair("RS256")).privateKey),
  };
  const server = await serveHttp(config, { accessKeys: createLocalJWKSet({ keys: [jwk] }), jobCommands: { async refresh() {}, async calibre() {} }, zoteroTimer: false, terminologyTimer: false });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const push = (body: unknown, token?: string) => fetch(`${base}/api/intake/vocabulary`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { "cf-access-jwt-assertion": token } : {}) }, body: JSON.stringify(body),
  });
  return { server, base, vocabularyPath, tokens, push };
}

describe("following terminology-mcp", () => {
  let root: string;
  let stub: ReturnType<typeof stubTerminology>;
  let follower: TerminologyFollower;
  let source: VocabularySource;
  const tags = () => source.current().terms.map((t) => t.tag);
  const retired = () => Object.fromEntries((source.current().file.retired ?? []).map((r) => [r.id, r.replacedBy]));

  beforeAll(async () => {
    root = tempDir();
    stub = stubTerminology();
    await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", r));
    fs.writeFileSync(path.join(root, "vocabulary.json"), JSON.stringify(FIXTURE));
    source = new VocabularySource(path.join(root, "vocabulary.json"), () => {}, 0);
    follower = new TerminologyFollower(openDataStore(path.join(root, "data.db")), source,
      { url: `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`, intervalSeconds: 30 });
  });
  afterAll(() => {
    stub.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("replaces the pushed vocabulary with cc-subjects on its first sync, and reports how far it got", async () => {
    await follower.sync();
    expect(tags()).toEqual(FIXTURE.terms.map((t) => t.id).filter((t) => t !== "trivia").sort());
    expect(retired()).toEqual({});
    expect(stub.store.reports).toEqual([{ log: "log-1", through: 10, label: "corpus-mcp", schemes: ["cc-subjects"] }]);
    // Nothing new: no second report until the heartbeat is due.
    await follower.sync();
    expect(stub.store.reports).toHaveLength(1);
    expect(follower.status()).toMatchObject({ log: "log-1", through: 10, error: null, terms: 8 });
  });

  it("retires a renamed slug's whole subtree, though only the renamed term is in the change", async () => {
    const soc = stub.store.terms.find((t) => t.id === "t_soc")!;
    stub.change("slugged", [{ ...soc, slug: "society", formerSlugs: ["sociology"] }]);
    await follower.sync();
    expect(tags()).toContain("social-sciences.society.social-change");
    expect(retired()).toEqual({
      "social-sciences.sociology": ["social-sciences.society"], "social-sciences.sociology.social-change": ["social-sciences.society.social-change"],
    });
    expect(stub.store.reports.at(-1)).toMatchObject({ through: 11 });
  });

  it("ignores a relabel that lists descendants whose tags didn't change, and terms from other schemes", async () => {
    const before = retired();
    const psy = stub.store.terms.find((t) => t.id === "t_psy")!;
    const sp = stub.store.terms.find((t) => t.id === "t_sp")!;
    const other = { ...sp, id: "t_hw", scheme: "human-work", slug: "flexibility", label: "Flexibility", broader: [] };
    stub.change("labelled", [{ ...psy, label: "Psychology & Mind", path: "x" }, { ...sp, path: "y" }, other]);
    // A concept set comes through the changes too, with no term fields.
    stub.store.changes.push({ n: ++stub.store.version, kind: "set-added", after: { id: "s_1", scheme: "cc-subjects", name: "Reading list" } });
    await follower.sync();
    expect(follower.status()).toMatchObject({ error: null, through: stub.store.version, terms: 8 });
    expect(retired()).toEqual(before);
    expect(source.current().labelFor("social-sciences.psychology")).toBe("Social Sciences › Psychology & Mind");
    expect(tags()).not.toContain("flexibility");
  });

  it("re-tags a merged term to its target, and leaves a split for a person", async () => {
    const sp = stub.store.terms.find((t) => t.id === "t_sp")!;
    stub.change("merged", [{ ...sp, status: "retired", replacedBy: ["t_psy"] }]);
    const twc = stub.store.terms.find((t) => t.id === "t_twc")!;
    const a = { ...twc, id: "t_tw", slug: "technology-work", label: "Technology & Work" };
    const b = { ...twc, id: "t_tc", slug: "technology-control", label: "Technology & Control" };
    stub.change("added", [a]);
    stub.change("added", [b]);
    stub.change("split", [{ ...twc, status: "retired", replacedBy: ["t_tw", "t_tc"] }]);
    await follower.sync();
    expect(retired()).toMatchObject({
      "social-sciences.psychology.social-psychology": ["social-sciences.psychology"],
      "interdisciplinary-studies.science-technology-society.technology-work-control": [
        "interdisciplinary-studies.science-technology-society.technology-control", "interdisciplinary-studies.science-technology-society.technology-work",
      ],
    });
    // The cursor moved on all the same.
    expect(follower.status().through).toBe(stub.store.version);
  });

  it("starts over from the state when terminology-mcp's store was rebuilt, and says so", async () => {
    stub.store.log = "log-2";
    await follower.sync();
    expect(stub.store.reports.at(-1)).toMatchObject({ log: "log-2", through: stub.store.version, reset: true });
    expect(tags()).toContain("social-sciences.society.social-change");
  });
});

it("retires the old tags terminology-mcp records on a first bootstrap: former slugs, and retired terms'", async () => {
  const root = tempDir();
  const stub = stubTerminology();
  stub.store.terms = stub.store.terms.map((t) => (t.id === "t_soc" ? { ...t, formerSlugs: ["society"] } : t));
  stub.store.terms.push({ ...subjects()[4], id: "t_old", slug: "group-psychology", formerSlugs: ["crowds"], status: "retired", replacedBy: ["t_sp"] });
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", r));
  try {
    fs.writeFileSync(path.join(root, "vocabulary.json"), JSON.stringify(FIXTURE));
    const source = new VocabularySource(path.join(root, "vocabulary.json"), () => {}, 0);
    await new TerminologyFollower(openDataStore(path.join(root, "data.db")), source,
      { url: `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`, intervalSeconds: 30 }).sync();
    expect(Object.fromEntries((source.current().file.retired ?? []).map((r) => [r.id, r.replacedBy]))).toEqual({
      "social-sciences.society": ["social-sciences.sociology"], "social-sciences.society.social-change": ["social-sciences.sociology.social-change"],
      "social-sciences.psychology.group-psychology": ["social-sciences.psychology.social-psychology"],
      "social-sciences.psychology.crowds": ["social-sciences.psychology.social-psychology"],
    });
  } finally {
    stub.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("proposing terms and the intake while following", () => {
  let root: string;
  let stub: ReturnType<typeof stubTerminology>;
  let s: Awaited<ReturnType<typeof setup>>;
  let client: Client;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: (r.content as { text: string }[])[0].text };
  };

  beforeAll(async () => {
    root = tempDir();
    stub = stubTerminology();
    await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", r));
    s = await setup(root, `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`);
    client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`)));
  });
  afterAll(async () => {
    await client.close();
    s.server.close();
    stub.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("proposes a term copied from a source, usable for tagging at once", async () => {
    const added = await tool("add_provisional_term", {
      parent: "Social Sciences › Psychology", label: "Moral Injury", scope_note: "Harm from violating one's own moral code.",
      source: "BF789.M67", match: "broadMatch", request_id: "piece-1",
    });
    expect(added.isError).toBe(false);
    expect(JSON.parse(added.text)).toMatchObject({ tag: "social-sciences.psychology.moral-injury", status: "provisional", usable: true });
    expect(stub.store.proposals[0]).toMatchObject({
      scheme: "cc-subjects", broader: "t_psy", label: "Moral Injury", scopeNote: "Harm from violating one's own moral code.",
      source: "BF789.M67", match: "broadMatch", requestId: "piece-1", proposer: "corpus-mcp:agent",
    });
    const proposed = await tool("propose_tags", { book_id: "main:1", tags: ["Moral Injury"], rationale: "About moral injury." });
    expect(proposed.isError).toBe(false);
    const report = JSON.parse((await tool("vocabulary_report", {})).text);
    expect(report.provisional).toEqual(["social-sciences.psychology.moral-injury"]);
    const overview = await (await fetch(`${s.base}/api/taxonomy`)).json();
    expect(overview).toMatchObject({ source: "terminology-mcp", terminology: { log: "log-1", error: null }, provisional: [{ tag: "social-sciences.psychology.moral-injury", books: 0 }] });
  });

  it("catches up before refusing a parent added in terminology-mcp since the last sync", async () => {
    stub.change("added", [{ ...subjects()[1], id: "t_eco", slug: "economics", label: "Economics" }]);
    const added = await tool("add_provisional_term", { parent: "social-sciences.economics", label: "Care Economy", scope_note: "Paid and unpaid care.", source: "HD4904" });
    expect(added.isError).toBe(false);
    expect(JSON.parse(added.text)).toMatchObject({ tag: "social-sciences.economics.care-economy", usable: true });
    expect(stub.store.proposals.at(-1)).toMatchObject({ broader: "t_eco" });
  });

  it("passes on terminology-mcp's refusal and its hint", async () => {
    const refused = await tool("add_provisional_term", { parent: "social-sciences.sociology", label: "Care Work", scope_note: "Unpaid care." });
    expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/refused the proposal \(422\): Pass source.*"hint":"search_terms"/) });
  });

  it("refuses CC's push: one writer at a time", async () => {
    const pushed = await s.push(FIXTURE, s.tokens.push);
    expect([pushed.status, (await pushed.json()).error]).toEqual([409, expect.stringMatching(/follows terminology-mcp/)]);
    expect(JSON.parse(fs.readFileSync(s.vocabularyPath, "utf8")).version).toMatch(/^terminology:/);
  });
});

describe("the intake while corpus-mcp doesn't follow terminology-mcp", () => {
  let root: string;
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    root = tempDir();
    s = await setup(root);
  });
  afterAll(() => {
    s.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const withTerm = (file: VocabularyFile, id: string, label: string, version: string): VocabularyFile => ({
    ...file, version, terms: [...file.terms, { id, label, parent: id.slice(0, id.lastIndexOf(".")) }],
  });

  it("accepts only the intake's service token", async () => {
    const next = withTerm(FIXTURE, "social-sciences.sociology.care-work", "Care Work", "test-2");
    expect((await s.push(next)).status).toBe(401);
    expect((await s.push(next, s.tokens.user)).status).toBe(403);
    expect((await s.push(next, s.tokens.wrongService)).status).toBe(403);
    expect((await s.push(next, s.tokens.forged)).status).toBe(403);
  });

  it("installs a pushed vocabulary, says when it is unchanged, and refuses an invalid one with its problems", async () => {
    const next = withTerm(FIXTURE, "social-sciences.sociology.care-work", "Care Work", "test-2");
    const first = await s.push(next, s.tokens.push);
    expect([first.status, await first.json()]).toEqual([200, { version: "test-2", terms: 10 }]);
    expect(JSON.parse(fs.readFileSync(s.vocabularyPath, "utf8")).version).toBe("test-2");
    expect(await (await s.push(next, s.tokens.push)).json()).toMatchObject({ version: "test-2", unchanged: true });
    const bad = await s.push({ ...next, version: "test-3", terms: [...next.terms, { id: "Bad Id", label: "Bad" }] }, s.tokens.push);
    expect(bad.status).toBe(422);
    expect((await bad.json()).problems).toEqual(expect.arrayContaining([expect.stringContaining('"Bad Id"')]));
    expect(JSON.parse(fs.readFileSync(s.vocabularyPath, "utf8")).version).toBe("test-2");
    expect(await (await fetch(`${s.base}/api/taxonomy`)).json()).toMatchObject({ source: "push", terminology: null, vocabulary: { version: "test-2" } });
    expect((await (await fetch(`${s.base}/admin/taxonomy`)).text())).toContain("<title>Taxonomy</title>");
  });
});
