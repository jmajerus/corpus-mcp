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

The deployed quote-mcp revision is `5af3fb262dca7eb15e0c437a9c9e72bfa21b8d8a`. Its corpus API and
citation queries still apply guessed `reflow` to canonical text. All five existing feed samples happen
to have `prose === text`, but that does not prove preservation for new captures: the deployed function
changes synthetic verse, code, and a heading followed by a paragraph. The quote-mcp working tree has
other edits and was not modified or deployed during validation. Coordinate its canonical-text change
and consumer validation before activating these EPUBs.

Deploy the corpus metadata correction before cutover. Reconcile current library/index state and
anchor ownership at cutover, and retain rollback. The observed catalogue drift during the structural
check was `indexed_at` alone in `main:127`, `main:47`, and `main:51`; live primary-data drift was in
`meta`. Do not replace current primary data with the older candidate snapshot.

The four anchored EPUBs (`main:53`, `main:133`, `main:581`, `main:570`) still require separately reviewed
anchor/quote migration. This includes the book that originally exposed the paragraph problem. The 62
refused books retain their original extraction; they do not require rerunning the 239 successful ones.
All reports keep `promotionReady: false`.
