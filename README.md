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

## What it does

- **Search and read.** Full-text search across every indexed book, then read
  around a hit by page range or section, or render a PDF page as an image.
- **Cite.** A CSL JSON citation with a real locator, plus BibTeX and ISBN data
  for filing the book in a reference manager, and pinned citekeys once it is
  filed.
- **Quote.** Save passages, checked against the book's text, with notes and tags.
- **Categorize.** Agents propose categories from a controlled vocabulary; a
  person reviews them, and approved sets are applied to Calibre.
- **Administer.** Web pages where a person can see and change everything an
  agent can, and preview and apply changes to Calibre.

corpus-mcp never writes to Calibre on its own: its tools change only its own
data, and Calibre changes go through a job a person previews and applies.

## Documentation

| Document | For |
|---|---|
| [MCP tools](docs/tools.md) | Every tool's name and display title, what it does, and which ones write |
| [Using the admin pages](docs/admin-ui.md) | A guide to the web interface at `/admin`, page by page |
| [Categories and the taxonomy](docs/categories.md) | The controlled vocabulary, its file format and intake, tagging books, and the overlay of research terms |
| [Citations, citekeys, and quotes](docs/citations.md) | The citation format, locators, citekeys, the Zotero mirror, and saved quotes |
| [Operations](docs/operations.md) | How indexing works, shelves, access, Calibre jobs, bulk imports, configuration, and deployment |
| [PLAN.md](PLAN.md) | Design decisions, facts about the corpus, and known issues |

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

Configuration and deployment are in [Operations](docs/operations.md).
