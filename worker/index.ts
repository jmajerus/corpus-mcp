import { coverBook, coverKey, isPublicPath, renderPublic } from "../src/public/site.js";
import { FAVICON_PATHS, favicon } from "../src/web/favicon.js";
import { type D1Database, d1Store } from "./d1.js";

/**
 * The public catalogue as a Cloudflare Worker: the same pages the LAN server renders (src/public/site.ts),
 * read from the public snapshot's replica in D1, which only corpus-mcp's drain writes (through the proxy,
 * worker/proxy.ts). As quote-mcp's worker/index.ts.
 *
 * Each answer carries the deployed code's build id plus the snapshot's hash as its ETag — either changing
 * makes clients revalidate — so a revalidation that finds nothing new is a 304 after reading only the
 * snapshot's meta: a page reads hundreds of D1 rows, and D1's free tier allows five million a day across
 * the account.
 *
 * Cover thumbnails (/covers/<id>.jpg) come from the R2 bucket the drain fills (COVERS). A book page names
 * its cover with the thumbnail's stamp in the query, so a cover may be cached for a day.
 */

/** The part of an R2 binding the Worker reads. */
export interface CoverObjects {
  get(key: string): Promise<{ body: ReadableStream; httpEtag: string } | null>;
}

export interface Env {
  DB: D1Database;
  COVERS?: CoverObjects;
}

async function cover(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed", { allow: "GET, HEAD" });
  const object = env.COVERS ? await env.COVERS.get(coverKey(id)) : null;
  if (!object) return text(404, "Not found");
  const headers = { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", etag: object.httpEtag, "x-content-type-options": "nosniff" };
  if (request.method === "HEAD" || request.headers.get("if-none-match")?.split(/\s*,\s*/).includes(object.httpEtag)) {
    await object.body.cancel();
    return new Response(null, { status: request.method === "HEAD" ? 200 : 304, headers });
  }
  return new Response(object.body, { headers });
}

/** The deployed code's build id, from worker:deploy's --define; empty under tests and wrangler dev. */
declare const RENDER_BUILD: string;
const renderBuild = typeof RENDER_BUILD === "undefined" ? "" : RENDER_BUILD;

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

/** The snapshot's hash once the drain has shipped a whole snapshot: meta, which carries it, is written last. */
async function publishedHash(db: D1Database): Promise<string | null> {
  try {
    return (await db.prepare("SELECT value FROM meta WHERE key = 'hash'").first<{ value: string }>())?.value ?? null;
  } catch {
    return null;
  }
}

export async function handle(request: Request, env: Env): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return text(400, "Bad request");
  }
  if (FAVICON_PATHS.has(url.pathname)) {
    return new Response(request.method === "HEAD" ? null : favicon(), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  }
  const coverOf = coverBook(url.pathname);
  if (coverOf !== null) return cover(request, env, coverOf);
  if (!isPublicPath(url.pathname)) return text(404, "Not found");
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed", { allow: "GET, HEAD" });
  const hash = await publishedHash(env.DB);
  if (!hash) return text(503, "This catalogue hasn't been published yet.", { "retry-after": "60" });
  const etag = `W/"${renderBuild ? `${renderBuild}-` : ""}${hash.slice(0, 20)}"`;
  if (request.headers.get("if-none-match")?.split(/\s*,\s*/).includes(etag)) {
    return new Response(null, { status: 304, headers: { "cache-control": "public, max-age=300", etag, "x-content-type-options": "nosniff" } });
  }

  const out = await renderPublic(d1Store(env.DB), url.pathname, url.searchParams);
  if (!out) return text(404, "Not found");
  const headers: Record<string, string> = { "content-type": out.type, "x-content-type-options": "nosniff" };
  if (out.status === 200) Object.assign(headers, { "cache-control": "public, max-age=300", etag });
  return new Response(request.method === "HEAD" ? null : out.body, { status: out.status, headers });
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
