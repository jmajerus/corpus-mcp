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
| `list_books` | Looks up books by title, author, tag, publisher, or ISBN. |
| `get_book_outline` | Returns metadata and the table of contents with the page where each section starts. |
| `read_book` | Returns contiguous text for a page range or a named section, within a character budget, and says where to continue. |
| `render_page` | Returns a PNG of a PDF page, for figures, tables, and equations. |
| `cite_passage` | Builds a citation object (`title`, `author`, `publisher`, `year`, `pages`) for a book and page range, and warns about missing metadata. |
| `corpus_status` | Reports index freshness, counts, and books that failed, have no text layer, or have no outline. |

All tools are read-only. corpus-mcp never writes to Calibre.

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
| `CORPUS_DB` | `/var/lib/corpus-mcp/corpus.db` | Index file |
| `CORPUS_HOST` / `CORPUS_PORT` | `0.0.0.0` / `8000` | HTTP listen address |

The server also answers `GET /health`.

## Deployment

[`deploy/`](deploy/) holds systemd units, the rsync pull script, and the setup
scripts. [`tools/deploy.mjs`](tools/deploy.mjs) provisions a Debian LXC,
installs releases with a health check, and rolls back on failure. Both are
written for the author's own Proxmox network (`*.localdomain` hosts), so adapt
the hostnames before using them elsewhere. [PLAN.md](PLAN.md) records the
design decisions, the facts about the corpus, and the known issues.
