import { ToolError, type Corpus } from "../tools.js";
import { type ProposeArgs, proposeTerm } from "./terminology.js";

/**
 * The taxonomy's operations for the MCP tools, and the admin page. The only part of
 * src/taxonomy/ that knows about books.
 */

/**
 * add_provisional_term: a new term proposed to terminology-mcp, under an existing term here. It is
 * usable for tagging as soon as the follower has applied it, which this waits for.
 */
export async function addTerm(c: Corpus, args: ProposeArgs, actor: string) {
  if (!c.terminology) throw new ToolError("New terms are proposed in terminology-mcp, which this server doesn't follow (CORPUS_TERMINOLOGY_URL).");
  // A parent the follower hasn't seen yet may be new there: catch up once before giving up.
  const resolve = () => {
    const tag = c.vocabulary.toSlugPath(args.parent.trim()).toLowerCase();
    return { tag, id: c.vocabulary.labelFor(tag) ? c.terminology!.termIdForTag(tag) : undefined };
  };
  let parent = resolve();
  if (!parent.id) {
    await c.terminology.sync().catch(() => {});
    parent = resolve();
  }
  if (!c.vocabulary.labelFor(parent.tag)) throw new ToolError(`Parent "${args.parent}" is not a term. Use get_tag_vocabulary for the terms.`);
  if (!parent.id) throw new ToolError(`"${parent.tag}" isn't in terminology-mcp's cc-subjects (${c.terminology.status().error ?? "not synced yet"}).`);
  const parentId = parent.id;
  const answer = await proposeTerm(c.terminology.config.url, parentId, args, `corpus-mcp:${actor}`);
  await c.terminology.sync().catch(() => {});
  const tag = `${parent.tag}.${String(answer.slug)}`;
  const term = c.vocabulary.find(tag);
  return {
    tag, status: answer.status, term_id: answer.id, ...(answer.replayed ? { replayed: true } : {}),
    usable: Boolean(term),
    note: term
      ? `"${tag}" is a provisional term in terminology-mcp: use it with propose_tags now. Its owner confirms, merges, or retires it there.`
      : `"${tag}" was proposed in terminology-mcp; it becomes usable here once the next sync applies it.`,
  };
}

/** Everything the admin page shows: where the vocabulary comes from, how far the follower has got, and the provisional terms. */
export function taxonomyOverview(c: Corpus) {
  const v = c.vocabulary;
  const booksWith = c.db.prepare<[string], { n: number }>("SELECT COUNT(DISTINCT b.id) AS n FROM books b, json_each(b.tags) j WHERE j.value = ?");
  return {
    source: c.terminology ? "terminology-mcp" : "file",
    vocabulary: {
      version: v.version, generated_at: v.generatedAt, terms: v.terms.length, assignable: v.tags.length,
      retired: v.file.retired?.length ?? 0, error: c.vocabularySource?.error ?? null,
    },
    terminology: c.terminology?.status() ?? null,
    provisional: v.terms.filter((t) => t.status === "provisional").map((t) => ({ ...t, books: booksWith.get(t.tag)?.n ?? 0 })),
  };
}
