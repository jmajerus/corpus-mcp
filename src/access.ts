import type http from "node:http";
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Cloudflare Access identity for admin pages and writes, on the pattern of concept-clusters'
 * modules/accessAuth.js. Requests through the Cloudflare tunnel carry a Cf-Access-Jwt-Assertion token,
 * verified here against the team's signing keys, issuer, and the corpus application's audience tag.
 * Direct LAN requests carry none, so they get read-only access. Without a configured team domain and
 * audience, every write is refused (fail closed).
 */

export interface AccessConfig {
  /** e.g. https://linkbud.cloudflareaccess.com */
  teamDomain?: string;
  /** The corpus Access application's audience (AUD) tag. */
  audience?: string;
  /**
   * The vocabulary intake's service token: its client id and its own Access application's audience. The
   * token is accepted on the intake alone, never for the other writes.
   */
  vocabularyPush?: { clientId?: string; audience?: string };
}

export interface AccessIdentity { subject: string; email?: string }

export type AccessResult = { identity: AccessIdentity } | { status: number; error: string };

const keySets = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  if (!keySets.has(teamDomain)) keySets.set(teamDomain, createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain)));
  return keySets.get(teamDomain)!;
}

async function verifiedPayload(token: string, teamDomain: string, audience: string, keys?: JWTVerifyGetKey) {
  const team = new URL(teamDomain);
  if (team.protocol !== "https:") throw new Error("The Access team domain must use https");
  return (await jwtVerify(token, keys ?? remoteKeys(team.origin), { issuer: team.origin, audience })).payload;
}

export async function verifyAccessToken(token: string, config: { teamDomain: string; audience: string }, keys?: JWTVerifyGetKey): Promise<AccessIdentity> {
  const payload = await verifiedPayload(token, config.teamDomain, config.audience, keys);
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Access token has no subject");
  return { subject: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
}

/** The verified Access identity behind a request, or why there is none. */
export async function accessIdentity(req: http.IncomingMessage, config: AccessConfig, keys?: JWTVerifyGetKey): Promise<AccessResult> {
  const token = req.headers["cf-access-jwt-assertion"];
  if (typeof token !== "string" || !token) {
    return { status: 401, error: "Sign in through Cloudflare Access to make changes; direct LAN access is read-only." };
  }
  if (!config.teamDomain || !config.audience) {
    return { status: 503, error: "Cloudflare Access is not configured (CORPUS_ACCESS_TEAM_DOMAIN, CORPUS_ACCESS_AUD), so changes are disabled." };
  }
  try {
    return { identity: await verifyAccessToken(token, { teamDomain: config.teamDomain, audience: config.audience }, keys) };
  } catch (error) {
    return { status: 403, error: `Cloudflare Access token rejected: ${(error as Error).message}` };
  }
}

/**
 * The vocabulary intake's caller: a service token's JWT for the intake's own Access application. Service
 * tokens carry no subject; Access names the token by its client id in common_name.
 */
export async function vocabularyPushIdentity(req: http.IncomingMessage, config: AccessConfig, keys?: JWTVerifyGetKey): Promise<AccessResult> {
  const token = req.headers["cf-access-jwt-assertion"];
  if (typeof token !== "string" || !token) return { status: 401, error: "Send the vocabulary through Cloudflare Access with the intake's service token." };
  const push = config.vocabularyPush;
  if (!config.teamDomain || !push?.clientId || !push.audience) {
    return { status: 503, error: "The vocabulary intake is not configured (CORPUS_VOCABULARY_PUSH_CLIENT_ID, CORPUS_VOCABULARY_PUSH_AUD)." };
  }
  try {
    const payload = await verifiedPayload(token, config.teamDomain, push.audience, keys);
    if (payload.common_name !== push.clientId) {
      // Claim names only, never values, so a token shaped differently than expected can be diagnosed.
      console.error(`vocabulary intake: token is not the intake's service token (claims: ${Object.keys(payload).sort().join(", ")})`);
      return { status: 403, error: "Not the vocabulary intake's service token." };
    }
    return { identity: { subject: `service:${push.clientId}` } };
  } catch (error) {
    return { status: 403, error: `Cloudflare Access token rejected: ${(error as Error).message}` };
  }
}
