import fs from "node:fs";
import type { Statement } from "./replica.js";

/**
 * D1 over HTTP, for the drain on the LXC: either Cloudflare's REST API (/query on the database) or a
 * d1-proxy Worker (worker/proxy.ts), which speaks the same request and response shapes through its D1
 * binding, one hop instead of a round trip into the API. As concept-clusters' httpD1Database.
 *
 * A batch runs as one transaction. Every statement the drain sends is idempotent (an upsert or a delete
 * by key), so a request whose outcome is unknown (no response, a dropped connection) is simply sent
 * again on the next tick.
 */

export interface D1Config {
  /** The REST API: the account, the database, and an API token with D1 edit. */
  accountId?: string;
  databaseId?: string;
  /** Or the proxy's /query URL. */
  endpoint?: string;
  token: string;
  apiBase?: string;
  /** The R2 bucket for cover thumbnails, through the REST API (the proxy has its own binding). */
  bucket?: string;
}

export interface D1Http {
  batch(statements: Statement[]): Promise<unknown[]>;
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export class D1HttpError extends Error {}

interface WranglerConfig { d1_databases?: { database_id?: string }[]; r2_buckets?: { bucket_name?: string }[] }

function wranglerConfig(file: string): WranglerConfig {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")) as WranglerConfig;
  } catch {
    return {};
  }
}

/** The database_id in a wrangler config (JSON with // comments), unless it's the placeholder of zeros. */
export function wranglerDatabaseId(file: string): string | undefined {
  const id = wranglerConfig(file).d1_databases?.[0]?.database_id;
  return id && !/^[0-]+$/.test(id) ? id : undefined;
}

/**
 * The D1 settings in the environment: CORPUS_D1_PROXY_URL and CORPUS_D1_PROXY_TOKEN, or Cloudflare's REST
 * API, turned on by CLOUDFLARE_ACCOUNT_ID, with CLOUDFLARE_API_TOKEN and the database (CORPUS_D1_DATABASE_ID,
 * or the id in the Worker's wrangler config), and for covers the R2 bucket (CORPUS_R2_BUCKET, or the
 * Worker's). CLOUDFLARE_API_TOKEN alone doesn't turn it on, since
 * wrangler reads it too. Null when neither is set, and an error naming what's missing when one is set
 * only in part.
 */
export function d1ConfigFrom(env: NodeJS.ProcessEnv, wranglerFile?: string): D1Config | null {
  const v = (name: string) => env[name]?.trim() || undefined;
  const endpoint = v("CORPUS_D1_PROXY_URL");
  if (endpoint) {
    const token = v("CORPUS_D1_PROXY_TOKEN");
    if (!token) throw new D1HttpError("CORPUS_D1_PROXY_URL is set but CORPUS_D1_PROXY_TOKEN isn't.");
    return { endpoint: endpoint.endsWith("/query") ? endpoint : `${endpoint.replace(/\/+$/, "")}/query`, token };
  }
  const accountId = v("CLOUDFLARE_ACCOUNT_ID");
  if (!accountId) return null;
  const token = v("CLOUDFLARE_API_TOKEN"), databaseId = v("CORPUS_D1_DATABASE_ID") ?? (wranglerFile ? wranglerDatabaseId(wranglerFile) : undefined);
  const missing = [["CLOUDFLARE_ACCOUNT_ID", accountId], ["CLOUDFLARE_API_TOKEN", token], ["CORPUS_D1_DATABASE_ID", databaseId]].filter(([, x]) => !x).map(([n]) => n);
  if (missing.length) throw new D1HttpError(`D1 needs ${missing.join(" and ")} as well.`);
  const bucket = v("CORPUS_R2_BUCKET") ?? (wranglerFile ? wranglerConfig(wranglerFile).r2_buckets?.[0]?.bucket_name : undefined);
  return { accountId, databaseId, token: token!, apiBase: v("CLOUDFLARE_API_BASE"), bucket };
}

export function d1Http(config: D1Config, fetchImpl: typeof fetch = globalThis.fetch): D1Http {
  const endpoint = config.endpoint
    ?? `${(config.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "")}/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;

  async function send(body: unknown): Promise<{ success?: boolean; results?: Record<string, unknown>[] }[]> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      throw new D1HttpError(`D1 request failed: ${(error as Error).message}`);
    }
    const text = await response.text().catch((error: Error) => { throw new D1HttpError(`D1 request failed: ${error.message}`); });
    let payload: { success?: boolean; errors?: { message?: string }[]; result?: { success?: boolean; results?: Record<string, unknown>[] }[] };
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new D1HttpError(`D1 HTTP ${response.status}: the response wasn't JSON.`);
    }
    const errors = (payload.errors ?? []).map((e) => e?.message).filter(Boolean).join("; ");
    if (!response.ok || payload.success === false) throw new D1HttpError(errors || `D1 HTTP ${response.status}`);
    const results = Array.isArray(payload.result) ? payload.result : [];
    if (results.some((r) => r?.success === false)) throw new D1HttpError(errors || "A D1 statement failed.");
    return results;
  }

  return {
    batch: (statements) => send({ batch: statements.map((s) => ({ sql: s.sql, ...(s.params.length ? { params: s.params } : {}) })) }),
    query: async (sql, params = []) => (await send({ sql, ...(params.length ? { params } : {}) }))[0]?.results ?? [],
  };
}

/** Where the drain puts cover thumbnails: the public site's R2 bucket. */
export interface CoverStore {
  put(key: string, body: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The R2 bucket over HTTP: the proxy's /covers/<key> (worker/proxy.ts), or Cloudflare's REST API for R2
 * objects with the same token as D1's, which then needs R2 edit as well. Without a bucket for the REST
 * API, every call fails and says so; the drain only calls it with CORPUS_PUBLIC_COVERS on.
 */
export function coverStore(config: D1Config, fetchImpl: typeof fetch = globalThis.fetch): CoverStore {
  const url = (key: string) => {
    if (config.endpoint) return `${config.endpoint.replace(/\/query$/, "")}/covers/${encodeURIComponent(key)}`;
    if (!config.bucket) throw new D1HttpError("Covers need the R2 bucket: set CORPUS_R2_BUCKET, or use the D1 proxy.");
    return `${(config.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "")}/accounts/${config.accountId}/r2/buckets/${config.bucket}/objects/${encodeURIComponent(key)}`;
  };
  async function send(method: "PUT" | "DELETE", key: string, body?: Uint8Array): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(url(key), {
        method, headers: { authorization: `Bearer ${config.token}`, ...(body ? { "content-type": "image/jpeg" } : {}) }, ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
      });
    } catch (error) {
      if (error instanceof D1HttpError) throw error;
      throw new D1HttpError(`R2 request failed: ${(error as Error).message}`);
    }
    // Deleting what's already gone is done.
    if (!response.ok && !(method === "DELETE" && response.status === 404)) {
      const text = await response.text().catch(() => "");
      throw new D1HttpError(`R2 ${method} ${key}: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
    }
  }
  return { put: (key, body) => send("PUT", key, body), delete: (key) => send("DELETE", key) };
}
