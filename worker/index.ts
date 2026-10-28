import { isPublicPath, renderPublic } from "../src/public/site.js";
import { type D1Database, d1Store } from "./d1.js";

/**
 * The public catalogue as a Cloudflare Worker: the same pages the LAN server renders (src/public/site.ts),
 * read from the public snapshot's replica in D1, which only corpus-mcp's drain writes (through the proxy,
 * worker/proxy.ts). As quote-mcp's worker/index.ts.
 *
 * Responses can be cached for five minutes, with an ETag from the response itself, so a revalidation
 * that finds the page unchanged is a 304.
 */

export interface Env {
  DB: D1Database;
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

/** True once the drain has shipped a whole snapshot: meta, which carries its hash, is written last. */
async function published(db: D1Database): Promise<boolean> {
  try {
    return !!(await db.prepare("SELECT value FROM meta WHERE key = 'hash'").first<{ value: string }>())?.value;
  } catch {
    return false;
  }
}

export async function handle(request: Request, env: Env): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return text(400, "Bad request");
  }
  if (!isPublicPath(url.pathname)) return text(404, "Not found");
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed", { allow: "GET, HEAD" });
  if (!(await published(env.DB))) return text(503, "This catalogue hasn't been published yet.", { "retry-after": "60" });

  const out = await renderPublic(d1Store(env.DB), url.pathname, url.searchParams);
  if (!out) return text(404, "Not found");
  const headers: Record<string, string> = { "content-type": out.type, "x-content-type-options": "nosniff" };
  if (out.etag) {
    Object.assign(headers, { "cache-control": "public, max-age=300", etag: out.etag });
    if (request.headers.get("if-none-match")?.split(/\s*,\s*/).includes(out.etag)) return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : out.body, { status: out.status, headers });
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
