import { recordChanges } from "./data.js";
import { isbn13, validIsbn } from "./isbn.js";
import { type BookRow, type Corpus, ToolError, getBook, pinCitekey } from "./tools.js";

/**
 * A read-only view of a Zotero library through the Zotero Web API, for finding which Calibre books are
 * already filed there and pinning the citekeys they were given. zotero.org is slow to answer at times, so
 * nothing waits on it: a background sync mirrors the fields matching needs into data.db (only what
 * changed since the last sync, by Zotero's library version), and every page and tool reads the mirror.
 */

export interface ZoteroConfig {
  /** "users/<user id>" or "groups/<group id>". */
  library: string;
  apiKey: string;
  apiBase: string;
  intervalMinutes: number;
  /** Per request; the API can take tens of seconds. */
  timeoutMs?: number;
}

interface ApiItem {
  key: string;
  version: number;
  data: {
    itemType: string; title?: string; date?: string; ISBN?: string; extra?: string; citationKey?: string; deleted?: number | boolean;
    creators?: { creatorType: string; lastName?: string; firstName?: string; name?: string }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GETs from the Zotero Web API with a long timeout, retries for network errors and 5xx, and its Backoff and Retry-After headers honoured. */
export class ZoteroClient {
  private notBefore = 0;

  constructor(private readonly config: ZoteroConfig, private readonly log: (text: string) => void = () => {}) {}

  async get(path: string, params: Record<string, string | number> = {}): Promise<{ body: unknown; headers: Headers }> {
    const url = new URL(`${this.config.apiBase.replace(/\/$/, "")}/${this.config.library}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      const wait = this.notBefore - Date.now();
      if (wait > 0) await sleep(wait);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "Zotero-API-Version": "3", "Zotero-API-Key": this.config.apiKey },
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 90_000),
        });
      } catch (error) {
        if (attempt >= 4) throw new Error(`Zotero did not answer ${url.pathname}: ${(error as Error).message}`);
        this.log(`Zotero did not answer (${(error as Error).message}); retrying.\n`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      // Backoff: the server is busy, so pause later requests too. Retry-After: this one must wait.
      const backoff = Number(res.headers.get("backoff"));
      if (backoff > 0) this.notBefore = Date.now() + backoff * 1000;
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        if (attempt >= 4) throw new Error(`Zotero answered ${res.status} for ${url.pathname}`);
        const retryAfter = res.headers.has("retry-after") ? Number(res.headers.get("retry-after")) || 0 : 2 * 2 ** attempt;
        this.log(`Zotero answered ${res.status}; retrying in ${retryAfter} s.\n`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 403) throw new Error("Zotero refused the API key (403). Check CORPUS_ZOTERO_API_KEY and its library access.");
      if (!res.ok) throw new Error(`Zotero answered ${res.status} for ${url.pathname}: ${(await res.text()).slice(0, 200)}`);
      return { body: await res.json(), headers: res.headers };
    }
  }
}

/** A title compared loosely: case, accents, punctuation, and a subtitle after ":" ignored. */
export function normalizedTitle(title: string | null | undefined): string {
  return String(title ?? "").split(/[:.?!]\s/)[0].toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
}

function familyName(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
}

/** The citekey Better BibTeX assigned: Zotero's field, else the "Citation Key:" line it writes to Extra. */
export function assignedCitekey(data: { citationKey?: string; extra?: string }): string | null {
  return (data.citationKey || data.extra?.match(/^Citation Key:\s*(\S+)/im)?.[1] || "").trim() || null;
}

function isbnsOf(field: string | undefined): string[] {
  const out = new Set<string>();
  for (const raw of String(field ?? "").split(/[\s,;]+/)) {
    const valid = validIsbn(raw);
    if (valid) out.add(isbn13(valid));
  }
  return [...out];
}

function meta(c: Corpus, key: string): string | null {
  return (c.data.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined) ?? null;
}

function setMeta(c: Corpus, key: string, value: string | null): void {
  if (value === null) c.data.prepare("DELETE FROM meta WHERE key = ?").run(key);
  else c.data.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

function storeItems(c: Corpus, items: ApiItem[]): void {
  const now = new Date().toISOString();
  const upsert = c.data.prepare(`
    INSERT OR REPLACE INTO zotero_items (key, version, item_type, title, title_norm, first_creator, year, citekey, calibre_uuid, trashed, synced_at)
    VALUES (@key, @version, @item_type, @title, @title_norm, @first_creator, @year, @citekey, @calibre_uuid, @trashed, @synced_at)`);
  const clearIsbns = c.data.prepare("DELETE FROM zotero_isbns WHERE key = ?");
  const addIsbn = c.data.prepare("INSERT OR IGNORE INTO zotero_isbns (isbn, key) VALUES (?, ?)");
  c.data.transaction(() => {
    for (const item of items) {
      const d = item.data;
      // Notes and attachments are never books.
      if (d.itemType === "note" || d.itemType === "attachment" || d.itemType === "annotation") continue;
      const creators = (d.creators ?? []).filter((x) => x.creatorType === "author" || x.creatorType === "editor");
      const first = creators.find((x) => x.creatorType === "author") ?? creators[0] ?? d.creators?.[0];
      upsert.run({
        key: item.key, version: item.version, item_type: d.itemType, title: d.title ?? null, title_norm: normalizedTitle(d.title),
        first_creator: familyName(first?.lastName ?? first?.name) || null,
        year: Number(String(d.date ?? "").match(/\b(\d{4})\b/)?.[1]) || null,
        citekey: assignedCitekey(d), calibre_uuid: d.extra?.match(/^Calibre UUID:\s*(\S+)/im)?.[1] ?? null,
        trashed: d.deleted ? 1 : 0, synced_at: now,
      });
      clearIsbns.run(item.key);
      for (const isbn of isbnsOf(d.ISBN)) addIsbn.run(isbn, item.key);
    }
  })();
}

export interface SyncResult { full: boolean; fetched: number; removed: number; version: number; pinned: string[] }

/**
 * Brings the mirror up to date: top-level items changed since the last library version (all of them the
 * first time), then the keys deleted since. Pages are stored as they arrive and the version is saved
 * last, so an interrupted sync repeats its work next time rather than skipping any.
 */
export async function syncZotero(c: Corpus, config: ZoteroConfig, log: (text: string) => void = () => {}): Promise<SyncResult> {
  const client = new ZoteroClient(config, log);
  const since = Number(meta(c, "zotero_version") ?? 0);
  const full = since === 0;
  setMeta(c, "zotero_sync_started_at", new Date().toISOString());
  try {
    let fetched = 0;
    let version = since;
    // Zotero may return fewer than asked for, so the next page starts after what actually came back.
    for (let start = 0; ; ) {
      const { body, headers } = await client.get("items/top", { format: "json", includeTrashed: 1, since, limit: 100, start });
      const items = body as ApiItem[];
      if (start === 0) version = Number(headers.get("last-modified-version")) || version;
      storeItems(c, items);
      fetched += items.length;
      start += items.length;
      const total = Number(headers.get("total-results") ?? start);
      if (full && items.length) log(`${Math.min(start, total)} of ${total} items\n`);
      if (!items.length || start >= total) break;
    }
    let removed = 0;
    if (!full) {
      const { body } = await client.get("deleted", { since });
      const keys = (body as { items?: string[] }).items ?? [];
      const drop = c.data.prepare("DELETE FROM zotero_items WHERE key = ?");
      const dropIsbns = c.data.prepare("DELETE FROM zotero_isbns WHERE key = ?");
      c.data.transaction(() => {
        for (const key of keys) {
          dropIsbns.run(key);
          removed += drop.run(key).changes;
        }
      })();
    }
    setMeta(c, "zotero_version", String(version));
    setMeta(c, "zotero_synced_at", new Date().toISOString());
    setMeta(c, "zotero_error", null);
    const pinned = pinFromZotero(c);
    log(`${full ? "Full" : "Incremental"} sync: ${fetched} item(s) fetched, ${removed} removed, library version ${version}.${pinned.length ? ` Pinned ${pinned.join(", ")}.` : ""}\n`);
    return { full, fetched, removed, version, pinned };
  } catch (error) {
    setMeta(c, "zotero_error", `${new Date().toISOString()} ${(error as Error).message}`);
    throw error;
  }
}

interface MirrorItem {
  key: string; version: number; item_type: string; title: string | null; first_creator: string | null; year: number | null;
  citekey: string | null; calibre_uuid: string | null; trashed: number;
}

export type MatchKind = "calibre_uuid" | "isbn" | "confirmed";

export interface ZoteroMatch {
  match: { key: string; citekey: string | null; matched_by: MatchKind; title: string | null } | null;
  /** Title, first author, and year agree, but nothing ties the two together; a person confirms or rejects. */
  candidates: { key: string; citekey: string | null; title: string | null; year: number | null }[];
  /** With a match: other items with the same title and first author, perhaps a second copy in Zotero. */
  duplicates: { key: string; citekey: string | null; title: string | null; year: number | null }[];
}

/** Where a Calibre book is in the Zotero mirror: by the Calibre UUID filing wrote to Extra, its ISBN, or a confirmed link. */
export function zoteroMatch(c: Corpus, book: BookRow): ZoteroMatch {
  const live = "trashed = 0";
  const links = c.data.prepare("SELECT zotero_key, status FROM zotero_links WHERE calibre_uuid = ?").all(book.uuid ?? "") as { zotero_key: string; status: string }[];
  const rejected = new Set(links.filter((l) => l.status === "rejected").map((l) => l.zotero_key));
  // An item filed for another Calibre book (its Extra names that book's UUID) is never this one.
  const item = (sql: string, ...args: unknown[]) =>
    (c.data.prepare(`SELECT * FROM zotero_items WHERE ${live} AND ${sql}`).all(...args) as MirrorItem[])
      .filter((i) => !rejected.has(i.key) && (!i.calibre_uuid || i.calibre_uuid === book.uuid));
  const sorts = JSON.parse(book.author_sorts) as string[];
  const family = familyName((sorts[0] ?? "").split(",")[0]);
  // Same title (without a subtitle), first author, and year within one: a candidate, or beside a match, a duplicate.
  const lookalikes = (except?: string) => item("title_norm = ?", normalizedTitle(book.title))
    .filter((i) => i.key !== except && (!family || i.first_creator === family) && (!book.year || !i.year || Math.abs(i.year - book.year) <= 1))
    .map((i) => ({ key: i.key, citekey: i.citekey, title: i.title, year: i.year }));
  const found = (i: MirrorItem, matched_by: MatchKind): ZoteroMatch =>
    ({ match: { key: i.key, citekey: i.citekey, matched_by, title: i.title }, candidates: [], duplicates: lookalikes(i.key) });

  const confirmed = links.find((l) => l.status === "confirmed");
  if (confirmed) {
    const [i] = item("key = ?", confirmed.zotero_key);
    if (i) return found(i, "confirmed");
  }
  if (book.uuid) {
    const [i] = item("calibre_uuid = ?", book.uuid);
    if (i) return found(i, "calibre_uuid");
  }
  const isbn = book.isbn ? validIsbn(book.isbn) : null;
  if (isbn) {
    const byIsbn = item("key IN (SELECT key FROM zotero_isbns WHERE isbn = ?)", isbn13(isbn));
    // Only an ISBN that names one item; two copies of the same book are for a person to sort out.
    if (byIsbn.length === 1) return found(byIsbn[0], "isbn");
  }
  return { match: null, candidates: lookalikes(), duplicates: [] };
}

/**
 * Pins the citekey a matched Zotero item carries, for books that have neither a pin nor a citekey in
 * Calibre. A key already pinned to another book is left for a person (see zoteroReport).
 */
export function pinFromZotero(c: Corpus): string[] {
  const pinned: string[] = [];
  const books = c.db.prepare("SELECT * FROM books WHERE uuid IS NOT NULL AND calibre_citekey IS NULL ORDER BY id").all() as BookRow[];
  const hasPin = c.data.prepare("SELECT 1 FROM citekeys WHERE calibre_uuid = ?").pluck();
  const keyTaken = c.data.prepare("SELECT 1 FROM citekeys WHERE citekey = ? COLLATE NOCASE").pluck();
  for (const book of books) {
    if (hasPin.get(book.uuid)) continue;
    const { match } = zoteroMatch(c, book);
    if (!match?.citekey || keyTaken.get(match.citekey)) continue;
    pinCitekey(c, { book_id: book.id, citekey: match.citekey }, `zotero:${match.key}`, "zotero");
    pinned.push(match.citekey);
  }
  return pinned;
}

/** A person confirms that a candidate Zotero item is this book (and its citekey is pinned), or rejects it. */
export function linkZotero(c: Corpus, args: { book_id: string; key: string; action: "confirm" | "reject" | "clear" }, by: string) {
  const book = getBook(c, args.book_id);
  if (!book.uuid) throw new ToolError(`${book.id} has no Calibre UUID.`);
  const item = c.data.prepare("SELECT * FROM zotero_items WHERE key = ?").get(args.key) as MirrorItem | undefined;
  if (!item) throw new ToolError(`No Zotero item ${args.key} in the mirror.`);
  if (args.action === "clear") {
    c.data.prepare("DELETE FROM zotero_links WHERE calibre_uuid = ? AND zotero_key = ?").run(book.uuid, args.key);
  } else {
    if (args.action === "confirm") c.data.prepare("DELETE FROM zotero_links WHERE calibre_uuid = ? AND status = 'confirmed'").run(book.uuid);
    c.data.prepare(`INSERT OR REPLACE INTO zotero_links (calibre_uuid, zotero_key, status, linked_by, linked_at) VALUES (?, ?, ?, ?, ?)`)
      .run(book.uuid, args.key, args.action === "confirm" ? "confirmed" : "rejected", by, new Date().toISOString());
  }
  recordChanges(c.data, [{
    kind: "zotero_linked", source: "admin", book_id: book.id, calibre_uuid: book.uuid, title: book.title,
    detail: `${args.action} ${args.key}${item.citekey ? ` (${item.citekey})` : ""}`, actor: by,
  }]);
  const pinned = args.action === "confirm" ? pinFromZotero(c) : [];
  return { book_id: book.id, key: args.key, action: args.action, pinned, ...zoteroMatch(c, book) };
}

/** The sync's state and how Calibre's books stand against the mirror. Everything here reads data.db only. */
export function zoteroReport(c: Corpus, config: ZoteroConfig | undefined) {
  const books = c.db.prepare("SELECT * FROM books WHERE status != 'no_file' ORDER BY title").all() as BookRow[];
  const pins = new Map((c.data.prepare("SELECT calibre_uuid, citekey FROM citekeys").all() as { calibre_uuid: string; citekey: string }[]).map((p) => [p.calibre_uuid, p.citekey]));
  const counts = { calibre_uuid: 0, isbn: 0, confirmed: 0, candidates: 0, not_found: 0 };
  const candidates = [];
  const mismatches = [];
  const noCitekey = [];
  const duplicates = [];
  for (const book of books) {
    const m = zoteroMatch(c, book);
    if (m.match) {
      counts[m.match.matched_by]++;
      const pinned = book.uuid ? pins.get(book.uuid) : undefined;
      const ref = { book_id: book.id, title: book.title, zotero_key: m.match.key, matched_by: m.match.matched_by };
      if (m.duplicates.length) duplicates.push({ ...ref, citekey: m.match.citekey, duplicates: m.duplicates });
      if (!m.match.citekey) noCitekey.push(ref);
      else if (pinned && pinned.toLowerCase() !== m.match.citekey.toLowerCase()) mismatches.push({ ...ref, pinned, zotero_citekey: m.match.citekey });
      else if (book.calibre_citekey && book.calibre_citekey !== m.match.citekey.toLowerCase()) mismatches.push({ ...ref, calibre: book.calibre_citekey, zotero_citekey: m.match.citekey });
    } else if (m.candidates.length) {
      counts.candidates++;
      candidates.push({ book_id: book.id, title: book.title, year: book.year, candidates: m.candidates });
    } else counts.not_found++;
  }
  const items = c.data.prepare("SELECT COUNT(*) AS items, SUM(trashed) AS trashed FROM zotero_items").get() as { items: number; trashed: number | null };
  return {
    configured: Boolean(config),
    library: config?.library ?? null,
    sync: {
      version: Number(meta(c, "zotero_version") ?? 0) || null, synced_at: meta(c, "zotero_synced_at"), started_at: meta(c, "zotero_sync_started_at"),
      error: meta(c, "zotero_error"), every_minutes: config?.intervalMinutes ?? null, items: items.items, trashed: items.trashed ?? 0,
    },
    books: { total: books.length, ...counts },
    candidates, mismatches, duplicates, no_citekey: noCitekey,
  };
}

/** One sync at a time, shared by the timer and the dashboard's job; a request during a sync joins it. */
export class ZoteroSync {
  private current: Promise<SyncResult> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly c: Corpus, readonly config: ZoteroConfig) {}

  run(log: (text: string) => void = () => {}): Promise<SyncResult> {
    if (!this.current) {
      this.current = syncZotero(this.c, this.config, log).finally(() => {
        this.current = null;
      });
    } else log("A sync is already running; waiting for it.\n");
    return this.current;
  }

  /** Syncs now and every intervalMinutes; failures are kept in the report, not thrown. */
  start(): void {
    const tick = () => this.run().catch((error) => console.error(`zotero sync: ${(error as Error).message}`));
    void tick();
    this.timer = setInterval(tick, this.config.intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * What cite_passage and cite_quote add about Zotero, from the mirror: the matching item, or candidates to
 * confirm. Undefined until a first sync, so an unconfigured server says nothing.
 */
export function zoteroCiteInfo(c: Corpus, book: BookRow) {
  if (!meta(c, "zotero_synced_at")) return undefined;
  const { match, candidates } = zoteroMatch(c, book);
  return {
    zotero: match ? { key: match.key, citekey: match.citekey, matched_by: match.matched_by } : null,
    note: match
      ? `Already in Zotero as item ${match.key}${match.citekey ? ` (${match.citekey})` : ""}; don't file it again.`
      : candidates.length
        ? `Zotero has ${candidates.length} item(s) with this title and author (${candidates.map((x) => x.key).join(", ")}) that may be this book; check before filing.`
        : null,
    synced_at: meta(c, "zotero_synced_at"),
  };
}

/** True once the mirror has synced at least once. */
export function zoteroSynced(c: Corpus): boolean {
  return Boolean(meta(c, "zotero_synced_at"));
}

/** A link that opens the item in the Zotero desktop app. */
export function zoteroItemLink(library: string | undefined, key: string): string {
  const group = library?.match(/^groups\/(\d+)$/)?.[1];
  return group ? `zotero://select/groups/${group}/items/${key}` : `zotero://select/library/items/${key}`;
}
