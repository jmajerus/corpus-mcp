import { describe, expect, it } from "vitest";
import { aboutSource } from "../src/about.js";
import type { Config } from "../src/config.js";

const config = {
  admin: { access: { teamDomain: "https://team.example", audience: "aud", lanActor: "me@lan", lanHosts: ["corpus-mcp", "corpus-mcp.localdomain"] } },
  public: { level: "catalogue", file: "/x/public.db", port: 8001, title: "Library", url: "https://library.example.org", links: [], intervalMinutes: 10 },
} as unknown as Config;

/** A stand-in for GitHub's API and the public site, counting requests. */
function fake(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return new Response("no", { status: 404 });
    if (typeof body === "number") return new Response(null, { status: body });
    return Response.json(body);
  }) as typeof fetch;
  return { impl, calls };
}

const api = "https://api.github.com/repos/me/repo";
const state = (deployed: object | null) => ({ books: 5, last_scan: null, deployed, replica: null });

describe("the About page's data", () => {
  it("says how far a pull request's deploy is behind, and asks again only after a few minutes", async () => {
    const f = fake({
      [`${api}/pulls/4`]: { state: "open", merged_at: null, title: "Printed years", head: { sha: "bbb" } },
      [`${api}/compare/aaa...bbb`]: { ahead_by: 2 },
      "https://library.example.org/": 200,
    });
    const about = aboutSource(config, "0.2.0", "me/repo", f.impl);
    const a = await about(state({ branch: "printed-years", pr: 4, commit: "aaa", at: "2026-10-29T00:00:00Z" }));
    expect(a.origin).toMatchObject({ pr_state: "open", pr_title: "Printed years", behind: 2 });
    // The preview by a LAN name, which works however the page was reached (not the tunnel's hostname).
    expect(a.public).toMatchObject({ url: "https://library.example.org", published: "yes", preview_port: 8001, preview_url: "http://corpus-mcp.localdomain:8001/" });
    expect(a.editing).toEqual({ lan: true, lan_actor: "me@lan", access: true });
    const asked = f.calls.length;
    await about(state({ branch: "printed-years", pr: 4, commit: "aaa" }));
    expect(f.calls.length).toBe(asked);
  });

  it("asks once for a burst of requests that arrive together", async () => {
    const f = fake({ [`${api}/branches/main`]: { commit: { sha: "bbb" } }, [`${api}/compare/aaa...bbb`]: { ahead_by: 3 }, "https://library.example.org/": 503 });
    const about = aboutSource(config, "0.2.0", "me/repo", f.impl);
    const all = await Promise.all(Array.from({ length: 5 }, () => about(state({ branch: "main", commit: "aaa" }))));
    expect(all.map((a) => a.origin?.behind)).toEqual([3, 3, 3, 3, 3]);
    expect(all[0].public.published).toBe("not yet");
    expect(f.calls).toHaveLength(3);
  });

  it("says a merged pull request is no longer open, and a branch that's current is 0 behind", async () => {
    const f = fake({ [`${api}/pulls/2`]: { state: "closed", merged_at: "2026-10-28T00:00:00Z", title: "Done" }, [`${api}/branches/main`]: { commit: { sha: "ccc" } } });
    expect((await aboutSource(config, "0.2.0", "me/repo", f.impl)(state({ branch: "x", pr: 2, commit: "aaa" }))).origin).toMatchObject({ pr_state: "merged", behind: null });
    expect((await aboutSource(config, "0.2.0", "me/repo", f.impl)(state({ branch: "main", commit: "ccc" }))).origin).toMatchObject({ behind: 0 });
  });

  it("says unknown when GitHub or the public site can't be reached", async () => {
    const down = (async () => { throw new Error("offline"); }) as typeof fetch;
    const a = await aboutSource(config, "0.2.0", "me/repo", down)(state({ branch: "main", commit: "aaa" }));
    expect(a.origin).toMatchObject({ behind: null, checked_at: null, error: expect.stringContaining("offline") });
    expect(a.public.published).toMatch(/^unreachable/);
    expect((await aboutSource(config, "0.2.0", "me/repo", down)(state(null))).origin).toBeNull();
  });
});
