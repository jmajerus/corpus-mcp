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
| `get_book_outline` | Get book outline | | Returns metadata and the table of contents with the page where each section starts. For a PDF, also `page_labels` (where `page_label` comes from, with the printed numbering inferred from the contents and folios), `text_quality` (letters lost to ligatures, characters with no text), and, with no outline, `printed_contents` read from the contents the book prints. See [Printed pages](#printed-pages). |
| `read_book` | Read book text | | Returns contiguous text for a page range or a named section, within a character budget, and says where to continue. `skim: true` gives only headings and each paragraph's first sentence. |
| `render_page` | Render PDF page | | Returns a PNG of a PDF page, for figures, tables, and equations. |
| `cite_passage` | Cite a book | | A book's citation as a CSL JSON item, with a CSL locator for a page range, the reading position, and filing data: a BibTeX entry, a valid ISBN, or printed ISBN candidates, and the printed year when Calibre has none (see [Citations](citations.md)). |
| `pin_citekey` | Pin a book's citekey | ✓ | Records the citekey a book was given elsewhere, such as in the reference manager it was filed in, then refreshes the Zotero mirror and answers with the book's match (`zotero`, `zotero_state`, `zotero_note`). |
| `pin_page_labels` | Pin a PDF's page numbering | ✓ | Records a PDF's printed numbering when its `page_label`s are wrong (a PDF with no page-label metadata gets its file positions). The next refresh applies it to every `page_label` and to quote-mcp's anchors. See [Printed pages](#printed-pages). |
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

## Printed pages

A PDF's `page_label` is the number printed on the page, from the PDF's page-label
metadata. A PDF without that metadata (common for scans and downloads) gets its
file positions instead, which are wrong whenever the printed numbering doesn't
start on the first page. *Zero Spaces* (`main:14`) prints one lower all the way
through, behind a ResearchGate cover sheet.

`get_book_outline` says which it is in `page_labels.source`: `pdf`,
`file_position`, `pinned`, `pin_pending` (pinned, applied by the next refresh), or
`pin_for_other_file` (pinned against a file since replaced, so not applied). For a
PDF it also infers the printed numbering from two kinds of evidence: where the
printed contents' headings start (an entry printed at 15 whose heading starts on
file page 16 says +1), and folios the text kept. `page_labels.inferred` gives the
offset, the evidence, and the `suggested_pin`.

`pin_page_labels` records the numbering: a file page and the number printed on
it, counting on from there in arabic or roman as given, or several `ranges` for
roman front matter and an arabic body. Pages before the first range get no label.
The pin is kept in `data.db` by Calibre UUID, with the file's sha256; the server
reads the index read-only, so the refresh (`corpus-mcp index`, every ten minutes)
writes it into the index and gives quote-mcp's anchors on the book their new
labels, each a `reanchored` change quote-mcp follows. `clear: true` goes back to
the PDF's own labels at the next refresh.

`text_quality` reports words whose letters the text lost to ligature glyphs ("Te"
for "The", "afer" for "after", "dierent" for "different"), and characters with no
text (U+FFFD). quote-mcp's `add_quote` matches across lost ligature letters (the
verify answer's `restored`), so a passage is quoted as printed.
