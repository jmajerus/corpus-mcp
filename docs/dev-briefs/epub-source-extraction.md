# EPUB source extraction and cutover rehearsal

Status: implemented and validated in local candidates; production indexing and services have not
been changed. Source extraction remains an explicit opt-in. Candidates and rollback bundles always
report `promotionReady: false`.

## Source structure and location mapping

The legacy extractor treats MuPDF layout blocks as paragraphs. MuPDF can split a source paragraph
into visual-line blocks, or combine multiple paragraphs into one block. The indexer then persists
incorrect paragraph breaks. The source EPUB need not contain hard returns at those positions.

`extractBook(data, "epub", { epubParagraphs: "source" })` reads the container, OPF spine, and XHTML.
Structural elements establish paragraphs; inline markup and empty anchors do not. A limited CSS
cascade handles linked/embedded styles, relative imports, selector specificity, inline styles,
`!important`, inheritance, display, whitespace, and list styles. XHTML is parsed as XML, including
self-closing `title` and `a` elements. Only CSS document whitespace collapses; NBSP and other Unicode
spaces retain their semantics. Ordinary and preserved inline runs trim their own edges independently.

MuPDF lays out the original, unmodified EPUB using the existing dimensions. Each spine document
maps to its original location range. The complete source and rendered character streams must match
in order after NFKC normalization and removal of layout whitespace and discretionary soft hyphens.
Grapheme boundaries prevent a source combining sequence or ligature expansion from spanning locations.

Significant whitespace is checked separately against raw rendered text. For every source gap, the
mapper finds the earliest and latest valid ordered matches, without inserting synthetic page
separators. A source whitespace character gets a location only when those bounding matches agree on
its owner. Duplicate generated newlines within one location are acceptable; competing locations or
missing whitespace cause a refusal. This permits an explicit verse break at one location's end and
indentation in the next, including whitespace-only source blocks when their ownership is provable.

The mapper partitions source text by those proven character locations and checks complete source
coverage. It never infers paragraphs from punctuation, skips unmatched text, or silently falls back
to layout blocks. Inline SVG uses MuPDF's literal `[image]` fallback only when alignment confirms it;
diagram content is not extracted.

## Exact separators and profile persistence

Index schema 7 adds nullable `pages.separator_before`. Source pages store the exact source separator:
space for a wrapped prose boundary, two newlines between paragraphs, or an empty string when the
separator is already part of a page or a word continues across locations. Legacy rows retain null
and their existing newline-join behavior. The reader API exposes this field.

Quote lookup, verification, and staged migration use the same separator-aware assembly. This avoids
inserting a newline into prose, duplicating a verse break, or breaking a word at a location boundary.
Shared quote normalization maps whole graphemes with exclusive end offsets. Schema-6 migration is
additive, is exercised on staging copies, and leaves the original snapshots unchanged.

New books and deferred books continue to use extractor version 1. Explicitly staged/promoted EPUBs
use version 2; ordinary and forced refreshes retain that source profile and its exact separators.
Other formats retain their legacy extractor. A source extraction failure is never retried with the
legacy extractor as a fallback. Ordinary refresh also recomputes the derived text metadata that
staging invalidates. The global default remains 1.

## Read-only validation

```sh
npm run build
node tools/validate-epub-extraction.mjs '/path/to/book.epub'
```

The command opens no database and writes no library files. It compares location and outline
mappings and prints JSON; a refusal or changed mapping produces a nonzero exit status.

All 10 EPUBs in the local `main` mirror were tested. The mirror is a subset of the deployed library.
Five now pass, covering 7,929 unchanged locations:

| Local book | Result |
| --- | --- |
| Quick Start Guide | Passed, 21 locations |
| Carceral Humanitarianism | Passed, 74 locations |
| Wounded By Reality | Passed, 186 locations |
| If I Must Die | Passed, 201 locations |
| Complete Works of Joseph Conrad | Passed, 7,447 locations |
| Conversation with ChatGPT | Refused: remote CSS dependency |
| The Swift Programming Language | Refused: malformed CSS |
| Mastering Node.js | Refused: significant whitespace absent from rendered layout |
| Applied Deep Learning with Keras | Refused: source/layout character mismatch in code |
| Hands-On Internet of Things with MQTT | Refused: source/rendered list-number disagreement |

The Conrad volume now passes both character and significant-whitespace checks across all locations.
Its outline and location numbering are unchanged. The candidate changes 5,898 page strings and uses
43,782 source paragraph fragments, versus 101,801 legacy layout-block fragments. Exact source
separators preserve the verse break spanning locations 4,035–4,036; the original *Chance* passage at
locations 3,124–3,125 follows its XHTML paragraphs.

The local catalogue prefers 10 EPUBs, 27 PDFs, and 24 MOBIs; neither AZW3 file is preferred. PDF and
MOBI/AZW3 source reconstruction remain separate work. This preview changes neither format's text.

## Staged rebuilding and real saved anchors

```sh
node tools/stage-epub-reextraction.mjs \
  --index snapshot/corpus.db --data snapshot/data.db \
  --books-root /path/to/books --output /tmp/new-candidate \
  --book main:570
```

The output must be a new private directory. Both databases open read-only and are backed up into it.
Only the copies receive corrected pages, separators, passages/FTS entries, metadata invalidation,
and anchor changes. `--file 'main:570=/path/to/mirror.epub'` permits a mirror-path override, but its
SHA-256 must match the indexed file. An extraction refusal or unmappable verified anchor retains
the complete existing book. Existing orphaned records remain orphaned. Write failures invalidate
the candidate, independently of its extractor-version metadata.

Anchors map by normalized character-stream position after their old offsets and wording have been
verified, preserving the selected occurrence of repeated wording. Changed characters, stale offsets,
missing locations, or ambiguous indexed copies require review. Per-location trailing whitespace
may change; exact source separators determine the new range text. Character counts use SQLite
`LENGTH` semantics. Verified source quote prose bypasses compatibility reflow; orphan prose and
context retain it. Corpus-owned anchors are reverified and emit replacement feed events.

Read-only server snapshots and exact source files were copied locally for four EPUBs with genuine
saved quote-mcp anchors:

| Deployed book | Candidate result | Saved anchor |
| --- | --- | --- |
| The Complete Brothers Grimm's Fairy Tales (`main:133`) | Staged, 602 stable locations, 114 changed pages | Unchanged and verified |
| Complete Works of Joseph Conrad (`main:570`) | Staged, 7,447 stable locations, 5,898 changed pages | Remapped and verified |
| Fidelity (`main:581`) | Staged, 75 stable locations, 25 changed pages | Unchanged and verified |
| Suspicious Minds (`main:53`) | Refused at location 169 for source/layout mismatch | Original book and anchor retained |

All three accepted anchors were checked against candidate page slices, exact source separators,
original normalized wording, and unchanged file hashes. These are real saved anchor records, not
invented quotations. No server files, active databases, services, or quote-mcp records were changed.
Artifacts contain an inspection subset, stay outside version control, and must not replace a full
live index.

## Consumer replay and rollback

The unmodified quote-mcp `followAnchors` function was run against an isolated consumer database
seeded with the real anchor payloads. It consumed the staged feed, updated the remapped anchor once,
and lost none. A second pass read no changes. A rollback rehearsal reset the feed generation,
replayed the five original events, restored the old anchor, and lost none. This verifies feed/cache
behavior; it does not claim a live quote-mcp database migration or a fix to its prose formatter.

```sh
node tools/prepare-epub-rollback.mjs \
  --index snapshot/corpus.db --data snapshot/data.db --output /tmp/new-rollback-pair
```

This makes private copies, performs the additive index migration, and rotates `anchor_log` only in
the rollback copy. Consumers must replay restored anchors rather than retain a cursor newer than
the restored log. Known local anchors are authoritative for reader highlighting on both source and
legacy pages, hiding stale same-SHA offsets during forward or rollback synchronization. Optional
remote text is compared only when supplied.

Rollback requires quote/index writes to remain quiesced through the validation window. Once writes
have resumed, restoring an older primary-data snapshot would discard new records; use a separate
recovery plan instead. Readers must see a consistent pair, and the consumer must catch up before
reopening the cutover window. Rollback preparation never swaps databases or restarts services.

## Remaining cutover work

- Resolve or explicitly defer the five local refusals and the real anchored Suspicious Minds volume.
  Additional books outside the tested mirror still need validation.
- Coordinate quote-mcp's canonical-source prose behavior before enabling new source-backed saves.
  Its current compatibility reflow can erase intentional source breaks. A companion change needs
  explicit source-text provenance on anchors and must prefer canonical anchor text for that profile,
  while retaining compatibility behavior for legacy or orphaned text. Feed transport alone is ready.
- Quiesce indexing and quote writes for a coordinated pair of complete snapshots. The rehearsal
  subsets and separately captured snapshots are not a cutover checkpoint.
- Stage selected validated books against the full snapshots, retaining deferred books. Refresh the
  candidate using the server's exact library/filter/citekey configuration with only the database
  paths overridden; this recomputes derived metadata without downgrading source-profile books.
- Compare complete search/outline/quote results, verify consumer synchronization and prose, and
  rehearse the prepared paired rollback before switching service paths. Deployment, publishing,
  restarting services, and live re-extraction have not been performed.
