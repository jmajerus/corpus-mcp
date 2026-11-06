# Pandoc EPUB extraction

Pandoc is the preferred EPUB re-extraction backend. It replaces source/CSS interpretation and
MuPDF location reconciliation for new candidates. Production activation still goes through staged
index/data snapshots; a normal refresh does not change an existing book's extraction profile.

## Runtime and document model

Install [Pandoc](https://pandoc.org/installing.html) **3.1 or later** on the indexing host and in
development/test environments. The integration is exercised locally with 3.1.3 and on Debian 13
with 3.1.11.1. `CORPUS_PANDOC_PATH` may
name an alternative executable; it is an executable path, not a shell command. Provisioning does
not install or upgrade Pandoc automatically. The ordinary server can serve an already-built index
without invoking Pandoc.

`extractBook(bytes, "epub", { epubParagraphs: "pandoc" })` invokes Pandoc with an explicit EPUB
reader, `--sandbox`, and a bundled-in-code Lua writer adapter. The adapter delegates text generation
to Pandoc's plain writer with wrapping disabled. A navigation adapter reads package/TOC metadata
and target identifiers, without interpreting CSS, guessing paragraphs, or invoking MuPDF.
Each Pandoc invocation has a two-minute timeout and a 128 MiB output limit; temporary
input/writer files are private and removed after success or failure. Errors do not fall back to
another extraction engine. Pandoc warnings are included in conversion and staging reports.

Each nonempty Pandoc block becomes one zero-based reading location. Structural `Div` containers
are traversed; compound blocks (lists, tables, block quotes) remain intact. The EPUB's TOC navigation
or NCX establishes outline titles, nesting, and section paths. Body headings do not replace it.
Locations are separated by two newlines; their contents are Pandoc's
plain output, including explicit line breaks, list markers, code indentation, and rendered notes.
These are logical block locations, not printed pages, EPUB CFIs, or MuPDF's old artificial pages.
Empty/image-only blocks with no readable text do not create locations.

`extractPandocEpub` also returns the complete Pandoc JSON AST as `document`. It retains inline
formatting and notes and can be fed to other Pandoc writers for future quote/document output. The
index currently stores searchable/readable text, not this AST. Formatting quotes, resolving
bibliographies, and adding a citation processor remain separate features.

This is semantic conversion, not an exact rendering of publisher CSS. Hidden text, complex tables,
image-only material, and unusual markup need content inspection. Notes are serialized by Pandoc per
location; their plain-text numbering is local to that block. Successful conversion alone is not a
fidelity verdict.

## Navigation and targeted preprocessing

The adapter selects the package-declared navigation document's `toc` tree, falling back to the
spine's NCX `navMap`. Page lists and landmarks are excluded. Unlinked TOC groups inherit their first
reading child's location. Every primary linked target must resolve; an incomplete chapter outline
is never returned.

Adapter revision 3 retains positively identified non-linear covers as non-reading TOC entries
with `startPage: null`. Confirmation requires a package guide cover declaration, body cover
semantics, or an image-only body whose images match the package-declared cover asset. The target
document must exist; any linked fragment must still be unique and present. A cover label or filename
alone is insufficient. This exception does not apply to primary reading documents or unidentified
auxiliary material. Cover evidence is returned in `auxiliaryCovers`, included in validation/staging
reports, and persisted in index metadata (`pandoc_auxiliary_covers:<book-id>`). No primary-text
location is invented for the cover, and it does not override chapter section paths.

Empty spine-file markers are retained for mapping but never emitted as reading locations. A file
target maps to the first readable location in that same file. An in-content identifier maps to the
location containing it, including identifiers nested inside a list, table, or block quote. Div and
section identifiers map to their first readable descendant. Empty files, empty target containers,
duplicate identifiers/basenames, non-cover targets outside the linear XHTML spine, and misplaced or unresolved
anchors defer the entire book. URI paths and fragments are resolved relative to their actual source
documents; basename matching is used only for Pandoc's corresponding AST identifiers.

Only a navigation fragment demonstrably missing from Pandoc's AST is eligible for preprocessing.
The source must contain exactly one matching ID or named anchor. A temporary copy relocates that
identifier onto a retained span or structural wrapper, using valid placement for the element.
Retained targets, including ordinary `pre` IDs, are untouched. Original library bytes and their
SHA-256 remain unchanged.

Each target rewrite is converted separately. It must recover a unique anchor in the correct file
and preserve the complete ordered array of readable block texts and heading kinds before the next
rewrite is attempted. This verifies both text and reading-location boundaries and prevents two
changes from masking each other. Any failed check defers the complete book. The returned rich AST
is captured before plain-text serialization can normalize empty containers.

## Profiles and migration

- Version 1: legacy MuPDF extraction; still the normal indexing default pending cutover validation.
- Version 2: the earlier source-to-MuPDF mapper, retained for existing staged profiles and historical
  rehearsals. No new CSS/layout reconstruction is needed for Pandoc candidates.
- Version 3: Pandoc blocks. The exact Pandoc version is pinned per book in index metadata
  (`pandoc:<book-id>`). Ordinary/forced refresh retains this profile. A different or missing version
  refuses extraction and retains the existing book text; upgrades require staged migration.
  Navigation adapter revision 3 is also pinned (`pandoc_adapter:<book-id>`). Candidates made with
  earlier adapters must be restaged before a forced refresh can use this revision.

```sh
npm run build
node tools/validate-epub-extraction.mjs --backend pandoc /path/to/book.epub
node tools/stage-epub-reextraction.mjs \
  --index snapshot/corpus.db --data snapshot/data.db \
  --books-root /path/to/books --output /tmp/new-pandoc-candidate \
  --book main:570
```

Both tools default to Pandoc; `--backend source` explicitly selects the earlier version-2 backend.
For a whole-library conversion survey that continues after individual failures:

```sh
node tools/validate-epub-library.mjs \
  --index /var/lib/corpus-mcp/corpus.db --books-root /srv/corpus/books \
  --output /var/lib/corpus-mcp/validation/new-survey
```

The output directory must be new. `summary.json` records progress; `books.jsonl` records each result.
Results include `pandocWarnings` when Pandoc emits a diagnostic, so it can be reviewed on the host.
Workers run sequentially in separate processes, so each book releases its extraction memory before
the next starts. The tool opens the index read-only and leaves books and anchors untouched. When
running a copied survey script on an indexing host, `--extractor /release/dist/extract.js` selects
the installed backend and its dependencies. Run it under resource limits appropriate to that host.
This is a conversion survey, not an anchor migration or a coordinated cutover snapshot.
Its 150-second worker limit covers the whole book, including any additional target-check passes;
resource/time failures remain failed records for review, not accepted conversions.

If a book has an existing outline and Pandoc produces none, both the survey and staging defer that
book; staging retains its complete previous index and anchors. Unresolved or ambiguous individual
TOC targets also defer the book, even when other entries resolve. The empty-outline guard remains
a backstop for a missing navigation document; successful mapping does not establish other semantic
fidelity properties. A single deferred
book does not block validation or eventual selective activation of accepted books.

The validator reports `converted`, location counts, outline changes, warnings, and the writer
version. Changed locations are expected. It writes no databases or library files.

Staging copies the snapshot pair and replaces selected books' pages, outline, FTS passages, counts,
and extraction profile only in the copies. File hashes must match. Old anchors are first checked
against their exact stored ranges. A quote migrates only if its normalized wording occurs exactly
once in the new book. Ambiguous or missing wording, stale offsets, and duplicate indexed UUIDs
retain the complete old book and require review. Repeated wording is deliberately not resolved by
guessing from its old page number. Orphaned records retain their existing status.

Corpus anchor replacements are verified and emitted through the existing change feed. Saved corpus
quotes also receive new location and section metadata. Every candidate reports `promotionReady:
false`; this tool neither promotes snapshots nor changes live services.

## Activation requirements

The original heading-only adapter with Pandoc 3.1.3 converted all ten EPUB samples, including the five refused by the
version-2 source/layout mapper. The original Conrad regression is one 677-character source
paragraph and one candidate location, equal after whitespace normalization. Conrad has 39,185
Pandoc block locations rather than 7,447 MuPDF locations.

The earlier heading-only private snapshot rehearsal staged all four EPUBs with real saved anchors: Grimm,
Suspicious Minds, Conrad, and Fidelity. All four anchors remapped and passed corpus verification.
The original snapshot books retained profile 1. This includes Suspicious Minds, previously refused
by version 2. No production databases, files, services, or external quote records were changed.

The original full-library conversion survey completed 306 records: 233 converted, 70 deferred for
complete outline loss, and three failed. Those results belong to the heading-only adapter and do
not establish navigation-adapter readiness.

Navigation revision 2 passed 271 local tests across 17 files. Ten synthetic server checks passed with
Debian's Pandoc 3.1.11.1, covering retained/recovered targets and whole-book deferrals. The actual
Rousseau EPUB (`main:94`), previously missing all headings, now retains all 12 navigation entries
with titles/nesting matching the legacy outline. Its source file and active profile remain unchanged.

Before cutover, inspect semantic fidelity on representative books, stage against complete coordinated
snapshots, verify the real quote consumer's canonical prose handling and highlighting, and rehearse
paired rollback while writes remain quiesced. Previous version-2 feed rehearsals do not establish
version-3 consumer readiness. The ten-book development mirror and existing saved-anchor subset are
useful regressions, not full deployed-library coverage.
