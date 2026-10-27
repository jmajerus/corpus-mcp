# Categories and the taxonomy

Calibre tags (Calibre-Web's *Categories*) follow a controlled vocabulary that
the taxonomy's owner supplies as a JSON file (format below). Here that owner is
[Concept Clusters](https://github.com/jmajerus/concept-clusters); any project can
supply its own. Term ids are the tags, nested with `.` such as
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

## Pushing the vocabulary

The owner pushes the file to `POST /api/intake/vocabulary` with a Cloudflare
Access service token (`CORPUS_VOCABULARY_PUSH_CLIENT_ID`), through an Access
application that covers only that path (`CORPUS_VOCABULARY_PUSH_AUD`); the
token unlocks nothing else. Answers:

- 200 with `version` and `terms`, plus `unchanged: true` when that version is
  already installed;
- 422 with `problems`, a list of strings, when invalid.

`npm run deploy -- --vocabulary=<file>` still validates and installs one by hand.

## The taxonomy overlay

corpus-mcp never edits a vocabulary another project supplies. Its own terms,
coined during research, live in the **taxonomy overlay** (`src/taxonomy/`),
merged over the supplied vocabulary for every tool. An agent adds one with
`add_provisional_term`; a person confirms, edits, moves, or retires it at
`/admin/taxonomy`.

- Overlay terms have opaque, stable ids, a scope note, and a history of every
  change.
- A moved or retired term's old path is retired in the merged vocabulary, so the
  tags job re-tags its books.
- When the supplied vocabulary gains a term at the same path, it takes over, the
  overlay term is marked superseded, and books keep the tag. So to adopt an
  overlay term, the owner creates it with the same slug under the same parent.
- An overlay term whose parent disappears is left out and reported, never fatal.

[PLAN.md](../PLAN.md) (*Living taxonomy*) has the plan this is the first stage of.
