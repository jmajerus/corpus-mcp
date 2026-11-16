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
| Anchors of quote-mcp's quotes | `anchors` | Re-anchored in the keeper's text when the wording occurs exactly once there; otherwise the merge is blocked (`planAnchorMoves`, `moveAnchors`) | PR #45 |
| The trashed UUID itself | `book_aliases` | Recorded as an alias of the keeper, so quote-mcp's references keep resolving | PR #45 |

Moves happen in the apply job's record step, only for records Calibre reports as
trashed (`duplicate_resolved.trash`), and each is logged with the job's id
(`proposal_moved`, `filing_moved`, `quotes_moved`).

### Quotes (anchors and the alias)

Built in PR #45, with no change to quote-mcp:

- **Preview.** For each record to be trashed, each verified anchor is planned against
  the keeper's text with `relocatedAnchorPlanner`: its wording must be intact in the
  duplicate and occur exactly once in the keeper. Any other result blocks the group
  and names the quotes; the review card shows the same from `anchor_moves`. Anchors
  already orphaned do not block.
- **quote-mcp check.** `assertBookQuotesMovable` replaces the blanket refusal: a
  quote with no anchor passes (the alias carries it); one quote-mcp has an anchor for
  must have its anchor here. It still fails closed when quote-mcp cannot be asked.
- **Apply, after the trash and before the refresh** (the trashed record's pages are
  still indexed): planned anchors are written verified against the keeper with a
  `reanchored` change, which quote-mcp follows as usual. Orphaned ones, and any that
  can no longer be placed, go to the keeper orphaned with no file hash, so the next
  scan searches the keeper for them. Then the alias is recorded.
- **Afterwards.** quote-mcp still lists these quotes under the trashed UUID, so the
  reader asks it for the keeper's UUID and each alias, and the books feed gives each
  book's `former_uuids`.

### Same-edition rule (citekeys and Zotero)

A citekey or Zotero item names one edition, so filing moves only when the copies
are shown to be the same edition: they share a selected file or a normalized
identifier, or the reviewer confirms it on the card (`same_edition` in the group's
plan, which the Calibre helper passes back unchanged). Even then it blocks when the
two records are cited by different citekeys or match different Zotero items, or when
the trashed record's Zotero item is in Zotero's trash with nothing merged into it
(there is nothing to move the filing to). A Zotero item rejected for the trashed
record is never promoted; the rejection carries over instead. Only stored filing (a
pinned citekey, a link, or Extra's UUID) counts toward the keeper ranking, not an ISBN
match. The rule
is `filingBlocker` in `src/duplicates.ts`, mirrored by `filingBlock` on the review
page, and checked at planning, at apply start and again just before the helper runs.

A Zotero item's "Calibre UUID:" line in Extra still names the trashed record after a
move. Zotero owns Extra and the mirror rewrites it on every sync, so the move records
a confirmed link instead, which `zoteroMatch` checks first.

## Planned

### 1. Anchors: re-anchor in the keeper's text (built, PR #45; see above)

The original plan, kept for the record:

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

Superseded 2026-11-16: steps 1 and the endpoint call in step 3 are dropped, because no
quote-mcp endpoint is needed. corpus-mcp records the
trashed UUID as an alias of the keeper (`book_aliases`, PLAN.md "Calibre downstream"),
so quote-mcp's references keep resolving, and only the anchor move (step 2) remains.
The withdrawn proposal is [duplicate-quote-rebind.md](duplicate-quote-rebind.md).

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
