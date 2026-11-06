# EPUB source paragraph extraction preview

Status: extraction validation and migration rehearsal, **not enabled for active indexing**. The provisional reader
reflow patch has been withdrawn. The reader again displays stored text directly.

## Cause and implementation

The legacy extractor treats each MuPDF layout text block as a paragraph, then the indexer inserts
two newlines between blocks. In the Conrad volume, MuPDF sometimes emits one block per visual line
and sometimes groups multiple source paragraphs in a block. Neither direction preserves paragraphs.

`extractBook(data, "epub", { epubParagraphs: "source" })` opts into the preview. It reads the EPUB
container, OPF manifest and spine, and the ordered XHTML source. Structural elements establish
paragraph boundaries; inline markup and empty anchors do not. Explicit `br` breaks and `pre`
whitespace survive. A limited CSS cascade handles linked/embedded styles, relative imports, selector
specificity, inline styles, `!important`, inheritance, display, whitespace, and list styles. Only
stylesheets used by the document are loaded. Default nested-list labels are retained. XHTML is parsed as XML, including self-closing
elements such as `title` and `a`; treating those files as HTML can swallow real body content.

MuPDF still determines the locations using the existing layout dimensions and original, unmodified
EPUB. Each spine document is resolved to its existing location range. The complete source character
stream must match the complete rendered stream in order. Comparison removes whitespace and soft
hyphens and applies Unicode NFKC normalization; output retains source spelling and intentional line
breaks. Only CSS document whitespace collapses; non-breaking spaces remain intact. Significant
whitespace gaps must also survive in the raw rendered stream. Gaps spanning locations and
whitespace-only preserved blocks are conservatively refused. Normal and preserved inline runs trim
their own edges independently. Mapping uses grapheme boundaries so ligatures/combining sequences cannot be split between
locations. Paragraphs spanning locations become fragments of the same source paragraph. The existing
page-string storage contract is retained; persisting source paragraph identities is future work.

Mismatch, missing resources, ambiguous spine mapping, and unsupported source semantics raise explicit
errors. The preview never guesses paragraph boundaries from punctuation and never silently falls
back to layout blocks. It handles MuPDF's literal `[image]` SVG fallback only when character alignment
confirms the renderer produced it. It does not extract diagram content.

## Reproduce validation without changing an index

```sh
npm run build
node tools/validate-epub-extraction.mjs '/path/to/book.epub'
```

The command reads the supplied files, compares legacy and preview extraction, and prints JSON. It
opens no database and writes no library files. A refusal or changed location/outline mapping produces
a nonzero exit status. `tests/epub.test.ts` exercises line-per-block and merged-block layouts, real
paragraphs without terminal punctuation, inline markup, headings, lists, explicit verse breaks,
preformatted indentation, source spelling, spine order, and paragraphs spanning locations.

Initial character-only validation of *Complete Works of Joseph Conrad* (main library, book 37),
before review added significant-whitespace checks:

| Measure | Result |
| --- | ---: |
| Reading locations | 7,447, unchanged |
| Outline mapping | Unchanged |
| Locations with corrected text/structure | 5,677 |
| Legacy paragraph fragments | 101,801 |
| Source paragraph fragments | 43,782 |

Every location passed character alignment in that initial run. The original *Chance* passage at
location 3,124 followed its XHTML paragraphs, with continuation into location 3,125. That run did not
validate significant-whitespace ownership across locations; the current preview refuses the volume
on that stricter check. It does not establish coverage across the library.

## Broader validation

All 10 EPUB files in the local `main` mirror were tested. This mirror is a subset of the deployed
library, not a complete inventory of the server. After the review fixes, three books pass, covering
461 locations with unchanged location and outline mappings. The earlier five-book result only checked
character alignment and has been superseded:

| Local book | Result |
| --- | --- |
| Quick Start Guide | Refused: whitespace-only preserved content has no unambiguous location mapping |
| Carceral Humanitarianism | Passed, 74 locations |
| Wounded By Reality | Passed, 186 locations |
| If I Must Die | Passed, 201 locations |
| Complete Works of Joseph Conrad | Refused: significant whitespace crosses locations in `Ops/419.html`, location 4,035 |
| Conversation with ChatGPT | Refused: remote CSS dependency |
| The Swift Programming Language | Refused: malformed CSS (missing semicolon in page-break declarations) |
| Mastering Node.js | Refused: whitespace-only preserved content; the earlier run also found a credits-table mismatch |
| Applied Deep Learning with Keras | Refused: significant whitespace crosses locations; the earlier run also found omitted code characters |
| Hands-On Internet of Things with MQTT | Refused: significant whitespace crosses locations; the earlier run also found list-number disagreement |

Policy: a refusal retains the complete existing book, rather than mixing source and layout extraction
within a book. There is no silent fallback. Unresolved verified anchors also retain the entire book.

The same local catalogue selects 10 EPUBs, 27 PDFs, and 24 MOBIs under current format preference. Its
two AZW3 files are not preferred for any book. MOBI/AZW3 use the same layout-block assumption but need
a separate source-decoding path and validation; an EPUB converter alone does not prove old locations
remain stable. PDFs need tagged-source support or layout-based paragraph reconstruction validated
against representative pages. The EPUB preview changes neither format's extraction. Promotion must
use format/profile-specific versions, not force a global re-extraction of all formats.

## Staged index and anchor migration

```sh
npm run build
node tools/stage-epub-reextraction.mjs \
  --index snapshot/corpus.db --data snapshot/data.db \
  --books-root /path/to/books --output /tmp/new-candidate \
  --book main:25 --book main:35
```

The output must be a new directory. Both inputs open read-only and are backed up into the output.
Extraction, passage rebuilding, anchor changes, and reports affect only those copies. A mirror path
can be supplied as `--file 'main:35=/path/to/mirror.epub'`; its SHA-256 must still match the indexed file.

The mapper verifies the old anchor against old page text, then requires equal normalized old/new
character streams for every covered location. Shared quote normalization maps complete graphemes,
including exclusive end offsets for combining sequences, ligatures, and supplementary characters. Offsets map by stream position, preserving a chosen
occurrence of repeated wording. Stale anchors, changed characters, or missing locations require
review. It does not find the first matching phrase and assume that is the right occurrence. Existing
orphaned records remain orphaned. Ambiguous indexed copies with verified anchors are refused.

Accepted books get corrected page strings, rebuilt passages/FTS entries, and a candidate extractor
version of 2. Character counts use SQLite `LENGTH` semantics, including supplementary Unicode characters. Derived
text metadata versions are invalidated for recomputation before promotion.
Only migrated verified quotes use source prose; orphaned legacy quotes and their contexts retain
compatibility reflow. An explicit write-phase flag makes any staging write failure invalidate the
candidate, independently of the snapshot's extractor version. Local quotes adopt the source wording
and paragraphs; corpus-owned anchors are reverified and emit
`replaced` feed events, which quote-mcp already consumes. Source-extracted quote prose and context
bypass the legacy punctuation reflow heuristic. For source-extracted books, reader highlights must
also match the local verified anchor (optional remote text is checked only when supplied); equal
file SHA alone cannot establish freshness while quote-mcp is catching up. Lost anchors are not highlighted.

The existing ordinary reanchor routines still skip unchanged file hashes. The staged workflow
explicitly performs migration rather than relying on those routines. A controlled migration and
extractor-profile identity must be integrated before enabling ordinary source extraction.

Rehearsal against read-only, consistent SQLite snapshots of matching deployed records rebuilt
`main:25`, `main:35`, `main:41`, and `main:136` (a second copy of Carceral Humanitarianism). Their 535
locations retained their mappings; after review, 180 page strings change (including retained
non-breaking spaces). These records had **no saved local or
quote-mcp anchors** attached. Same-file offset changes, repeated wording, cross-location anchors,
feed updates, stale-reader suppression, refused books, and immutable inputs were tested with fixtures.
This rehearsal does not establish successful migration of real saved quotes on other books.

The rehearsal artifacts (`report.json`, `corpus.db`, and `data.db`) were kept locally and excluded
from version control. They contain a selected inspection subset of the deployed databases and must
never replace the full live database. The report always says `promotionReady: false`.
The server was read only; no services, files, or quotes were changed there.

## Remaining promotion requirements

- Preview support is for EPUB XHTML. PDF, MOBI, and AZW3 keep their existing extraction paths.
- The CSS cascade covers ordinary author rules, not every CSS feature. Matched conditional rules,
  unsupported display/whitespace/list values, semantic selectors the matcher cannot compile, invalid
  CSS, and external stylesheets are refused. Character equality alone cannot prove that whitespace
  semantics survived. Source/layout disagreement always remains a refusal.
- The preview expects UTF-8 XHTML and an unambiguous spine-to-location mapping. Fixed-layout,
  non-XHTML spine resources, duplicate spine resources, and unusual encodings need separate coverage.
- `EXTRACTOR_VERSION` remains 1 and the indexer does not pass the preview option. Deploying this code
  does not opt existing indexing jobs into the new extractor.
- Resolve or explicitly defer the seven current refusals; extend coverage beyond the local mirror, especially
  books with real saved anchors. Do not treat the subset candidate as a replacement index.
- Prepare format/profile-specific indexing and freshness identity so subsequent scans retain source
  extraction for accepted books and legacy extraction for deferred books. The global version stays 1.
- Recompute derived text metadata in the complete candidate, and test paired index/data rollback.
- For final capture, quiesce indexing and quote writes long enough to take a coordinated pair of full
  snapshots. The read-only rehearsal snapshots were taken separately and are not a cutover checkpoint.
- Apply migrations in that candidate, verify quote-mcp consumes the feed (and preserves canonical
  source paragraph breaks in its own prose rendering), compare complete results, then perform a
  controlled cutover with the original pair retained. Publishing and deployment remain separate work.
