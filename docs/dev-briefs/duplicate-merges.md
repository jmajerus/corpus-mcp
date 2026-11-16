# Merging what duplicates carry

Resolving a duplicate group trashes every record except the keeper. Anything the
corpus or its neighbours hold against a trashed record has to move to the keeper,
be dropped deliberately, or stop the trash. This brief records which of these is
done and plans the rest.

## Done

| Held against a record | Where | What happens | Since |
| --- | --- | --- | --- |
| Formats, tags, missing metadata, cover | Calibre | Merged into the keeper by `calibre-duplicates.py` | batch resolution |
| Calibre-Web shelf links | `app.db` | Re-pointed to the keeper in the trash transaction | 2026-11-13 |
| Tag proposal | `tag_proposals` | Moved to the keeper after the trash, or combined with the keeper's (`moveTagProposal`) | PR #43 |
| Pinned citekey | `citekeys` | Moved to the keeper when it has none (`moveDuplicateFiling`) | PR #44 |
| Zotero filing | `zotero_links`, `zotero_items` | The filed item becomes the keeper's confirmed link; rejections carry over | PR #44 |

Moves happen in the apply job's record step, only for records Calibre reports as
trashed (`duplicate_resolved.trash`), and each is logged with the job's id
(`proposal_moved`, `filing_moved`).

### Same-edition rule (citekeys and Zotero)

A citekey or Zotero item names one edition, so filing moves only when the copies
are shown to be the same edition: they share a selected file or a normalized
identifier, or the reviewer confirms it on the card (`same_edition` in the group's
plan, which the Calibre helper passes back unchanged). Even then it blocks when the
two records are cited by different citekeys or match different Zotero items. The rule
is `filingBlocker` in `src/duplicates.ts`, mirrored by `filingBlock` on the review
page, and checked at planning, at apply start and again just before the helper runs.

A Zotero item's "Calibre UUID:" line in Extra still names the trashed record after a
move. Zotero owns Extra and the mirror rewrites it on every sync, so the move records
a confirmed link instead, which `zoteroMatch` checks first.

## Planned

### 1. Anchors: re-anchor in the keeper's text (needs quote-mcp)

Anchors (`anchors`) are positions of quote-mcp's quotes in one record's file.
`relocatedAnchorPlanner` in `src/anchor-migration.ts` already moves an anchor into new
text when its wording occurs exactly once, and could map a trashed record's anchors
onto the keeper's pages: unique wording moves, missing or repeated wording blocks and
is listed by quote.

It cannot ship alone. quote-mcp ties each work to a Calibre UUID (`work_origins`), and
the apply refuses a record with any quote in quote-mcp (`assertNoBookQuotes`).
Re-pointing anchors here while quote-mcp's work still names the trashed UUID would
split the quote from its anchor. It needs, in order:

1. A quote-mcp endpoint that adds the keeper's UUID as an origin of the work, or
   re-points it, and answers which quotes it covers.
2. Here: a preview that runs the planner per anchor against the keeper ("N anchors
   move, M need review") and blocks on any that need review.
3. At apply, after the trash: write the new anchors with a `reanchored` change for
   each (quote-mcp already follows `/api/anchors/changes`), then call the quote-mcp
   endpoint; replace `assertNoBookQuotes` with a check that every quote has a planned
   anchor.

Agree the endpoint with the quote-mcp project first.

### 2. Quotes in quote-mcp without anchors

Unanchored quotes (paper-book quotes, or ones that failed verification) have no
position to move; they only need the work origin from step 1. They could move with no
text check, once the endpoint exists.

The corpus `quotes` table is left over from before quote-mcp and stays a hard blocker
until it is removed (see the quote tools retirement hold).

### 3. Calibre-Web reading data

Still blocking in `calibre-duplicates.py`: `book_read_link`, `archived_book`,
`downloads` and `bookmark`.

- Reading status, archived flags and download history describe the book, not the
  file. Re-point them to the keeper in the same transaction as the shelf links. Where
  the keeper already has a row for that user, keep the more advanced reading status
  and the earlier download.
- Bookmarks are positions in a specific file and format. Keep blocking, or offer to
  drop them with an explicit tick listing whose they are.

This change is in the Calibre helper and its validation script
(`tools/validate-calibre-duplicates.py`), not in corpus-mcp.

### 4. Choosing the file per format

Today the keeper's file wins a format both records have (`discard_conflicts`), or the
group blocks. The content comparison often points the other way for one format, for
example the duplicate's EPUB has a page list but the keeper's PDF is the better scan.

Plan: a per-format choice on the card, defaulting to the copy with no content warning
for that format, sent as `formats: {EPUB: <calibre id>, ...}` in the group. The helper
replaces the keeper's file for each format chosen from another record before trashing
it, and the fingerprint covers the choice. Corpus re-extracts the keeper on the
following refresh, and its anchors (once item 1 exists) re-anchor through the usual
scan path.

### 5. Zotero Extra

Optional. After a Zotero move, rewrite the item's Extra line to the keeper's UUID
through the Zotero tools, so other readers of Extra agree. The confirmed link already
makes corpus-mcp correct, so this is cosmetic unless another tool reads Extra.

## Never merged

Index data (extracted text, page labels, outlines, content profiles) is rebuilt by the
refresh after apply. Keep-both decisions belong to pairs, and pairs that include a
trashed record disappear with it.
