# Pandoc candidate validation, 2026-11-07 UTC

The 239 staged EPUBs pass structural, source-hash, search, reading, citation, and passage-verification
checks. The private candidate is **not approved for activation**. Production still serves all 305
indexed EPUBs with profile 1; its corpus service and refresh timer remain active.

## Completed checks

The run root on `corpus-mcp.localdomain` is
`/var/lib/corpus-mcp/reextraction/20261106-pandoc-v3`.

- SQLite integrity and foreign-key checks pass for both candidate databases. The external-content
  FTS integrity check passes, inside a rolled-back transaction.
- All 239 staged records match the successful worker outcomes. Every source EPUB still matches its
  indexed SHA-256. Pandoc 3.1.11.1 and navigation adapter 3 are pinned per book.
- Page indices, character counts, separators, outline bounds, section paths, and passage ownership
  agree. The 64 non-reading auxiliary-cover entries retain explicit null locations.
- Actual `searchCorpus`, `readBook`, `citePassage`, and `verifyPassage` calls pass for every converted
  book. Outline and section-reading checks pass as well. These exercise the tool implementations
  against the private index; they are not a browser test of an activated reader.
- All 330 unstaged books, including all 261 PDFs, retain their snapshot book/content records.
  Candidate primary-data tables match the snapshot, including all five saved anchors. All five
  anchors verify locally and highlight through the deployed quote-mcp feed.
- A source-markup sample checks 93 paragraphs across 12 books, including nine paragraphs with source
  newlines. Ordinary source paragraphs remain single unwrapped locations. Three paragraphs inside
  a blockquote or definition list remain intact within their enclosing compound location. An initial
  check incorrectly required these compound paragraphs to be standalone locations; checking source
  ancestry explained those three failures without changing extraction.

Evidence remains on the server; private book contents were not exported for these checks:

- `validation/report.json`: full structural/API/snapshot checks, completed 04:34 UTC.
- `validation/source-paragraphs-v2.json`: source-markup sample, completed 04:45 UTC.
- `validation/metadata-report-v2.json`: final metadata refresh and integrity check, completed 04:48 UTC.
- `validation/books-before-derived.json`: private rollback record for the refreshed book metadata.
- `code/validate-candidate.mjs` and `code/refresh-candidate-metadata-v2.mjs`: server-side checks.

The structural report predates the metadata refresh and therefore records 239 pending metadata scans.
The later metadata report confirms all 239 were filled and all 330 other book rows stayed identical.

## Metadata correction found during validation

The old scanners sampled the first 20 and last five locations as though they were layout pages.
A disposable preview of that behavior lost existing ISBN candidates in 87 books and effective
citation years in 13. It was not applied to the candidate or production.

`metadataPages` now samples Pandoc books by bounded text volume: the first 60,000 and last 15,000
characters, including whole boundary blocks and retaining actual location numbers. Overlapping
samples prefer the front. PDFs and legacy EPUBs retain their 20/5-page windows. About-author sections
remain eligible for the advisory title-page scan. These are sampling heuristics, not a claim that a
character budget identifies all front matter semantically.

Year selection also needed correction: one physical copyright page becomes several logical blocks.
Pandoc year selection now follows a contiguous named copyright/colophon/imprint section, or at most
6,000 characters of adjacent text in the same unnamed/general section. Gaps and section changes stop
continuation. The physical-page rule remains the default for legacy extraction. A versioned meta key
invalidates only Pandoc-derived caches when the window policy changes; re-extraction is unnecessary.

An atomic metadata-only refresh of the candidate passed these gates:

- No previously recorded ISBN disappeared; 40 books gained ISBN candidates.
- Every existing printed year stayed unchanged; ten books gained printed years, nine usable as a
  citation-year fallback where Calibre has none. The new 2017 year for `main:398` is a publication
  marker alongside its 2016 copyright, consistent with the existing edition-year selection rule.
- All 330 unstaged book rows stayed identical. SQLite's final quick check passes.
- Calibre authors and titles remain unchanged. Advisory author-candidate sets differ: 49 books lose
  at least one candidate and 44 gain one. These candidates are not citation authors and are not
  automatically applied to Calibre; they require review before metadata cleanup. This validation
  does not establish equivalent title-page heuristics across layout pages and logical blocks.

Focused metadata, ISBN/year, title-page, and Pandoc tests pass, along with typecheck and build. No full
software suite, new survey, or full re-extraction was run. The correction is included in PR #21 and
used by the private candidate; production has not received it yet.

## Activation gates

During the initial validation, quote-mcp revision `5af3fb262dca7eb15e0c437a9c9e72bfa21b8d8a` still
applied guessed `reflow` to canonical text. The existing five feeds happened to have `prose === text`,
but synthetic verse, code, and heading/paragraph examples changed. The subsequent consumer deployment
and rehearsal below supersede that deployment finding. The baseline commit alone does not identify
the currently deployed consumer patch.

Deploy the corpus metadata correction before cutover. Reconcile current library/index state and
anchor ownership at cutover, and retain rollback. The observed catalogue drift during the structural
check was `indexed_at` alone in `main:127`, `main:47`, and `main:51`; live primary-data drift was in
`meta`. Do not replace current primary data with the older candidate snapshot.

The four anchored EPUBs (`main:53`, `main:133`, `main:581`, `main:570`) remain unchanged in production.
The subsequent rehearsal below accepts two and defers two, including the book that originally exposed
the paragraph problem. The 62 refused unanchored books retain their original extraction; they do not
require rerunning the 239 successful ones. All reports keep `promotionReady: false`.

## PR #21 review: unset extractor versions

Copilot identified that the controller's `extractor_version <> 3` predicate excluded SQL NULLs.
The queue now explicitly includes unset versions. The controller regression test covers an unset
unanchored version alongside profiles 1/2, holds unset-version books with saved anchors or quotes,
and excludes profile 3, PDFs, and failed books. Outcomes and batch totals account for all eligible
books, and saved data stays unchanged. Both focused worker/controller tests and the controller's
syntax check pass.

A read-only census of the run snapshot, candidate, and live index finds 305 indexed EPUBs and zero
unset extractor versions in each. This defect did not omit books from the completed run; its counts
and validation remain valid, and no re-extraction is needed for this correction.

## Consumer handoff verified, 2026-11-07 UTC

The quote-mcp handoff at `/home/john/Workspace/quote-mcp/docs/dev-briefs/pandoc-quote-text.md` records
the canonical-text deployment and a separate anchored-book rehearsal. This session checked the server
evidence and current deployments read-only; it did not deploy either application or modify quote-mcp.

Quote-mcp's current release is `/opt/quote-mcp/releases/20261107-055331`: production baseline
`5af3fb262dca7eb15e0c437a9c9e72bfa21b8d8a` plus the scoped canonical-text patch. Its four changed
module hashes match the recorded tested build. The deployment record explicitly identifies the dirty
patch and excludes the capture-page and Home Assistant work. Stored text now survives citation and
reader output, with the compatibility `prose` field equal to `text`.

The quote server's `/var/lib/quote-mcp/validation/canonical-text-20261107.json` records 363 isolated
baseline tests, 40 deployed-module assertions, five preserved live feeds, and five preserved live MCP
citations. These counts and preservation flags were checked, and all four current module hashes were
independently matched to that evidence. This closes the earlier canonical-text deployment gate.

The separate corpus inspection pair is at
`/var/lib/corpus-mcp/reextraction/20261106-pandoc-v3/anchored-review-20261107/`.
Its staging report and `consumer-review.json` confirm:

| Book | Quote | Rehearsal outcome |
| --- | --- | --- |
| `main:53` | 831 | Staged with Pandoc 3.1.11.1/adapter 3; 231 old locations become 2,674; anchor starts at index 756 instead of 154. |
| `main:581` | 829 | Staged with the same pins; 75 old locations become 534; anchor starts at index 126 instead of 21. |
| `main:133` | 830 | Deferred: a navigation target is outside the linear XHTML spine. |
| `main:570` | 832 | Deferred: a Pandoc invocation reached its two-minute timeout. |

For the two staged books, stored quote text equals both the old and new anchor text. Only anchor
metadata must migrate; no `quotes.text` rewrite is necessary. The quote server's
`/var/lib/quote-mcp/validation/anchored-consumer-rehearsal-20261107.json` confirms that metadata
migrates while text stays intact, and the rollback log reset replays old locations. The corpus report
records no errors and exercises suppression of stale reader highlights and restoration after replay.
The orphan/found rehearsal preserves quote 832's editorial text as well.

These are implementation/API rehearsals, not a browser visual test. Known-page verification passes;
the initial unhinted saved-passage probes failed. Unhinted whole-book discovery has not been validated
by this rehearsal and must not be represented as passing.

The possible rollout is now **241 accepted books** (239 unanchored plus these two), retaining 64 on
their existing extraction (62 unanchored refusals plus two anchored deferrals). The accepted anchored
pair is separate from the 239-book candidate. Assemble the cutover from fresh live state and explicitly
select accepted book content and anchor changes; neither older data snapshot may replace current
primary data. Recheck current files and saved-anchor ownership for every selected book, deploy the
corpus metadata correction, and perform live consumer-feed and rollback checks at cutover. New live
changes may alter that selection. Corpus still serves all 305 indexed EPUBs on profile 1; no activation
or live quote/anchor migration was performed by this handoff review.
