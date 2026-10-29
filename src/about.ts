import type { Config } from "./config.js";
import type { DrainStatus } from "./public/drain.js";

/**
 * What the admin About page shows: what the two status-bar items (tools/corpus-status.mjs and
 * tools/replica-status.mjs) show in VS Code, worked out by the server itself. Which branch or pull request
 * it runs and how far behind that is come from GitHub's API (the repository is public, so no token), and
 * whether the public site answers from a request to it. Both are cached for a few minutes, and are
 * "unknown" while the Internet is down, which changes nothing else.
 */

/** What tools/deploy.mjs records in deployed.json. */
export interface Deployed { branch?: string; pr?: number; commit?: string; at?: string; local?: boolean; dirty?: boolean }

export interface About {
  version: string;
  node: string;
  started_at: string;
  books: number;
  last_scan: string | null;
  repository: string;
  deployed: Deployed | null;
  /** From GitHub: the pull request's state and title, and how many commits the running one is behind. */
  origin: { pr_state?: string; pr_title?: string; behind: number | null; checked_at: string | null; error?: string } | null;
  editing: { lan: boolean; lan_actor: string | null; access: boolean };
  public: {
    level: string;
    url: string | null;
    preview_port: number | null;
    replica: DrainStatus | null;
    /** "yes", "not yet" (503), or why it can't be told. */
    published: string | null;
  };
}

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

interface Cached<T> { key: string; at: number; value: T }

/** Builds the About page's data on request, with GitHub and the public site asked at most every few minutes. */
export function aboutSource(config: Config, version: string, repository = process.env.CORPUS_GITHUB_REPO ?? "jmajerus/corpus-mcp", fetchImpl: typeof fetch = fetch) {
  const started = new Date().toISOString();
  let origin: Cached<About["origin"]> | null = null;
  let published: Cached<string | null> | null = null;

  async function github(path: string): Promise<Record<string, unknown>> {
    const res = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "corpus-mcp" }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async function originOf(d: Deployed | null): Promise<About["origin"]> {
    if (!d?.commit || (!d.pr && !d.branch)) return null;
    const key = `${d.pr ?? d.branch}@${d.commit}`;
    if (origin && origin.key === key && Date.now() - origin.at < CACHE_MS) return origin.value;
    let value: About["origin"];
    try {
      let head: string | null = null;
      let state: string | undefined;
      let title: string | undefined;
      if (d.pr) {
        const pr = await github(`/pulls/${d.pr}`);
        state = pr.merged_at ? "merged" : String(pr.state);
        title = String(pr.title ?? "");
        head = state === "open" ? String((pr.head as { sha?: string })?.sha ?? "") : null;
      } else {
        head = String(((await github(`/branches/${encodeURIComponent(d.branch!)}`)).commit as { sha?: string })?.sha ?? "");
      }
      const behind = !head ? null : head === d.commit ? 0 : Number((await github(`/compare/${d.commit}...${head}`)).ahead_by);
      value = { ...(state ? { pr_state: state, pr_title: title } : {}), behind: Number.isInteger(behind) ? behind : null, checked_at: new Date().toISOString() };
    } catch (error) {
      value = { behind: null, checked_at: null, error: `GitHub couldn't be asked (${(error as Error).message})` };
    }
    origin = { key, at: Date.now(), value };
    return value;
  }

  async function publishedAt(url: string | null): Promise<string | null> {
    if (!url) return null;
    if (published && published.key === url && Date.now() - published.at < CACHE_MS) return published.value;
    let value: string;
    try {
      const res = await fetchImpl(`${url}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      value = res.status === 200 ? "yes" : res.status === 503 ? "not yet" : `HTTP ${res.status}`;
    } catch (error) {
      value = `unreachable (${(error as Error).message})`;
    }
    published = { key: url, at: Date.now(), value };
    return value;
  }

  return async (state: { books: number; last_scan: string | null; deployed: Deployed | null; replica: DrainStatus | null }): Promise<About> => {
    const p = config.public;
    const access = config.admin?.access;
    const url = p?.level === "catalogue" && p.url ? p.url : null;
    const [o, pub] = await Promise.all([originOf(state.deployed), publishedAt(url)]);
    return {
      version, node: process.version, started_at: started, books: state.books, last_scan: state.last_scan, repository, deployed: state.deployed, origin: o,
      editing: { lan: !!access?.lanActor, lan_actor: access?.lanActor ?? null, access: !!(access?.teamDomain && access.audience) },
      public: { level: p?.level ?? "none", url, preview_port: p?.port ?? null, replica: state.replica, published: pub },
    };
  };
}
