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
| `cite_passage` | Builds a citation object (`title`, `author`, `publisher`, `year`, `pages`) for a book and page range, warns about missing metadata, and for a book not yet in Zotero offers ways to file it (see *Citekeys*). |
| `pin_citekey` | Records the citekey a book was given when it was filed in Zotero. |
| `get_tag_vocabulary` | Concept Clusters' taxonomy as Calibre tags, the controlled vocabulary for categories. |
| `tagging_worklist` | Books still without a tag proposal, with the context needed to choose tags. |
| `propose_tags` | Proposes 1–3 vocabulary tags for a book, for a person to review. |
| `corpus_status` | Reports index freshness, counts, books that failed, have no text layer, or have no outline, and which books are ready for a citekey. |

All tools except `pin_citekey` and `propose_tags` are read-only, and corpus-mcp never writes to Calibre.

## Categories

Calibre tags (Calibre-Web's *Categories*) follow a controlled vocabulary:
[Concept Clusters](https://github.com/jmajerus/concept-clusters)' taxonomy as
slug paths such as `social-sciences.psychology.social-psychology` (snapshot in
[`data/`](data/)). Slugs are Concept Clusters' stable ids, so a renamed category
leaves Calibre's tags valid. Tools and the review page show the titles
("Social Sciences › Psychology › Social Psychology") and accept either form. An agent takes
books from `tagging_worklist` and calls `propose_tags`. A person approves,
edits, or rejects each proposal at `/admin/proposals`, or sets a book's categories directly on its page. Then
`npm run tags:apply -- --apply` runs [`tools/calibre-tags.sh`](tools/calibre-tags.sh)
on the Calibre-Web host. That script backs up `metadata.db` and adds the
approved tags with `calibredb`, keeping each book's existing tags.

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
| `/admin/books/<id>` | Metadata, categories, citekey, shelves, ISBNs, file, outline, and recent changes | The book's **categories** (complete set) and **citekey** (pin, replace, unpin) |
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
[Concept Clusters](https://github.com/jmajerus/concept-clusters)' Better
BibTeX–style rule. The two implementations share the cases in
[`tests/citekey-cases.json`](tests/citekey-cases.json).

To file a cited book in Zotero, `cite_passage` offers a BibTeX `@book` entry
built from Calibre's own metadata, followed by an ISBN lookup when the book
has a valid ISBN. Concept Clusters files the book, assigns the final key, and
returns it. `pin_citekey` then stores that key against the book's Calibre
UUID. A pinned key never changes on its own and is accepted anywhere a book id
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
the hostnames before using them elsewhere. [PLAN.md](PLAN.md) records the
design decisions, the facts about the corpus, and the known issues.
