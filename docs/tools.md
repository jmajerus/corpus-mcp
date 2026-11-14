# MCP tools

corpus-mcp's tools, for an agent connected over MCP (`/mcp`, or stdio). People
can do the same things on the [admin pages](admin-ui.md).

## Names and titles

Every tool has two names. MCP clients show them in different places:

- The **name** (`tagging_worklist`) is the identifier the agent calls. Cloudflare's
  dashboard and Claude Code (`mcp__corpus__tagging_worklist`) show this one.
- The **title** ("Get books to tag") is the display name. Claude web's connector
  settings show this one.

Both are set where each tool is registered, in [`src/server.ts`](../src/server.ts).

| Name | Title | Writes | What it does |
|---|---|---|---|
| `search_corpus` | Search book text | | Full-text search (SQLite FTS5, BM25 ranking) over every indexed book. Returns ranked snippets with book, page, printed page label, and section. Supports phrases, prefixes, and filters by book, library, or author. |
| `list_books` | List books | | Looks up books by title, author, tag, publisher, ISBN, citekey, or shelf. |
| `list_tags` | List tags | | Lists Calibre tags (Calibre-Web's *Categories*) as a tree; `.` nests them, and any tag filters `search_corpus` and `list_books` together with the tags below it. |
| `list_shelves` | List shelves | | Lists Calibre-Web's public shelves (topic collections) with book counts; any shelf name can filter `search_corpus` and `list_books`. |
| `get_book_outline` | Get book outline | | Returns metadata and the table of contents with the page where each section starts. |
| `read_book` | Read book text | | Returns contiguous text for a page range or a named section, within a character budget, and says where to continue. |
| `render_page` | Render PDF page | | Returns a PNG of a PDF page, for figures, tables, and equations. |
| `cite_passage` | Cite a book | | A book's citation as a CSL JSON item, with a CSL locator for a page range, the reading position, and filing data: a BibTeX entry, a valid ISBN, or printed ISBN candidates, and the printed year when Calibre has none (see [Citations](citations.md)). |
| `pin_citekey` | Pin a book's citekey | ✓ | Records the citekey a book was given elsewhere, such as in the reference manager it was filed in, then refreshes the Zotero mirror and answers with the book's match (`zotero`, `zotero_state`, `zotero_note`). |
| `get_tag_vocabulary` | Get tag vocabulary | | The vocabulary's terms as Calibre tags, the controlled vocabulary for categories, with scope notes and, for terms not yet confirmed in terminology-mcp, their status. |
| `vocabulary_report` | Vocabulary report | | How Calibre's tags stand against the vocabulary: retired terms still in use, tags shaped like terms the vocabulary lacks, and books tagged only at a broad term. |
| `add_provisional_term` | Add a provisional term | ✓ | Proposes a term to terminology-mcp, copied from a reference-vocabulary term (`source`); usable for tagging at once, provisional until its owner confirms it there. |
| `tagging_worklist` | Get books to tag | | Books still without a tag proposal, with the context needed to choose tags. |
| `propose_tags` | Propose tags for a book | ✓ | Proposes 1–3 vocabulary tags for a book, for a person to review. |
| `status` | Corpus status | | Reports index freshness, counts, books that failed, have no text layer, or have no outline, which books are ready for a citekey, and the ISBNs, years, authors, and titles books print that Calibre lacks. |

Quotes are kept in quote-mcp, which has its own tools (`add_quote`,
`search_quotes`, `cite_quote`, and more). corpus-mcp's retired quote tools,
which only pointed there, were removed on 2026-11-13.

`status` was `corpus_status` until 2026-11-13. It was renamed so that a portal
prefixing each server's tools shows `corpus_status`, not `corpus_corpus_status`.

The tools marked *Writes* declare `readOnlyHint: false`; every other tool is
annotated read-only. Clients that group or gate tools by permission, as Claude web
does, use this hint. The writing tools change only corpus-mcp's own data
(`data.db`). corpus-mcp never writes to Calibre itself; approved tags reach
Calibre only through a job a person previews and applies (see
[Operations](operations.md#calibre-jobs)).

## Typical flows

- **Cite a passage:** `search_corpus` → `read_book` around a hit →
  `cite_passage`. Once the book is filed in a reference manager, record its key
  with `pin_citekey`.
- **Keep a passage:** quote-mcp's `add_quote`, with the book id or citekey as
  `work` (it checks the words against the book here), then its `cite_quote`.
- **Tag books:** `get_tag_vocabulary` → `tagging_worklist` → `propose_tags`; a
  person reviews the proposals (see [Categories](categories.md)).

Book ids look like `main:42`. Any tool that takes a book id also takes the book's
citekey (such as `nye2011future`). Pages are 1-based.
