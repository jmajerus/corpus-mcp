# Pandoc EPUB extraction

Pandoc is the preferred EPUB re-extraction backend. It replaces source/CSS interpretation and
MuPDF location reconciliation for new candidates. Production activation still goes through staged
index/data snapshots; a normal refresh does not change an existing book's extraction profile.

## Runtime and document model

Install [Pandoc](https://pandoc.org/installing.html) **3.1 or later** on the indexing host and in
development/test environments. The integration is exercised with 3.1.3. `CORPUS_PANDOC_PATH` may
name an alternative executable; it is an executable path, not a shell command. Provisioning does
not install or upgrade Pandoc automatically. The ordinary server can serve an already-built index
without invoking Pandoc.

`extractBook(bytes, "epub", { epubParagraphs: "pandoc" })` invokes Pandoc with an explicit EPUB
reader, `--sandbox`, and a bundled-in-code Lua writer adapter. The adapter delegates text generation
to Pandoc's plain writer with wrapping disabled. It does not parse XHTML, interpret CSS, guess
paragraphs, or invoke MuPDF. Execution has a two-minute timeout and a 128 MiB output limit; temporary
input/writer files are private and removed after success or failure. Errors do not fall back to
another extraction engine. Pandoc warnings are included in conversion and staging reports.

Each nonempty Pandoc block becomes one zero-based reading location. Structural `Div` containers
are traversed; compound blocks (lists, tables, block quotes) remain intact. Heading blocks establish
the outline and section paths. Locations are separated by two newlines; their contents are Pandoc's
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

## Profiles and migration

- Version 1: legacy MuPDF extraction; still the normal indexing default pending cutover validation.
- Version 2: the earlier source-to-MuPDF mapper, retained for existing staged profiles and historical
  rehearsals. No new CSS/layout reconstruction is needed for Pandoc candidates.
- Version 3: Pandoc blocks. The exact Pandoc version is pinned per book in index metadata
  (`pandoc:<book-id>`). Ordinary/forced refresh retains this profile. A different or missing version
  refuses extraction and retains the existing book text; upgrades require staged migration.

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
Workers run sequentially in separate processes, so each book releases its extraction memory before
the next starts. The tool opens the index read-only and leaves books and anchors untouched. When
running a copied survey script on an indexing host, `--extractor /release/dist/extract.js` selects
the installed backend and its dependencies. Run it under resource limits appropriate to that host.
This is a conversion survey, not an anchor migration or a coordinated cutover snapshot.

If a book has an existing outline and Pandoc produces none, both the survey and staging defer that
book; staging retains its complete previous index and anchors. Other books continue. This catches
complete navigation loss, not partial outline loss or other fidelity problems. A single deferred
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

Local validation with Pandoc 3.1.3 converted all ten EPUB samples, including the five refused by the
version-2 source/layout mapper. The original Conrad regression is one 677-character source
paragraph and one candidate location, equal after whitespace normalization. Conrad has 39,185
Pandoc block locations rather than 7,447 MuPDF locations.

The existing private snapshot rehearsal staged all four EPUBs with real saved anchors: Grimm,
Suspicious Minds, Conrad, and Fidelity. All four anchors remapped and passed corpus verification.
The original snapshot books retained profile 1. This includes Suspicious Minds, previously refused
by version 2. No production databases, files, services, or external quote records were changed.

Before cutover, inspect semantic fidelity on representative books, stage against complete coordinated
snapshots, verify the real quote consumer's canonical prose handling and highlighting, and rehearse
paired rollback while writes remain quiesced. Previous version-2 feed rehearsals do not establish
version-3 consumer readiness. The ten-book development mirror and existing saved-anchor subset are
useful regressions, not full deployed-library coverage.
