# corpus-mcp

An [MCP](https://modelcontextprotocol.io/) server that lets an AI agent search,
read, and cite the books in a [Calibre](https://calibre-ebook.com/) library.

It indexes PDF, EPUB, and MOBI files into a SQLite full-text index. An agent
can then find a passage, read it in context, and get a citation with a real
locator: the printed page number for a PDF, or the chapter for a reflowable
book.

It was built to supply book citations for
[Concept Clusters](https://github.com/jmajerus/concept-clusters) puzzle
authoring. It complements a [Zotero MCP server](https://github.com/54yyyu/zotero-mcp):
Zotero handles papers and their attachments, and corpus-mcp handles the long-form
books that live in Calibre.

## Tools

| Tool | What it does |
|---|---|
| `search_corpus` | Full-text search (SQLite FTS5, BM25 ranking) over every indexed book. Returns ranked snippets with book, page, printed page label, and section. Supports phrases, prefixes, and filters by book, library, or author. |
| `list_books` | Looks up books by title, author, tag, publisher, ISBN, citekey, or shelf. |
| `list_tags` | Lists Calibre tags (Calibre-Web's *Categories*) as a tree; `.` nests them, and any tag filters `search_corpus` and `list_books` together with the tags below it. |
| `list_shelves` | Lists Calibre-Web's public shelves (topic collections) with book counts; any shelf name can filter `search_corpus` and `list_books`. |
| `get_book_outline` | Returns metadata and the table of contents with the page where each section starts. |
| `read_book` | Returns contiguous text for a page range or a named section, within a character budget, and says where to continue. |
| `render_page` | Returns a PNG of a PDF page, for figures, tables, and equations. |
| `cite_passage` | A book's citation as a CSL JSON item, with a CSL locator for a page range, the reading position, and filing data: a BibTeX entry, a valid ISBN, or printed ISBN candidates (see *Citations*). |
| `pin_citekey` | Records the citekey a book was given elsewhere, such as in the reference manager it was filed in. |
| `get_tag_vocabulary` | The vocabulary's terms as Calibre tags, the controlled vocabulary for categories. |
| `tagging_worklist` | Books still without a tag proposal, with the context needed to choose tags. |
| `propose_tags` | Proposes 1–3 vocabulary tags for a book, for a person to review. |
| `save_quote` | Saves a passage as a quote after checking it against the book; the book's exact wording is stored. |
| `search_quotes`, `get_quote`, `update_quote`, `delete_quote` | Find, read, and edit saved quotes (note, tags). |
| `cite_quote` | A quote's verified text and locator with its citation object. |
| `corpus_status` | Reports index freshness, counts, books that failed, have no text layer, or have no outline, and which books are ready for a citekey. |

The citekey, tag-proposal, and quote tools write to corpus-mcp's own data; corpus-mcp never writes to Calibre itself.

## Categories

Calibre tags (Calibre-Web's *Categories*) follow a controlled vocabulary that
the taxonomy's owner supplies as a JSON file (format below). Here that owner is
[Concept Clusters](https://github.com/jmajerus/concept-clusters); any project can
supply its own. Term ids are the tags, nested with `.` such as
`social-sciences.psychology.social-psychology`, so a renamed term leaves
Calibre's tags valid. Tools and the review page show the titles
("Social Sciences › Psychology › Social Psychology") and accept either form. An agent takes
books from `tagging_worklist` and calls `propose_tags`. A person approves,
edits, or rejects each proposal at `/admin/proposals`, or sets a book's categories directly on its page. Then
`npm run tags:apply -- --apply` runs [`tools/calibre-tags.sh`](tools/calibre-tags.sh)
on the Calibre-Web host. That script backs up `metadata.db` and adds the
approved tags with `calibredb`, keeping each book's existing tags.

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
- A retired term with one replacement is re-tagged by the tags job; one that
  was split or dropped waits for a person.
- The server reads `/var/lib/corpus-mcp/vocabulary.json` (`CORPUS_VOCABULARY`)
  and reloads it when it changes; an invalid file is reported and the last good
  one stays in use. `npm run deploy -- --vocabulary=<file>` validates and
  installs one.
- `vocabulary_report` (and the categories page) lists retired terms still in
  Calibre, tags shaped like terms that the vocabulary lacks, and books tagged
  only at a term with narrower ones. corpus-mcp never edits the vocabulary.

## Admin

An admin suite on the corpus server, on the model of
[Concept Clusters](https://github.com/jmajerus/concept-clusters)' own admin.
Pages show the **current state** of each kind of object. History is kept on a
separate Changes page. **Anything an MCP agent can change, a person can change
here too**, not just approve.

| Page | Shows | People can edit |
|---|---|---|
| `/admin` | Metrics and health, linked into the pages below; jobs | Refresh, back up, and preview-then-apply Calibre jobs |
| `/admin/books` | Every book, with filters for library, format, status, shelf, category, citekey, ISBN, and problems | — |
| `/admin/books/<id>` | Metadata, categories, citekey, shelves, ISBNs, file, outline, quotes, and recent changes | The book's **categories** (complete set) and **citekey** (pin, replace, unpin) |
| `/admin/books/<id>/read` | The book's text page by page, with saved quotes highlighted | **Select a passage to save it as a quote** |
| `/admin/quotes`, `/admin/quotes/<id>` | Every quote, filtered by words, tag, book category, author, and status; one quote in its surrounding text, with its citation | A quote's **note and tags**; delete |
| `/admin/categories` | The vocabulary tree with book counts, and other tags | — |
| `/admin/citekeys` | Pinned keys, and books ready or blocked | On each book page |
| `/admin/proposals` | Agent proposals | Approve, edit, reject, reopen |
| `/admin/shelves`, `/admin/jobs`, `/admin/jobs/<id>` | Shelves; jobs, with each job's per-book changes and log | Apply a preview |
| `/admin/changes` | The change log, filterable, with changes per day | — |

An approved category set is a book's complete set of vocabulary tags.
Applying it adds and removes vocabulary tags to match, and never touches
other tags. Calibre changes always run as preview, then apply. The apply
runs exactly the previewed plan, backs up `metadata.db`, and refreshes the
index. They run on the Calibre-Web host as named commands of the sync key's
forced command, never as a shell.

Every write needs a verified Cloudflare Access identity
(`CORPUS_ACCESS_TEAM_DOMAIN`, `CORPUS_ACCESS_AUD`). Direct LAN access is
read-only.

## Quotes

Quotes are passages saved from the books, by agents (`save_quote`) or by
people (select text in a book's reader). Either way, the passage is checked
against the book's text. Quote marks, dashes, spacing, case, and a page break
inside the passage may differ; what's stored is the book's exact wording. A
passage that isn't in the book isn't saved, and the closest passages are
returned instead.

Each quote records:
- an anchor: its pages, offsets, and the text around it
- free-form tags for themes and forms (`overwork`, `parable`) and links
  (`cc:puzzle:<id>`), kept to one spelling each
- a note

Quotes have no categories of their own: the book gives the subject, and
searching by category matches the source book's categories.

When a book's file changes, its quotes are found again by their text, or
marked orphaned; never deleted. Quotes live in `data.db` and are backed up
nightly.

## Shelves

Calibre-Web shelves are topic collections, such as *Misinformation*, kept in
Calibre-Web's own `app.db` rather than in the Calibre library. The sync key's
forced command, [`deploy/corpus-source.sh`](deploy/corpus-source.sh), allows
exactly two things: read-only rsync of the library, and a `shelves` command
that prints the public shelves and their book ids as JSON. `app.db`, which
also holds password hashes, never leaves the Calibre-Web host. Each refresh
replaces the index's `shelves` and `book_shelves` tables from that export.
If the export fails, the previous membership is kept.

## Citekeys

Every book gets a proposed citekey (author + year + first significant title
word, as in `nye2011future`), built from its Calibre metadata by
[`@jmajerus/citekey`](packages/citekey), a Better BibTeX–style rule packaged
for reuse (other projects install it from a GitHub release). The preset is
`CORPUS_CITEKEY_PRESET`: `author-year-word` (the default) or `bbt-default`.

To file a cited book in a reference manager, `cite_passage` returns a BibTeX
`@book` entry built from Calibre's own metadata (`bibtex`) and the book's
ISBN when it passes its check digit (`isbn`). The project that files the book
assigns the final key; `pin_citekey` then stores it against the book's Calibre
UUID. Any BibTeX-safe key is accepted and kept as given; one that doesn't
follow this server's rule gets a warning. A pinned key never changes on its own and is accepted anywhere a book id
is. A `citekey` identifier set in Calibre takes precedence over a pinned key.

Pinned keys live in `data.db`, which unlike the index is never rebuilt and is
backed up nightly. `corpus_status` lists books whose metadata blocks a key:
an unknown author, no year, or one author record naming several people.

When Calibre has no valid ISBN, `cite_passage` also returns `isbn_candidates`.
These are the checksum-valid ISBNs printed in the book's first and last pages,
each with its page, the printed line, and its binding (hardcover, paperback,
or ebook) when one is printed beside it. Copyright pages often list several
editions, and back pages often advertise other books, so these are offered for
someone to confirm, never filed automatically.

## Zotero

corpus-mcp can mirror a Zotero library, read-only, to see which Calibre books
are already filed there. zotero.org can be slow to answer, so nothing waits on
it: a background sync (every 30 minutes, and from the dashboard) copies the
fields matching needs into `data.db`, asking only for what changed since the
last library version, with long timeouts, retries, and Zotero's `Backoff` and
`Retry-After` headers honoured. Everything else reads the mirror.

- **Matching:** a book matches an item whose Extra holds `Calibre UUID: <uuid>`
  (written when a book is filed from `cite_passage`'s BibTeX), else one item
  with the book's ISBN, else a link a person confirmed. Items with the same
  title, first author, and year are offered as candidates to confirm or
  reject, on the book's page and at `/admin/zotero`.
- **Pinning:** a matched item's citekey (Zotero's `citationKey` field, or a
  `Citation Key:` line in Extra) is pinned to a book that has no key yet.
  A key that differs from a pinned or Calibre key is reported, never changed.
- **Citing:** `cite_passage` and `cite_quote` add `zotero` (the matched item)
  and warn before filing a book that is already there.
- **Setup:** make a key with read-only library access at
  zotero.org/settings/keys, put `CORPUS_ZOTERO_LIBRARY=users/<id>` and
  `CORPUS_ZOTERO_API_KEY` in `.env`, and run `npm run deploy -- --zotero`.

## Citations

`cite_passage` (and `cite_quote`, for a saved quote) returns:

```json
{
  "csl": { "id": "nye2011future", "citation-key": "nye2011future", "type": "book", "title": "The Future of Power",
           "author": [{ "family": "Nye", "given": "Joseph S., Jr." }], "publisher": "PublicAffairs",
           "issued": { "date-parts": [[2011]] }, "ISBN": "9781586488925" },
  "locator": { "label": "page", "locator": "4-5" },
  "position": { "page": 19, "end_page": 20, "page_kind": "page", "page_label": "4", "end_page_label": "5", "section": "Part One › Chapter 1" },
  "citekey": "nye2011future", "citekey_source": "pinned",
  "bibtex": "@book{nye2011future, …}", "isbn": "9781586488925", "isbn_candidates": [],
  "warnings": []
}
```

- `csl` is a CSL JSON item. Its `id` is the citekey, or `calibre:<uuid>` when
  there is none. A Calibre author with a comma in the sort form ("Nye,
  Joseph S., Jr.") becomes `family` and `given`; one without becomes
  `literal`. `issued` is the year; empty fields are left out.
- `locator` is a CSL locator: printed page labels for PDFs (physical pages,
  with a warning, when a PDF has none), and null for EPUB and MOBI, whose
  locations are not pages. `position` is where the passage is in the index.
- `bibtex` is null when the citekey is blocked; `isbn` is null when Calibre's
  ISBN is missing or fails its check digit.
- Until consumers switch, the legacy `citation` (`title`, `author`,
  `publisher`, `year`, `pages`) and `zotero_filing` fields are also returned.

## Locators

- **PDF.** Pages are physical pages. Each page also keeps its printed label
  from the PDF's page-label tree, so physical page 19 can be cited as page
  `4`. Citations use the printed label.
- **EPUB and MOBI.** These reflow, so page numbers depend on layout. corpus-mcp
  lays every reflowable book out at one fixed size, which gives stable
  *location* numbers for reading. They are never presented as page numbers.
  Citations name the chapter, taken from the book's outline.

## How it works

```text
Calibre library ── rsync (read-only) ──▶ books/<library>/…
                                              │
                        corpus-mcp index      ▼  metadata.db → MuPDF → SQLite FTS5
                                           corpus.db
                                              │  read-only
                        corpus-mcp serve      ▼  Streamable HTTP /mcp, or stdio
                                              │
                                         MCP clients
```

- **Catalogue.** Each library's `metadata.db` is the source of truth for
  books, authors, publishers, ISBNs, and format files. The indexer reads an
  in-memory copy, so it never locks Calibre's database. It doesn't use the
  `metadata.opf` backups, which go stale.
- **Extraction.** The official [`mupdf`](https://www.npmjs.com/package/mupdf)
  WebAssembly package reads all three formats. It provides each page's text,
  printed page labels, and the outline. Running heads and folios are stripped
  from PDFs.
- **Incremental indexing.** A rescan skips files whose size and modification
  time are unchanged, and rehashes the rest. Only changed books are
  re-extracted. Identical files in more than one library are collapsed in
  search results.
- **Exclusions.** Only allowlisted libraries are indexed. Books carrying an
  excluded Calibre tag (by default `private`) are never indexed.

## Quick start

Requires Node.js 22 or later. `better-sqlite3` compiles natively, so you also
need a C++ toolchain and Python.

```bash
npm install
npm run build

# Index a directory that holds one folder per Calibre library
CORPUS_BOOKS_ROOT=~/Calibre CORPUS_LIBRARIES=main CORPUS_DB=./corpus.db \
  node dist/cli.js index

# Serve over Streamable HTTP on :8000/mcp (or add --stdio)
CORPUS_BOOKS_ROOT=~/Calibre CORPUS_DB=./corpus.db node dist/cli.js serve
```

Register it with an MCP client, for example Claude Code:

```bash
claude mcp add --transport http corpus http://localhost:8000/mcp
```

Run the tests with `npm test`. The test fixtures (a PDF with page labels and
an outline, an EPUB, and a Calibre `metadata.db`) are generated in code.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CORPUS_BOOKS_ROOT` | `/srv/corpus/books` | Directory containing one folder per Calibre library |
| `CORPUS_LIBRARIES` | `main` | Comma-separated library folders to index |
| `CORPUS_EXCLUDE_TAGS` | `private` | Calibre tags that keep a book out of the index |
| `CORPUS_DB` | `/var/lib/corpus-mcp/corpus.db` | Index file (derived; can be rebuilt) |
| `CORPUS_DATA_DB` | `/var/lib/corpus-mcp/data.db` | Primary data such as pinned citekeys (never rebuilt) |
| `CORPUS_BACKUP_DIR` | `/var/lib/corpus-mcp/backups` | Where `corpus-mcp backup` writes daily copies of `data.db` (14 kept) |
| `CORPUS_HOST` / `CORPUS_PORT` | `0.0.0.0` / `8000` | HTTP listen address |

The server also answers `GET /health`.

## Deployment

[`deploy/`](deploy/) holds systemd units, the rsync pull script, and the setup
scripts. [`tools/deploy.mjs`](tools/deploy.mjs) provisions a Debian LXC,
installs releases with a health check, and rolls back on failure. Both are
written for the author's own Proxmox network (`*.localdomain` hosts), so adapt
the hostnames before using them elsewhere. `npm run deploy` and
`npm run tags:apply` read their settings from a gitignored `.env` (see
[`.env.example`](.env.example)). [PLAN.md](PLAN.md) records the
design decisions, the facts about the corpus, and the known issues.
