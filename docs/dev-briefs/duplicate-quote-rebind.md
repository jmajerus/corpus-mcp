# Proposal to quote-mcp: move quotes when corpus-mcp merges duplicate books

Status: withdrawn 2026-11-16, the day it was drafted; never sent to quote-mcp and not
built. corpus-mcp keeps an alias from a trashed record's UUID to its keeper (PLAN.md,
"Calibre downstream", Identity), so quote-mcp's references keep resolving and no rebind
is needed. Kept for its account of where quote-mcp ties a quote to a Calibre book.

## Why

corpus-mcp's duplicate review merges Calibre records that are the same book and
trashes all but one, the keeper. Tag proposals, pinned citekeys and Zotero filing
already move to the keeper (corpus-mcp PRs #43 and #44). Quotes do not. Today a record
with any quote in quote-mcp cannot be trashed: corpus-mcp asks
`GET /api/corpus/quotes?book=<uuid>` before the trash and refuses if the list is not
empty. As a result, the copy you once quoted from has to stay the keeper, even when the
other copy is better (for example, its EPUB maps print pages).

corpus-mcp can already move an anchor into another copy's text when the wording occurs
exactly once (`relocatedAnchorPlanner`). What it cannot do is change where quote-mcp
thinks the quote's book is.

## Where quote-mcp ties a quote to a Calibre book

Read from quote-mcp at `28db3e8`:

1. `work_origins (kind 'calibre', ref <uuid>) → work_id`. `knownCalibreWork` resolves a
   UUID to its work, and `calibreBookOf` takes the first `calibre` origin of a work
   (`LIMIT 1`).
2. `quote_origins.raw` for kinds `agent` and `corpus`: `$.book.calibre_uuid`,
   `$.book.book_id`, and `$.anchor` (which carries its own `calibre_uuid`).
   `bookQuotes` (the reader's list, and corpus-mcp's pre-trash check) matches on
   `$.book.*`.
3. `calibre_books (calibre_uuid → corpus-mcp's book record)`, refreshed from the books
   feed for every UUID in `work_origins`.

`followAnchors` already replaces `raw.anchor` from each non-orphaned anchor change,
including its `calibre_uuid`, and clears `anchor_lost`. It does not touch `raw.book`,
`work_origins` or `calibre_books`. So if corpus-mcp only re-pointed anchors, the reader
and the pre-trash check would still list the quotes under the trashed UUID, and
`calibreBookOf` could still name the trashed book.

## Proposed endpoint

```
POST /api/corpus/rebind      (LAN only, same access as /api/corpus/quotes)
{
  "from": { "calibre_uuid": "...", "book_id": "main:56" },
  "to":   { "calibre_uuid": "...", "book_id": "main:957" },
  "dry_run": true | false,
  "request_id": "duplicates-job-<id>-<removed id>"     // idempotency key
}
→ 200 {
  "work_id": 123 | null,               // the work from's UUID resolves to, if any
  "quotes": [{ "id": 9, "anchored": true }, ...],   // what bookQuotes lists for from
  "conflict": null | { "error": "different-work", "from_work": 123, "to_work": 456 },
  "applied": false | true
}
```

On `dry_run: false` with no conflict, in one transaction:

1. Re-point `work_origins ('calibre', from)` to `to`, and keep `from` as an alias, for
   example a new kind `calibre-merged`, which `knownCalibreWork` also reads. Old keys
   keep resolving, as holdings expects, and `calibreBookOf`'s `LIMIT 1` cannot pick the
   trashed record.
2. For each `agent`/`corpus` origin whose `$.book.calibre_uuid` (or `book_id`) is
   `from`: set `$.book.calibre_uuid`, `$.book.book_id` (and title, if `to` sends it) to
   the keeper's. Leave `$.anchor` alone: corpus-mcp's anchor change carries it.
3. Copy `calibre_books[from]` to `to` if `to` has none. The next books-feed pass
   refreshes it.
4. Write a `history` row per quote (`kind 'book_merged'`, actor `corpus-mcp`, reason
   naming both book ids and the job).

Repeating a request with the same `request_id`, or re-binding something already bound,
changes nothing and answers `applied: true`.

**Conflict:** `to` already resolves to a different work than `from`. Merging two works
is a person's decision in quote-mcp, so the endpoint refuses, and corpus-mcp keeps the
duplicate blocked with that message.

## How corpus-mcp would use it

- **Preview:** call with `dry_run: true` for each record to be trashed. Run the anchor
  planner on each anchored quote against the keeper's pages. The group is blocked if any
  anchor needs review (wording not found, or repeated), or on a conflict. The card shows
  "N quotes move (M re-anchored)".
- **Apply, after Calibre reports the trash:**
  1. Write each new anchor with a `reanchored` change against the keeper's UUID, which
     `followAnchors` already applies.
  2. Call `rebind` with `dry_run: false`.

  If quote-mcp cannot be reached, corpus-mcp keeps the rebind in a retry table and
  retries it on the next job or refresh until it succeeds. The trash has already
  happened, so it cannot be undone.
- **The pre-trash check:** this replaces today's blanket refusal with "every quote is
  either unanchored or has a planned anchor, and the dry run has no conflict".

No new anchor change kind is needed. One option: a `moved` kind instead of
`reanchored`, if quote-mcp wants its history to say the book changed, not just the
position.

## Questions for quote-mcp

1. Alias kind for the old UUID (`calibre-merged`), or re-point and drop it? corpus-mcp
   prefers the alias, so links and citations that name the old UUID keep resolving.
2. Should unanchored quotes (paper-book transcriptions checked as `transcribed`, or
   ones whose verify failed) move without a text check? corpus-mcp would say yes: they
   were never tied to a position in the file.
3. Is `request_id` enough for idempotency, or does quote-mcp want to key on
   `(from, to)`?
4. Does anything besides `bookQuotes`, `calibreBookOf`, the holdings feed and the
   books feed read the Calibre UUID?
