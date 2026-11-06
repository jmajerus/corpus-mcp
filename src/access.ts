import type http from "node:http";
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Cloudflare Access identity for admin pages and writes, on the pattern of concept-clusters'
 * modules/accessAuth.js. Requests through the Cloudflare tunnel carry a Cf-Access-Jwt-Assertion token,
 * verified here against the team's signing keys and issuer. The audience (which Access application issued
 * the token) is not checked: every application in the team admits only the owner, and a pinned audience
 * tag broke sign-in whenever an application was recreated.
 *
 * The LAN is trusted, as /mcp already trusts it: a request made directly from a private address, with no
 * Cloudflare headers, may write too, recorded under the configured LAN actor (`lanActor`; off when
 * unset). A request through the tunnel also arrives from the LAN, from wherever cloudflared runs, so the
 * Cloudflare headers are what keep an Internet request from passing as a LAN one.
 *
 * A LAN request must also name the server by one of its own LAN names (`lanHosts`) or by an IP address.
 * Otherwise a web page could use DNS rebinding (its own domain name, re-pointed at this server's address)
 * to send same-origin requests from a browser on the LAN, which no CORS rule would stop.
 */

export interface AccessConfig {
  /** e.g. https://linkbud.cloudflareaccess.com */
  teamDomain?: string;
  /** The name LAN edits are recorded under; unset, direct LAN requests are read-only. */
  lanActor?: string;
  /** The names the server is reached by on the LAN, besides IP addresses ("corpus-mcp.localdomain"). */
  lanHosts?: string[];
}

export interface AccessIdentity { subject: string; email?: string; via?: "access" | "lan" }

export type AccessResult = { identity: AccessIdentity } | { status: number; error: string };

const keySets = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  if (!keySets.has(teamDomain)) keySets.set(teamDomain, createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain)));
  return keySets.get(teamDomain)!;
}

async function verifiedPayload(token: string, teamDomain: string, keys?: JWTVerifyGetKey) {
  const team = new URL(teamDomain);
  if (team.protocol !== "https:") throw new Error("The Access team domain must use https");
  return (await jwtVerify(token, keys ?? remoteKeys(team.origin), { issuer: team.origin })).payload;
}

export async function verifyAccessToken(token: string, config: { teamDomain: string }, keys?: JWTVerifyGetKey): Promise<AccessIdentity> {
  const payload = await verifiedPayload(token, config.teamDomain, keys);
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Access token has no subject");
  return { subject: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
}

/** A private, loopback, or link-local address: the LAN, or this machine. */
export function privateAddress(address: string | undefined): boolean {
  const a = (address ?? "").toLowerCase().replace(/^::ffff:/, "");
  if (/^(?:10|127)\.\d+\.\d+\.\d+$/.test(a) || /^192\.168\.\d+\.\d+$/.test(a) || /^169\.254\.\d+\.\d+$/.test(a)) return true;
  const b = a.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (b && Number(b[1]) >= 16 && Number(b[1]) <= 31) return true;
  return a === "::1" || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/**
 * True for a request made directly on the LAN: from a private address, with none of the headers a CDN or
 * Cloudflare adds (present at all, whatever their value).
 */
export function lanRequest(req: http.IncomingMessage): boolean {
  const viaProxy = ["cf-ray", "cf-connecting-ip", "cdn-loop"].some((h) => h in req.headers);
  return !viaProxy && privateAddress(req.socket.remoteAddress);
}

/** The host a request names, without its port: "corpus-mcp.localdomain", "192.168.1.20", or "::1". */
function requestHost(req: http.IncomingMessage): string {
  const host = String(req.headers.host ?? "").trim().toLowerCase();
  const v6 = host.match(/^\[([^\]]+)\]/);
  return v6 ? v6[1] : host.replace(/:\d+$/, "");
}

/** True when the request names the server by an IP address or one of its LAN names, never another site's name. */
export function lanHostAllowed(req: http.IncomingMessage, lanHosts: string[] = []): boolean {
  const host = requestHost(req);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return true;
  return host === "localhost" || lanHosts.some((h) => h.toLowerCase() === host);
}

/** The identity behind a request: a verified Access identity, or the LAN actor for a direct LAN request; or why there is none. */
export async function accessIdentity(req: http.IncomingMessage, config: AccessConfig, keys?: JWTVerifyGetKey): Promise<AccessResult> {
  const token = req.headers["cf-access-jwt-assertion"];
  if (typeof token !== "string" || !token) {
    if (lanRequest(req)) {
      if (!config.lanActor) return { status: 401, error: "Edits on the LAN are turned off (CORPUS_LAN_EDITS=off); sign in through Cloudflare Access to make changes." };
      if (!lanHostAllowed(req, config.lanHosts)) {
        return { status: 403, error: `This request names the server "${requestHost(req)}", not one of its LAN names (CORPUS_LAN_HOSTS) or an IP address, so it can't make changes.` };
      }
      return { identity: { subject: "lan", email: config.lanActor, via: "lan" } };
    }
    return { status: 401, error: "Sign in through Cloudflare Access to make changes." };
  }
  if (!config.teamDomain) {
    return { status: 503, error: "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN), so changes are disabled." };
  }
  try {
    return { identity: { ...(await verifyAccessToken(token, { teamDomain: config.teamDomain }, keys)), via: "access" } };
  } catch (error) {
    return { status: 403, error: `Cloudflare Access token rejected: ${(error as Error).message}` };
  }
}
