import os from "node:os";
import path from "node:path";
import { DEFAULT_PRESET, type PresetName, isPreset } from "./citekey.js";
import type { TerminologyConfig } from "./taxonomy/terminology.js";
import type { ZoteroConfig } from "./zotero.js";
import type { AccessConfig } from "./access.js";

/** Settings for the /admin dashboard; every field has a default, so tests and older configs can omit it. */
export interface AdminConfig {
  access: AccessConfig;
  /** Neighbouring LAN services shown in the dashboard's status strip. */
  neighbors: { name: string; url: string }[];
  /** ssh target and key for the Calibre-Web host's forced command (deploy/corpus-source.sh). */
  source: string;
  sshKey: string;
  refreshUnit: string;
  /** corpus-refresh.service appends its output here, so the dashboard can show it. */
  refreshLog: string;
  /** Written by corpus-sync.sh after each pull. */
  syncStatus: string;
  /** Calibre-Web's address, for links to a book's page there (books of `shelvesLibrary` only). */
  calibreWebUrl?: string;
  /** quote-mcp on the LAN, where the reader's quotes are kept (src/quoteMcp.ts); undefined is off. */
  quoteMcpUrl?: string;
}

const DEFAULT_NEIGHBORS = "zotero-mcp=http://zotero-mcp.localdomain:8000/mcp;calibre-web=http://calibre-web.localdomain:8083/;authoring=http://authoring.localdomain:8787/";

/** The public catalogue site (src/public/); off unless CORPUS_PUBLIC is set. */
export interface PublicConfig {
  level: "none" | "catalogue";
  /** The snapshot the public pages read, rebuilt by `corpus-mcp publish` and by the server on a timer. */
  file: string;
  /** A second listener that serves only the public pages, for a proxy without Cloudflare Access. */
  port?: number;
  title: string;
  /** The public base URL, given in site.json. */
  url: string;
  /** Other public sites' base URLs, whose key lists link their pages to these books. */
  links: string[];
  intervalMinutes: number;
}

export interface Config {
  /** Directory holding one folder per Calibre library. */
  booksRoot: string;
  /** Library folder names to index. Anything else under booksRoot is ignored. */
  libraries: string[];
  /** Books carrying any of these Calibre tags (case-insensitive) are never indexed. */
  excludeTags: string[];
  dbPath: string;
  /** Primary data (pinned citekeys, quotes): never rebuilt, backed up nightly. */
  dataDbPath: string;
  backupDir: string;
  /** Calibre-Web's shelf export (see deploy/corpus-source.sh), and the library its book ids belong to. */
  shelvesFile: string;
  shelvesLibrary: string;
  /** The @jmajerus/citekey preset for proposed citekeys. */
  citekeyPreset: PresetName;
  /** A Zotero library to mirror read-only (src/zotero.ts); off without an API key for zotero.org, or a library for holdings-mcp (CORPUS_ZOTERO_API). */
  zotero?: ZoteroConfig;
  /** The tag vocabulary (src/vocabulary.ts), reloaded when it changes; missing means none. */
  vocabularyPath: string;
  /** terminology-mcp, whose cc-subjects scheme the vocabulary follows (src/taxonomy/terminology.ts); off: the vocabulary file stays as installed by deploy --vocabulary. */
  terminology?: TerminologyConfig;
  admin?: AdminConfig;
  public?: PublicConfig;
  host: string;
  port: number;
}

/** The library Calibre-Web serves on calibre-web.localdomain (/mnt/Calibre/main). */
const DEFAULT_LIBRARIES = ["main"];

function citekeyPreset(name: string | undefined): PresetName {
  if (!name) return DEFAULT_PRESET;
  if (!isPreset(name)) throw new Error(`CORPUS_CITEKEY_PRESET "${name}" is not a citekey preset (author-year-word, bbt-default).`);
  return name;
}

function publicConfig(env: NodeJS.ProcessEnv): PublicConfig {
  const level = env.CORPUS_PUBLIC || "none";
  if (level !== "none" && level !== "catalogue") throw new Error(`CORPUS_PUBLIC "${level}" should be "none" or "catalogue".`);
  return {
    level,
    file: path.resolve(env.CORPUS_PUBLIC_DB ?? "/var/lib/corpus-mcp/public.db"),
    // Its own listener, on by default so a catalogue served from the LAN keeps a port of its own.
    port: /^(?:off|none|false|no)$/i.test(env.CORPUS_PUBLIC_PORT ?? "") ? undefined : Number.parseInt(env.CORPUS_PUBLIC_PORT || "8001", 10),
    title: env.CORPUS_PUBLIC_TITLE || "Library",
    url: (env.CORPUS_PUBLIC_URL ?? "").replace(/\/+$/, ""),
    links: (env.CORPUS_SITE_LINKS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    intervalMinutes: interval(env.CORPUS_PUBLISH_INTERVAL_MINUTES, 10),
  };
}

/** A timer's period: the default unless the setting is a number of at least `min` (a typo mustn't make a busy loop). */
function interval(value: string | undefined, fallback: number, min = 1): number {
  const n = Number(value);
  return value && Number.isFinite(n) && n >= min ? n : fallback;
}

function zoteroConfig(env: NodeJS.ProcessEnv): ZoteroConfig | undefined {
  const apiBase = env.CORPUS_ZOTERO_API || "https://api.zotero.org";
  // holdings-mcp's copy of Zotero (on the LAN) needs no key, and is cheap to ask often.
  const zoteroOrg = /^https?:\/\/api\.zotero\.org(?:\/|$)/i.test(apiBase);
  if (zoteroOrg ? !env.CORPUS_ZOTERO_API_KEY : !env.CORPUS_ZOTERO_LIBRARY) return undefined;
  const library = env.CORPUS_ZOTERO_LIBRARY ?? "";
  if (!/^(users|groups)\/\d+$/.test(library)) throw new Error(`CORPUS_ZOTERO_LIBRARY "${library}" should be "users/<user id>" or "groups/<group id>".`);
  const every = zoteroOrg ? 30 : 5;
  return {
    library, apiKey: zoteroOrg ? env.CORPUS_ZOTERO_API_KEY : undefined, apiBase,
    intervalMinutes: interval(env.CORPUS_ZOTERO_INTERVAL_MINUTES, every),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const libraries = env.CORPUS_LIBRARIES
    ? env.CORPUS_LIBRARIES.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_LIBRARIES;
  const excludeTags = (env.CORPUS_EXCLUDE_TAGS ?? "private").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    booksRoot: path.resolve(env.CORPUS_BOOKS_ROOT ?? "/srv/corpus/books"),
    libraries,
    excludeTags,
    dbPath: path.resolve(env.CORPUS_DB ?? "/var/lib/corpus-mcp/corpus.db"),
    dataDbPath: path.resolve(env.CORPUS_DATA_DB ?? "/var/lib/corpus-mcp/data.db"),
    backupDir: path.resolve(env.CORPUS_BACKUP_DIR ?? "/var/lib/corpus-mcp/backups"),
    shelvesFile: path.resolve(env.CORPUS_SHELVES_FILE ?? "/var/lib/corpus-mcp/shelves.json"),
    shelvesLibrary: env.CORPUS_SHELVES_LIBRARY ?? libraries[0],
    citekeyPreset: citekeyPreset(env.CORPUS_CITEKEY_PRESET),
    zotero: zoteroConfig(env),
    terminology: /^off$/i.test(env.CORPUS_TERMINOLOGY_URL ?? "") ? undefined : {
      url: (env.CORPUS_TERMINOLOGY_URL || "http://terminology-mcp.localdomain:8000").replace(/\/+$/, ""),
      intervalSeconds: interval(env.CORPUS_TERMINOLOGY_INTERVAL_SECONDS, 30, 5),
    },
    vocabularyPath: path.resolve(env.CORPUS_VOCABULARY ?? "/var/lib/corpus-mcp/vocabulary.json"),
    admin: {
      access: {
        teamDomain: env.ACCESS_TEAM_DOMAIN || env.CORPUS_ACCESS_TEAM_DOMAIN || undefined,
        // Edits made directly on the LAN, recorded under this name: on unless CORPUS_LAN_EDITS is off.
        lanActor: /^(?:off|false|no|0)$/i.test(env.CORPUS_LAN_EDITS ?? "") ? undefined : env.CORPUS_LAN_ACTOR || "LAN",
        // The names the server answers to on the LAN; by default its host name, with and without .localdomain.
        lanHosts: env.CORPUS_LAN_HOSTS ? env.CORPUS_LAN_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
          : [os.hostname(), `${os.hostname().split(".")[0]}.localdomain`],
      },
      neighbors: (env.CORPUS_NEIGHBORS ?? DEFAULT_NEIGHBORS).split(";").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
        const at = pair.indexOf("=");
        return { name: pair.slice(0, at).trim(), url: pair.slice(at + 1).trim() };
      }),
      source: env.CORPUS_SOURCE ?? "corpus-sync@calibre-web.localdomain",
      sshKey: env.CORPUS_SSH_KEY ?? "/var/lib/corpus-mcp/.ssh/id_ed25519",
      refreshUnit: env.CORPUS_REFRESH_UNIT ?? "corpus-refresh.service",
      refreshLog: env.CORPUS_REFRESH_LOG ?? "/var/lib/corpus-mcp/refresh.log",
      syncStatus: env.CORPUS_SYNC_STATUS ?? "/var/lib/corpus-mcp/sync-status.json",
      calibreWebUrl: env.CORPUS_CALIBRE_WEB_URL ?? "http://calibre-web.localdomain:8083",
      quoteMcpUrl: /^off$/i.test(env.CORPUS_QUOTE_MCP_URL ?? "") ? undefined : (env.CORPUS_QUOTE_MCP_URL || "http://quote-mcp.localdomain:8000").replace(/\/+$/, ""),
    },
    public: publicConfig(env),
    host: env.CORPUS_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.CORPUS_PORT ?? "8000", 10),
  };
}
