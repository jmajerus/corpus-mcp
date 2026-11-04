# Categories and the taxonomy

Calibre tags (Calibre-Web's *Categories*) follow a controlled vocabulary:
[terminology-mcp](https://github.com/jmajerus/terminology-mcp)'s `cc-subjects`
scheme, the subjects [Concept Clusters](https://github.com/jmajerus/concept-clusters)
uses too. corpus-mcp follows it into a JSON file (format below). Term ids are
the tags, nested with `.` such as
`social-sciences.psychology.social-psychology`, so a renamed term leaves
Calibre's tags valid. Tools and the admin pages show the titles
("Social Sciences › Psychology › Social Psychology") and accept either form.

## Tagging books

An agent takes books from `tagging_worklist` and calls `propose_tags`. A person
approves, edits, or rejects each proposal at `/admin/proposals`, or sets a book's
categories directly on its page (see [Using the admin pages](admin-ui.md#proposals-adminproposals)).
An approved category set is a book's complete set of vocabulary tags.

The approved sets reach Calibre through the **Apply approved tags to Calibre**
job (preview, then apply), or from the command line:
`npm run tags:apply -- --apply` runs [`tools/calibre-tags.sh`](../tools/calibre-tags.sh)
on the Calibre-Web host. Either way, `metadata.db` is backed up first, and only
vocabulary tags are added or removed; other tags are left alone.

## The vocabulary file

The vocabulary file (`corpus-vocabulary/1`) is a flat list of terms:

```json
{
  "format": "corpus-vocabulary/1",
  "version": "any string",
  "generatedAt": "2026-10-25T12:00:00Z",
  "terms": [
    { "id": "social-sciences", "label": "Social Sciences", "assignable": false },
    { "id": "social-sciences.psychology", "label": "Psychology", "parent": "social-sciences" }
  ],
  "retired": [{ "id": "old.term", "replacedBy": ["social-sciences.psychology"] }]
}
```

- An id is its parent's id, `.`, and one segment of lowercase letters, digits,
  and single hyphens. A label is the term's own title, without `.` or `›`.
- `assignable: false` marks a term that only groups others.
- Optional per term: `scopeNote`, what belongs under it and what doesn't.
- A retired term with one replacement is re-tagged by the tags job; one that
  was split or dropped waits for a person.
- The server reads `/var/lib/corpus-mcp/vocabulary.json` (`CORPUS_VOCABULARY`)
  and reloads it when it changes; an invalid file is reported and the last good
  one stays in use.
- `vocabulary_report` (and the categories page) lists retired terms still in
  Calibre, tags shaped like terms that the vocabulary lacks, and books tagged
  only at a term with narrower ones.

## Following terminology-mcp

The HTTP server follows `cc-subjects` (`src/taxonomy/terminology.ts`). It
bootstraps once from `/api/state`, then reads `/api/changes` from its cursor
every 30 seconds (`CORPUS_TERMINOLOGY_INTERVAL_SECONDS`), and installs the
vocabulary it builds. It reports how far it has got to terminology-mcp
(`/api/subscribers/corpus-mcp/progress`), so terminology-mcp's editor shows it
among the subscribers.

- A term's tag is its slug chain along `broader`, never terminology-mcp's
  `path`, which is built from labels. A rename changes the title, not the tag.
- Domains (the top terms) group others and aren't assignable.
- A change that alters a tag (a slug change on a term or an ancestor, a move, a
  merge, a split, a retire) retires the old tag. With one replacement the tags
  job re-tags books; a split, or a retire with none, waits for a person on the
  vocabulary report. corpus-mcp never holds a change: its cursor always moves on.
- If terminology-mcp's store is rebuilt (its `log` id changes), the follower
  starts over from the state and reports with `reset: true`.
- `CORPUS_TERMINOLOGY_URL` names the server (default
  `http://terminology-mcp.localdomain:8000`); `off` turns following off and
  lets Concept Clusters' push install the vocabulary again.

**New terms.** `add_provisional_term` proposes a term to terminology-mcp
(`POST /api/proposals`) under an existing domain or category. `cc-subjects` is
three levels deep, and takes a proposal only when it is copied from a term in a
reference vocabulary (`source`, found with terminology-mcp's `search_terms`). A
proposal is provisional and usable at once; its owner confirms, merges, or
retires it in terminology-mcp. A refusal comes back with terminology-mcp's
reason. When nothing fits even broadly, a person adds the term in
terminology-mcp's editor.

## Pushing the vocabulary

While corpus-mcp follows terminology-mcp, the intake answers 409 and installs
nothing: one writer at a time. With `CORPUS_TERMINOLOGY_URL=off`, the owner pushes the file to `POST /api/intake/vocabulary` with a Cloudflare
Access service token (`CORPUS_VOCABULARY_PUSH_CLIENT_ID`), through an Access
application that covers only that path; the token unlocks nothing else. Answers:

- 200 with `version` and `terms`, plus `unchanged: true` when that version is
  already installed;
- 422 with `problems`, a list of strings, when invalid.

`npm run deploy -- --vocabulary=<file>` still validates and installs one by hand.

[PLAN.md](../PLAN.md) (*Living taxonomy*) has the plan this is stage 3 of. The
overlay of corpus-mcp's own research terms that stage 1 built is gone: it never
held a term, and new terms are proposed in terminology-mcp instead.
