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
| `pin_citekey` | Pin a book's citekey | ✓ | Records the citekey a book was given elsewhere, such as in the reference manager it was filed in. |
| `get_tag_vocabulary` | Get tag vocabulary | | The vocabulary's terms as Calibre tags, the controlled vocabulary for categories, with scope notes and, for corpus-mcp's own terms, their status. |
| `vocabulary_report` | Vocabulary report | | How Calibre's tags stand against the vocabulary: retired terms still in use, tags shaped like terms the vocabulary lacks, and books tagged only at a broad term. |
| `add_provisional_term` | Add a provisional term | ✓ | Coins a term during research, usable for tagging at once and marked provisional until a person reviews it. |
| `tagging_worklist` | Get books to tag | | Books still without a tag proposal, with the context needed to choose tags. |
| `propose_tags` | Propose tags for a book | ✓ | Proposes 1–3 vocabulary tags for a book, for a person to review. |
| `save_quote` | Save a quote | ✓ | Saves a passage as a quote after checking it against the book; the book's exact wording is stored. |
| `search_quotes` | Search quotes | | Finds saved quotes by words in their text, note, or tags, and by book, author, book category, tag, or status. |
| `get_quote` | Get a quote | | One saved quote with the text around it, its locator, and its citation. |
| `update_quote` | Update a quote | ✓ | Changes a quote's note or tags; the quoted text never changes. |
| `delete_quote` | Delete a quote | ✓ | Deletes a saved quote. |
| `cite_quote` | Cite a quote | | A quote's verified text, reflowed as prose, and locator with its citation object. |
| `corpus_status` | Corpus status | | Reports index freshness, counts, books that failed, have no text layer, or have no outline, which books are ready for a citekey, and the ISBNs and years books print that Calibre lacks. |

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
- **Keep a passage:** `save_quote`, then `cite_quote` whenever it's needed.
- **Tag books:** `get_tag_vocabulary` → `tagging_worklist` → `propose_tags`; a
  person reviews the proposals (see [Categories](categories.md)).

Book ids look like `main:42`. Any tool that takes a book id also takes the book's
citekey (such as `nye2011future`). Pages are 1-based.
