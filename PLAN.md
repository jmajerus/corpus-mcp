# corpus-mcp plan

corpus-mcp is an MCP server that lets an agent search, read, and cite the
books in the Calibre libraries. It complements the LAN Zotero MCP server.
Zotero stays the catalogue and citation authority for scholarly works and
their attachments. corpus-mcp serves the long-form books that live in
Calibre and are not Zotero attachments.

Its first use is Concept Clusters authoring. An authoring agent looks up a
concept in the book corpus, reads the passage in context, and writes an
`info.citations` entry with a real locator (printed page or chapter).

`Corpus MCP plan.md` is the original Google AI draft. This document
replaces it as the plan of record. The section *Departures from the draft*
explains what changed.

## Decisions

| Area | Decision |
|---|---|
| Scope | Calibre books only. Zotero attachments stay with zotero-mcp. |
| Runtime | A dedicated Proxmox LXC (`corpus-mcp.localdomain`), on the same pattern as the zotero-mcp LXC, with the same `authoring` login. Nothing runs on the workstation except development and `npm run deploy`. |
| Transport | Streamable HTTP at `http://corpus-mcp.localdomain:8000/mcp`, plus stdio for tests and development. |
| Book source | The Calibre-Web server `calibre-web.localdomain` (CT 115) is the master. It serves one consolidated library, `/mnt/Calibre/main`. Neither the older calibre-server (`calibre.localdomain`) nor the workstation's Calibre files are used. |
| Book transfer | The corpus LXC pulls a read-only mirror over SSH every 10 minutes with rsync. It copies only `metadata.db` and PDF, EPUB, MOBI, and AZW3 files. On CT 115 a `corpus-sync` user is restricted to `rrsync -ro /mnt/Calibre`, and an ACL denies it `private`. CT 115's disk volume cannot be mounted into a second container while CT 115 runs, so mounting it is not an option. |
| Index | A SQLite file inside the LXC with FTS5. It is derived data and can be rebuilt from the books at any time. |
| Libraries | `main`, the library Calibre-Web serves. The other folders on the volume (`tech`, `private`, and so on) are not pulled. A book tagged `private` in Calibre is never indexed (`CORPUS_EXCLUDE_TAGS`). |
| Language | TypeScript on Node 22, matching Concept Clusters. |
| Extraction | The official `mupdf` npm package (WASM). It reads PDF, EPUB, and MOBI, which covers every book currently in the allowlisted libraries. |
| Writes | Read-only. corpus-mcp never writes to Calibre or Zotero. |

## Corpus facts (2026-10-24)

**On calibre-web.localdomain** (the source): `main` holds 504 books. Their
best formats are 237 PDF, 246 EPUB, 25 MOBI, and 2 others, and 73 carry an ISBN. It
consolidates the older libraries, including 378 of the 393 `tech` books. It
also includes 10 titles that are in the `private` library. Tag any of these
`private` in Calibre-Web to keep them out of the index. The first pull is 539
files, about 8.9 GB. Size the LXC's disk at 20 GB or more.

**From the development run** (on a workstation copy of an older library set):

- **Catalogue authority.** Each library's `metadata.db` is the authority.
  The `metadata.opf` files in book folders drift: one library had 67 books
  in its database but 95 OPF folders, and some folders reused an id. The
  indexer reads an in-memory copy of `metadata.db`, so it never locks or
  writes the file. Its `data` table names each book's format files. If a
  library's database cannot be read (for example, pulled mid-write), that
  library keeps its previous index.
- **MOBI has no outline in MuPDF** (0 of 55 files). MOBI-only books can be
  searched and read, but they have no chapter locators. On 2026-10-25,
  `tools/calibre-convert.sh --apply` added EPUBs to all 25 MOBI/AZW3-only
  books in `main` on CT 115. The indexer now prefers the EPUB, so the index
  holds 270 EPUB, 237 PDF, and no MOBI, and books without an outline fell
  from 39 to 14. *Suspicious Minds* now has 91 outline entries. Pins carry
  over, because they are keyed by Calibre UUID. KFX is not readable.
  Calibre-Web's own Convert needs *Path to Calibre Binaries* set to
  `/usr/bin` (it pointed at a nonexistent `/opt/calibre/`).
- **ISBNs are sparse outside `tech`.** Running Calibre's *Download metadata*
  on books you cite fills ISBN, publisher, and year. Citations and Zotero
  filing need these.
- **Scans.** A PDF with no text layer is indexed but empty. `corpus_status`
  lists it under `little_or_no_text`.
- **Speed.** About 1 second per book to extract. A rescan with no changes
  takes under 0.1 seconds.

## Locators and citations

Citable locators are what make this useful for authoring, so they get
first-class treatment.

- **PDF** has fixed pages. Each page records its physical index and its
  printed label from the PDF page-label tree (`Page.getLabel()`), such as
  `xii` or `47`. Citations use the printed label.
- **EPUB and MOBI** reflow, so their page numbers depend on layout. The
  service lays every reflowable book out at one fixed size, so its internal
  *location* numbers stay stable for reading and navigation. Those numbers
  are never presented as page numbers. Citations use the chapter, taken from
  the book's outline.
- Every passage records the outline path of the section that contains it,
  for example `Part II › 7. The Weak Ties`.

A book's id is `<library>:<calibre id>` (for example `main:42`). Calibre's
`metadata.db` supplies title, authors, publisher, date, language, tags,
ISBN, and UUID. The service never invents Zotero keys.

Concept Clusters citations have `title`, `author`, `publisher`, `year`,
`pages`, and `url`, and no chapter field. `cite_passage` returns exactly
that shape. For EPUB and MOBI books it leaves `pages` out and returns the
chapter in a separate `locator`. Adding a `chapter` citation field is a
possible Concept Clusters change. It is not required.

## MCP tools

| Tool | Purpose |
|---|---|
| `search_corpus` | Full-text search (FTS5, BM25) over passages. Returns ranked snippets with book, section, and locator. Filters by library, book, author. |
| `list_books` | Catalogue lookup by title, author, tag, or ISBN. Returns metadata, the format in use, and index status. |
| `get_book_outline` | Metadata plus the outline (table of contents) with locators. Read this before a long book. |
| `read_book` | Contiguous text for a page or location range, or for one outline section, with a character budget and a continuation cursor. |
| `render_page` | A PNG of one page, for figures and tables (PDF only; reflowable books have no fixed page). |
| `cite_passage` | A Concept Clusters–shaped citation object (`title`, `author`, `publisher`, `year`, `pages` or `chapter`, plus `isbn`) for a book and locator. |
| `corpus_status` | Counts, last scan time, and books that were skipped or failed extraction. |

## Architecture

```text
calibre-web.localdomain (CT 115)          corpus-mcp LXC
/mnt/Calibre/main ─────── rsync pull ──▶ /srv/corpus/books/main/…
  (corpus-sync: rrsync -ro)                 │
                     corpus-refresh.timer ▼  (pull → scan → extract → SQLite)
                                     /var/lib/corpus-mcp/corpus.db  (WAL)
                                        │  read-only
                     corpus-mcp.service ▼  Streamable HTTP :8000/mcp
                                        │
            Claude Code / CC authoring agents (MCP clients on the LAN)
```

- **Indexer** (`corpus-mcp index`) is a separate process, so a slow WASM
  extraction never blocks the server. It reads each allowlisted library's
  `metadata.db` and picks one format per book that exists on disk (PDF,
  then EPUB, then MOBI, then AZW3). It skips a file whose size and mtime are unchanged, and
  rehashes (SHA-256) the rest. It extracts only books whose hash changed,
  replaces their rows in one transaction, and deletes books that disappeared.
  `corpus-refresh.service` runs the pull and then the indexer. Its timer
  fires 10 minutes after each run ends. A failed pull still indexes what is
  on disk.
- **Server** (`corpus-mcp serve`) opens the database read-only and is
  stateless. It reopens files from disk only for `render_page`.

### Schema (SQLite)

See `src/db.ts`. The tables are `books` (catalogue metadata, file
identity, and status), `outline`, `pages` (text, printed label, and section
path per page), `passages` (about 220-word chunks that never cross a page)
with an external-content FTS5 index, and `meta`.

## Phases

Status: phases 1 and 2 are implemented and tested (17 tests, and a
development run over a copy of the libraries). Phase 3 was deployed on
2026-10-24 to `corpus-mcp.localdomain` (Debian 13, 2 GiB RAM,
20 GB disk), using the interim source access described under *Known issues*.
The first pull (8.3 GB) and index took 36 minutes, with a 1.3 GB memory peak.
It indexed 507 of 510 books: 237 PDF, 245 EPUB, and 25 MOBI. Two books have no
readable file, and one EPUB (`main:127`) is a damaged zip. The index is 1.1 GB.
A refresh with no changes takes 0.3 seconds.

1. **Core indexer.** Read the Calibre catalogue, choose formats, extract with MuPDF
   (text, outline, page labels), chunk passages, write SQLite, provide the
   `index` CLI. Tests use small generated fixtures. Done when the indexer
   handles a development copy of the allowlisted libraries with no unexplained
   failures.
2. **MCP server.** The tools above over stdio and Streamable HTTP, with tests
   through the SDK client.
3. **LXC deployment.** `tools/deploy.mjs` follows concept-clusters'
   `zotero-deploy`: it logs in over SSH as `authoring`, using
   `AUTHORING_DEPLOY_PASSWORD` from corpus-mcp's `.env` (formerly `../concept-clusters/.env`), and runs one
   `sudo -S` per host.
   1. You create a Debian or Ubuntu LXC `corpus-mcp.localdomain` with the
      `authoring` sudo login and a disk of 20 GB or more.
   2. `npm run deploy -- --provision` installs Node 22, rsync, the `corpus`
      service user, and its sync key, and pins CT 115's host key.
   3. `npm run deploy -- --source-setup` adds the restricted `corpus-sync`
      user on CT 115. While CT 115's `sudo` is broken, use
      `--source-setup-user-key` instead (see *Known issues*).
   4. `npm run deploy` builds, tests, uploads a release to
      `/opt/corpus-mcp/releases/<timestamp>`, switches `current`, installs the
      units, and starts the first pull and index. On later deploys it
      health-checks `/health` and rolls back to the previous release on
      failure.
4. **Concept Clusters demonstration.** First run 2026-10-25, in ZCode through
   the shared Cloudflare portal (three servers, one URL). It went from search
   ("confirmation bias") to *Suspicious Minds* (`main:53`, MOBI), then
   read_book, cite_passage, and BibTeX filing (Zotero item 39NZUGQQ), then
   `pin_citekey brotherton2015suspicious`. `file_zotero_reference` timed out
   at 30 seconds in Zotero web API mode, but had committed. The agent
   checked by citekey before retrying, which is the right recovery. The run
   also showed that EPUB/MOBI locations were easy to misreport as pages, so
   results now label them `location`.
   Original scope: Register the server with the authoring
   clients. Author one puzzle whose citation comes from a Calibre book, from
   search through to a validated draft. On the Concept Clusters side,
   `file_zotero_reference` now accepts an `isbn` (concept-clusters 9bbde28,
   PR #313, open as of 2026-10-24). On this side, `cite_passage` validates the
   book's ISBN check digit and returns the ready-made
   `file_zotero_reference({ isbn })` call as `zotero_filing`. All 73 indexed
   books with an ISBN pass the check. ISBN lookups go through Open Library or
   Google Books, so compare the metadata Zotero returns with the citation.
   Books without an ISBN need Calibre's *Download metadata*, or filing by DOI,
   URL, or item key.
5. **Durable data: citekeys, then quotes.** corpus-mcp gains `data.db` for
   data that can't be rebuilt from the books: pinned citekeys (see
   *Citekeys* below) and verified quotations (see *Quotes* below).
6. **Later, if needed.** Semantic search with sqlite-vec and a LAN embedding
   model, if keyword search falls short in practice. An optional
   `zotero_item_key` lookup by ISBN through zotero-mcp, so results show
   whether a book is already in Zotero.

## Citekeys (phase 5 design)

Citekeys complement ISBNs rather than replace them. An ISBN is a lookup
key: Zotero fetches metadata from Open Library or Google Books, which can be
wrong, and only 73 indexed books have one. A citekey is a name derived from
the Calibre metadata itself. The stronger filing route is a BibTeX entry
built from Calibre's metadata, carrying the proposed citekey, with no
outside lookup.

**Status.** Implemented and deployed on 2026-10-25 (version 0.2.0). Of the
510 catalogued books with a readable file or a failed extraction:

| Result | Count |
|---|---|
| Ready to file from Calibre metadata | 215 (ISBN filing reaches 73) |
| Author "Unknown" | 152 |
| No publication year | 130 |
| On a merged author record | 37 (21 records) |
| Colliding proposed keys | 3, all duplicate copies in `main` |

A blocked book can still have more than one blocker.

Calibre's year is the edition date (Sapir's *Language* becomes
`sapir2011language`), which is right for citing that edition.

**Rule.** `src/citekey.ts` is a TypeScript port of Concept Clusters'
`modules/citationKeys.js`: Better BibTeX's
`auth.lower + year + title.skipwords.select(1,1).lower`, with its
institution, publisher, and author-repeat fallbacks. A Calibre author whose
sort form has a comma ("Gough, James") is a person (Zotero's two-field
creator). One without a comma is an organization or a single name
(single-field), which is how Calibre's own sort works. Drift is caught by
`tests/citekey-cases.json`, built from Concept Clusters' test cases. Both
repos run it, and both copies must stay identical.

**Merged author records.** The first readiness count blamed 54 books on
missing commas. They were really 21 author records each holding several
people, such as `James Gough| Daniel Bryant` (Calibre shows a comma inside a
name as `|`). Some are one person in the same shape
(`Rousseau| Jean-Jacques| 1712-1778`), so they are not guessed at. They are
reported as `merged_authors` for splitting in Calibre. No sort-name change
is needed in Concept Clusters.

**Assignment and pinning.**

1. corpus-mcp computes `proposed_citekey` for every book at index time.
2. When a book is cited, `cite_passage` returns
   `zotero_filing: { tool: "file_zotero_reference", arguments: { bibtex } }`.
   The BibTeX `@book` entry uses the proposed key, title, authors,
   publisher, year, ISBN when present, and `note = {Calibre UUID: …}`.
3. Concept Clusters files it. It assigns the final key, adding a/b suffixes
   via `uniqueCitationKey`, because only it can see the whole collection.
   It writes the key to the Zotero item, puts the Calibre UUID in Extra, and
   returns the key.
4. The agent calls `pin_citekey({ book_id, citekey })`. corpus-mcp stores it
   in `data.db` keyed by Calibre UUID, so it survives renumbering and
   re-indexing. A pinned key never changes on its own, even after a
   metadata edit (the same policy as Better BibTeX).
5. A `citekey` identifier set by hand in Calibre-Web overrides both and is
   reported as such.

**Use.** `list_books`, `search_corpus`, and `cite_passage` return
`citekey` (pinned) or `proposed_citekey`. Every tool that takes a `book_id`
also accepts a citekey. `corpus_status` reports key readiness: books ready
for a key, and books blocked by an unknown author, missing year, or
malformed sort name.

**Printed ISBNs.** When Calibre has no valid ISBN, the indexer scans the
first 20 and last 5 pages for ISBNs (`src/isbn.ts`; a regex plus the
checksum, without isbntools). A match counts if it follows "ISBN" or is a
978/979 ISBN-13. Each distinct ISBN keeps:

- its page
- `position`: `front`, or `back`, where it is often an advert
- the printed line
- a binding label, read from a parenthetical after the ISBN, then the text
  before it, then the text after it

The results are stored with `ISBN_SCAN_VERSION`, so a heuristic change
recomputes them without re-extracting text. `cite_passage` returns them as
`isbn_candidates`, never as a filing, because a copyright page often lists
several editions and the right one is the edition held. Online lookup by
title is deliberately skipped: it uses the same sources as Zotero's ISBN
lookup and often returns a different edition. Live: 340 of the 434 books
without a Calibre ISBN print at least one.

**Concept Clusters side** (concept-clusters 2dc5bab, PR #313).
`file_zotero_reference` accepts `bibtex` and files the book from the entry's
own metadata, with no lookup.

- **Parsing.** "Surname, Given" becomes a person; a braced name such as
  `{Apple Inc.}` stays one organization.
- **Duplicates.** A book already in the collection is matched by ISBN (an
  ISBN-10 equals its ISBN-13), but only among up to 10 title-search results,
  because Zotero cannot search by ISBN. Failing that, title, first author,
  and year must all match. Two different ISBNs mean different editions.
- **Reuse.** A matched book keeps its existing citekey and gains the
  Calibre UUID in Extra if it lacks it.
- **Elsewhere in the library.** A book outside the collection is moved in,
  keeping its citekey.
- **Every route returns `citekey`,** including the ISBN route, so
  `pin_citekey` works after any filing.
- **Invalid ISBNs.** An entry whose ISBN fails its check digit is rejected
  outright. `bookBibtex` leaves invalid ISBNs out, so such books still file
  by BibTeX.
- **Shared cases.** `tests/citekey-cases.json` is copied there and passes.

**Prerequisite.** Calibre metadata hygiene, the same as for ISBN filing:
fill unknown authors and years, fix author sort names, and merge duplicate
books. `corpus_status` lists the books to fix.

## Quotes (built 2026-10-25)

Implemented as designed below, with these decisions:

- **Quotes have no categories of their own** (data schema 8 dropped
  `category_mode` and `categories`). The book gives the subject: search's
  `category` filter matches the source book's categories, followed live, and
  the pages show them greyed for context. Tags carry everything finer.
  - Why: most quotes would have taken their book's categories anyway, and the
    exceptions (an epigraph off the book's subject, a parable, a reflection
    on overwork or compassion) sit on a finer axis than the subject taxonomy,
    which is what tags are for. Dropping the choice removes work for agents
    and people, and the review queue it created.
  - What's given up: filing a passage under a more specific subcategory than
    its book. Tag it instead (`social-change`), and revisit if a real need
    appears.
  - The third decision, all on 2026-10-25: an automatic default to the
    book's categories, then an explicit four-way choice (undecided, book's,
    own, none), then this.
- **Tags are first-class.** A new tag reuses an existing tag's spelling
  (case-insensitive), so one theme keeps one name. Search returns every tag
  with its count. The quotes list shows them as a cloud that filters on
  click, and the editors suggest existing tags as you type. Tags hold themes
  (`overwork`), forms (`parable`, `epigraph`), and links (`cc:puzzle:<id>`).
- **Creating, for people.** A reader view (`/admin/books/<id>/read`) shows
  the text with saved quotes highlighted. Selecting a passage saves it
  through the same check `save_quote` uses.
- **Admin pages.** `/admin/quotes` (list) and `/admin/quotes/<id>`
  (context, citation, and editing of note and tags; delete).
  Each book page lists its quotes.
- **Re-anchoring** runs after every scan (`reanchorQuotes`). A quote is
  retried only when its book's file changes.
- **History.** Saves, edits, deletes, re-anchors, and orphanings go into the
  change log.
- **Lookup.** A category given as a bare name ("Sociology") resolves when it
  is unique in the vocabulary.

Original design:

A quote store for passages worth keeping, separate from Zotero. It starts
with Calibre books, where the server can check every quote against the
source text. The design leaves room for Zotero and web sources later.

**Storage.** The `quotes` tables in `data.db` (`/var/lib/corpus-mcp`), shared
with pinned citekeys. The index is derived and can be rebuilt; `data.db`
holds primary data and is never rebuilt. The server keeps opening the index
read-only and opens `data.db` read-write. These are corpus-mcp's first write tools, which is acceptable
behind Access. A nightly SQLite online backup goes to
`/var/lib/corpus-mcp/backups`, keeping 14 days, in addition to Proxmox
backups of the LXC. `export_quotes` returns everything as JSON.

**Verification.** This is the main reason to build it. `save_quote` takes a
book, a page, and the text the agent wants to quote. It checks that text
against the extracted page text.

- Matching is on normalized text: Unicode NFKC, curly quotes and dashes
  folded, soft hyphens and line-break hyphenation removed, whitespace
  collapsed, case kept.
- The search order is the given page, then the page after it (for quotes
  that cross a page break), then two pages either side, then the whole book
  via FTS on the quote's rarest words.
- On a match, the server stores the book's exact wording, not the agent's.
  It returns that wording, its locator, and any corrections it made.
- On no match, it saves nothing and returns the closest passages.
- Maximum length: 2,000 characters. Quotes stay quotes, not excerpts.

**Anchor.** Each quote records:

- the Calibre UUID, which survives renumbering (the `library:id` is kept
  only for display)
- the file's SHA-256 at save time
- start and end page, printed labels, and section path
- character offsets within the page text
- about 40 characters of text before and after the quote, like a W3C
  TextQuoteSelector

When the indexer re-extracts a book, it re-anchors that book's quotes by
exact text, then by prefix and suffix. A quote it cannot place is marked
`orphaned`; it is never deleted.

**Tags and Concept Clusters.** Tags are free-form. A loose convention links
quotes to Concept Clusters without changing its schema:
`cc:puzzle:<puzzle id>`, `cc:category:<slug>`, `cc:subcategory:<slug>`.
An authoring agent finds a puzzle's quotes with
`search_quotes({ tag: "cc:puzzle:…" })`.

**Tools.**

| Tool | Purpose |
|---|---|
| `save_quote` | Verify and store a quote, with an optional note and tags |
| `search_quotes` | FTS over quote text, notes, and tags. Filters: book, author, tag, saved date, status. |
| `get_quote` | One quote with its full anchor and surrounding context |
| `update_quote` | Change the note or tags. The quoted text is immutable; save a new quote instead. |
| `delete_quote` | Remove a quote |
| `cite_quote` | The Concept Clusters citation object plus the verified quote text |
| `list_quote_tags` | Tags in use, with counts |
| `export_quotes` | Every quote as JSON |

**Attribution.** When a request comes through Cloudflare Access, the
`Cf-Access-Authenticated-User-Email` header is recorded as `saved_by`. It is
informational only, because LAN requests bypass Access.

**Later.** Zotero sources would use the item key and page, verified through
zotero-mcp's full text where it is available. Web sources would use the URL
and access date and would be unverified. Both need a `source_kind` column,
which the schema includes from the start.

## Shelves

Calibre-Web's public shelves (Business, Literature, Main, Misinformation,
Tech) are topic collections stored in its `app.db`, not in the Calibre
library.

- **Export on CT 115.** The sync key's forced command is
  `deploy/corpus-source.sh`, installed as `~authoring/.local/bin/corpus-source`.
  It dispatches read-only rsync to `rrsync -ro`, answers `shelves` with JSON
  from `app.db` (opened read-only, public shelves only), and refuses
  everything else. Tested: shell, `..` escape, write, and injection
  (`shelves; id`) are all refused. `app.db` is never copied, because it also
  holds password hashes.
- **Fetch.** `corpus-sync.sh` writes the export to
  `/var/lib/corpus-mcp/shelves.json`, replacing it only on success.
- **Load.** Each scan replaces `shelves` and `book_shelves` (with
  `book_shelves.book_id` joining `books.id`) in one transaction. A missing
  or malformed export leaves the tables as they were. Shelf book ids belong
  to `CORPUS_SHELVES_LIBRARY` (default `main`).
- **Tools.** `list_shelves`, a `shelf` filter on `search_corpus` and
  `list_books`, and `shelves` in book summaries.

## Categories (Calibre tags)

Calibre-Web's *Categories* are Calibre tags. Calibre nests them with `.`.
corpus-mcp offers `list_tags` (a tree with book counts at each level), a
`tag` filter on `search_corpus` and `list_books` that includes the tags
below the given one, and a tag-hygiene report in `corpus_status`.

**State (2026-10-25).** Tags are too sparse to filter by yet:

- 107 of 507 indexed books have any tag.
- There are 127 distinct tags; 105 are used once.
- 44 are BISAC codes from publisher metadata.
- Several are not subjects at all: publisher names, `MEAP V08`, `Sample Book`.
- `misinformation` (26 books) mirrors the Misinformation shelf.

**Status (2026-10-25).** Built and deployed. The vocabulary was first
`data/cc-taxonomy.json` (concept-clusters `authoring:taxonomy:export`, 175
slug tags); it is now a deployment file (see *Independence from Concept
Clusters*). The tools are `get_tag_vocabulary`, `tagging_worklist`, and
`propose_tags`. The review page is `/review` on the corpus server, with
`/api/tag-proposals`, `/api/vocabulary`, and `/api/tag-plan`; those routes
send no CORS headers, and their POST requires JSON. Apply with
`npm run tags:apply [-- --apply]`. The tag filter matches at any level.
First batch: 24 proposals for the Misinformation shelf, approved and
applied on 2026-10-25.

**Cleanup (2026-10-25).** `/api/tag-cleanup-plan` plus `misinformation` (a
duplicate of the Misinformation shelf) removed 137 non-subject tags from 91
books: BISAC codes, `Pragmatic Bookshelf`, MEAP statuses, `Sample Book`, and
pasted subtitles. Two false positives were kept by hand: `Minnesota` and a
Library of Congress subject heading. The rules were then tightened so
neither is flagged again.

That run hit a bug. For the 64 books whose tags were all removed,
`calibre-tags.sh` wrote its change summary in as a tag (e.g.
`- MEAP V03`). Tab-separated fields merged in bash's `read` when the
tag list was empty. A repair plan removed those 64 tags; nothing else was
affected. The script now separates fields with `\x1f`, and a test with a
stand-in `calibredb` covers the empty list. Each run backed up
`metadata.db` (`metadata.db.before-tags-*` on CT 115). After it: 85
distinct tags, no suspect tags.

**Plan: Concept Clusters taxonomy as the vocabulary** (chosen 2026-10-25).
Shelves stay as a few broad, curated collections. Tags become the granular,
many-to-many subject classification, mirroring Concept Clusters'
domain › category › subcategory (about 62 categories across 15 domains), so
"books for this puzzle's category" is an exact filter.

1. **Vocabulary snapshot.** A JSON export of Concept Clusters' taxonomy
   (domain names, category names, subcategory titles, and slugs), stored in
   corpus-mcp and refreshed when the taxonomy changes. corpus-mcp does not
   query the authoring database: the authoring brief keeps second programs
   off it. Open item: Concept Clusters provides the export (a command or
   MCP resource). Domain display names are not in `list_categories`, which
   gives only slugs such as `social-sciences`.
2. **Tag form: slugs** (changed from titles on 2026-10-25). For example,
   `social-sciences.psychology.social-psychology`; a category with no
   domain (`trivia`, `vocabulary`) sits at the top level.
   - Slugs are Concept Clusters' stable join ids, so a renamed category
     or subcategory leaves Calibre's tags valid. With titles it would have
     needed a re-tag pass.
   - Slugs need no workaround for the comma in names such as "Science,
     Technology & Society".
   - Titles are kept as labels ("Social Sciences › Psychology › Social
     Psychology") in `list_tags`, the vocabulary, and the review page.
   - Lookups and filters accept slugs or titles, at any level: `Psychology`
     and `psychology` both find `social-sciences.psychology.*`.
   - The cost: Calibre-Web's Categories list shows the slugs.
3. **Proposals.** A worklist tool hands an agent batches of books with
   context: title, authors, description, top-level outline titles, shelves,
   existing tags including BISAC, and the vocabulary. The agent records one
   to three vocabulary tags per book, with a short rationale. Proposals go
   in `data.db` (`tag_proposals`: Calibre UUID, tags, rationale, status), and
   any tag outside the vocabulary is rejected.
4. **Review.** You approve or edit proposals, as an exported plan file or a
   small review page.
5. **Apply.** `tools/calibre-tags.sh --apply <plan>` runs on CT 115 as the
   library owner, like `calibre-convert.sh`. It backs up `metadata.db`, then
   adds the approved tags with `calibredb set_metadata --field tags`, keeping
   existing tags. corpus-mcp itself stays read-only toward Calibre, and the
   next refresh picks the tags up.
6. **Cleanup.** The hygiene report lists BISAC, publisher, and status tags
   for removal once the vocabulary tags are in.

## Independence from Concept Clusters (agreed 2026-10-25)

A one-way dependency: Concept Clusters (CC) depends on corpus-mcp, and
corpus-mcp knows nothing about CC. Any project can reuse it with its own
vocabulary and citekey preset. corpus-mcp owns the formats (README); CC
adapts. Agreed with CC's agent, in order:

1. **Vocabulary** (done 2026-10-25). The `corpus-vocabulary/1` file, loaded
   from a configured path and reloaded on change; validation; retired terms
   (one replacement re-tags automatically, a split or drop goes to a
   person); `vocabulary_report`. `data/cc-taxonomy.json` left the repo.
   CC's export writes the format since concept-clusters c6817c2; the live
   file is that export (174 assignable terms of 187), installed with
   `npm run authoring:taxonomy:export -- --out
   .concept-clusters/corpus-vocabulary.json` in CC, then
   `npm run deploy -- --vocabulary=../concept-clusters/.concept-clusters/corpus-vocabulary.json`.
   The Interdisciplinary Studies category was an empty leftover and was
   withdrawn (4018daa), so every domain only groups; only `trivia` and
   `vocabulary` are assignable at the top level. No book was tagged with
   `interdisciplinary-studies` directly.
2. **Neutral citations** (done 2026-10-25). `cite_passage` and `cite_quote` return a CSL JSON
   item, a CSL locator (`{ label, locator }`, null for EPUB and MOBI), and
   corpus-mcp's reading `position`; filing becomes plain data (`bibtex`,
   `isbn`, `isbn_candidates`) with no tool names. One release carries the
   old `citation` and `zotero_filing` fields too, until CC switches.
   `pin_citekey` accepts any BibTeX-safe key and warns when it doesn't fit
   the preset. Pinned keys keep their case (lookups ignore it), so another
   project's camelCase keys survive. The old `locator` (page, section,
   label) became `position`; `isbn` is now the valid ISBN or null rather
   than Calibre's raw value.
3. **Citekey package** (done 2026-10-25, `citekey-v1.0.0`) `@jmajerus/citekey` in `packages/citekey`: pure ESM,
   no dependencies, released as a GitHub release tarball (`citekey-v<semver>`)
   because npm can't install a git subdirectory. `proposeCitekey(csl,
   preset | options)`; presets `author-year-word` (today's rule, the default)
   and `bbt-default` (Better BibTeX's `auth.lower + shorttitle(3,3) + year`).
   The cases file moves into the package, with CSL input and a preset per
   case. corpus-mcp uses it as an npm workspace (`packages/citekey`), and the
   deploy ships its build. Checked against the live catalogue before
   release: the same proposed key and blockers for all 510 books. Options
   added beyond the first draft: `order` (BBT puts the year last).
4. **Own environment** (done 2026-10-25). corpus-mcp's own `.env`
   (gitignored; `.env.example` lists the settings), no longer
   `../concept-clusters/.env`. It holds the authoring password and
   `CORPUS_VOCABULARY_SOURCE`, so every deploy also installs CC's latest
   export.

## Zotero mirror (stage 1 built 2026-10-25)

Read-only, against the personal library CC files into; CC stays the only
filer. Design for zotero.org's latency (ZCode saw `file_zotero_reference`
time out at 30 s after the item was created):

- **Mirror, not calls.** `zotero_items`, `zotero_isbns`, and `zotero_links`
  in `data.db` (schema 9). A sync fetches `items/top?since=<version>`
  (including trashed, to drop them) and `deleted?since=`, pages by what came
  back, and saves the version last, so an interrupted sync repeats rather
  than skips. 90 s timeouts, four tries, `Backoff` and `Retry-After`
  honoured. One sync at a time (`ZoteroSync`), on a 30-minute timer in the
  server and as the dashboard job "Sync from Zotero now".
- **Matching:** Calibre UUID in Extra (CC appends the BibTeX note there),
  then a unique ISBN, then a confirmed link; title + first author + year
  (±1) are candidates. An item whose Extra names another Calibre book is
  never a match or candidate for this one.
- **Pinning:** automatic for matched books with no pin and no Calibre key,
  as change source `zotero`; mismatches are reported only.
- **Not yet:** quote export as child notes (stage 2, write key, a
  `Zotero-Write-Token` on every write so a timed-out write can be retried
  without a duplicate).
- **Switching on:** `CORPUS_ZOTERO_LIBRARY` and `CORPUS_ZOTERO_API_KEY` in
  the workstation `.env`, then `npm run deploy -- --zotero`.

## Admin dashboard (2026-10-25)

`/admin` on the corpus server.

- **Metrics.** `corpus_status` reduced to counts, plus:
  - refresh history (an index `scan_runs` table)
  - the last pull (`sync-status.json`, written by `corpus-sync.sh`)
  - file sizes, backup age, and free disk space
  - a status strip for zotero-mcp, calibre-web, and authoring (HTTP probes,
    cached for 30 seconds)
- **Jobs.** Defined in `src/jobs.ts`. One runs at a time, logs stream to the
  page, and history is kept in the `data.db` `jobs` table.
  - *Refresh now* starts `corpus-refresh.service` through a polkit rule
    (`deploy/50-corpus-refresh.rules`, start only, that unit only) and tails
    `refresh.log`.
  - *Back up* runs in process.
  - *Tags*, *cleanup*, and *convert* are preview, then apply. The apply
    reuses the preview's stored plan, needs a successful preview under an
    hour old, and refreshes afterwards. They run as `tags-preview`,
    `tags-apply`, `convert-preview`, and `convert-apply` in CT 115's forced
    command, using the installed `calibre-tags.sh` and `calibre-convert.sh`.
    Each apply backs up `metadata.db`.
- **Auth.** Every write, `/review` approvals included, needs a
  `Cf-Access-Jwt-Assertion` token verified with `jose` against the team's
  keys, issuer, and the corpus application's AUD tag (`src/access.ts`, on
  the pattern of concept-clusters' `accessAuth.js`). Without both settings
  every write is refused. Direct LAN access is read-only.
- **Verified.** The polkit rule allows starting the refresh and refuses a
  restart of corpus-mcp or a stop of the refresh. The dispatcher runs the
  named commands and refuses a shell, injection, and an rsync write.

## Admin suite (2026-10-25)

The admin follows Concept Clusters' model: current-state pages first, and
history kept apart on `/admin/changes`.

- **Parity.** Anything an MCP agent can change, a person can change in the
  admin. Agents propose category sets (`propose_tags`) and pin citekeys
  (`pin_citekey`). On a book's page a person sets the complete category set
  (recorded as an approved proposal by that person) and pins, replaces, or
  unpins the citekey.
- **Complete sets.** An approved proposal is the book's complete set of
  vocabulary tags. `tagPlan` adds and removes vocabulary tags to match; other
  tags are never touched. A book page can preview and apply just that book.
- **Pages.** All on one layout (`src/web/layout.ts`): Dashboard, Books (list
  and detail), Categories, Citekeys, Proposals (formerly `/review`, which now
  redirects), Shelves, Jobs (list and detail; the job page replaced the
  earlier dialog), and Changes.
- **Change log.** `data.db` `changes` records Calibre writes from admin jobs
  (from the scripts' `@@change` lines), changes a refresh sees in Calibre
  (including edits in Calibre-Web; those already logged by a job are
  skipped), proposals and reviews, category edits, and citekey pins and
  unpins.

## Remote access (Claude web)

Claude web reaches the server through Cloudflare. The path is a Cloudflare
Tunnel public hostname pointing at `http://corpus-mcp.localdomain:8000`,
then a self-hosted Access application in front of that hostname, then a
Cloudflare MCP Server object whose URL ends in `/mcp`. The setup mirrors
zotero-mcp's.

- **One connector per server, for now.** Claude connects to corpus-mcp as
  its own custom connector, through its own Access application. A single
  Cloudflare MCP portal bundling several servers can work, but its OAuth
  logins don't yet sync smoothly across servers. Separate connectors avoid
  that.

- **Claude's OAuth callback.** Add `https://claude.ai/api/mcp/auth_callback`
  to **Allowed redirect URIs** in the Managed OAuth section of the
  self-hosted Access application. Cloudflare's Claude instructions put it
  under a portal's *Advanced settings*, but those apply only when Claude
  connects through a portal. Without it the OAuth handshake fails, even
  though the tunnel and origin are healthy.
- **Origin HTTP behavior.** The server answers CORS preflight (`OPTIONS`,
  204) and returns 405 for `GET` and `DELETE`, because a stateless server has
  no stream or session to offer.
- **Tool list changes.** After a deploy that changes the tool list, run
  **Sync** on the MCP Server object, then refresh the Claude connector and
  start a new conversation.

## Known issues

- **CT 115 ownership.** CT 115 runs as a privileged container, but its root
  filesystem has unprivileged-style ownership (uid 100000), so `sudo` fails
  there. Until it is repaired, the corpus LXC's sync key sits in the
  `authoring` user's `authorized_keys` on CT 115, restricted to
  `restrict,command="/usr/bin/rrsync -ro /mnt/Calibre/main"`. That key
  cannot open a shell, write, or reach outside `main`; all three were tested.
  The key is now forced to `~authoring/.local/bin/corpus-source` (see
  *Shelves*), which still allows only read-only rsync of `main` plus the
  shelf export. The LXC's env has
  `CORPUS_SOURCE=authoring@calibre-web.localdomain` and
  `CORPUS_REMOTE_PATH=./`. Once CT 115 is fixed, run `--source-setup`, set
  `CORPUS_SOURCE=corpus-sync@calibre-web.localdomain` and remove
  `CORPUS_REMOTE_PATH` from `/etc/corpus-mcp/env`, then delete the key line
  from `~authoring/.ssh/authorized_keys` on CT 115.
- **Native build.** `better-sqlite3` 13 has no prebuilt binaries, so the LXC
  needs `build-essential` and `python3`. `provision.sh` installs them.

## Departures from the draft

| Draft | Plan | Why |
|---|---|---|
| Tools keyed by `zotero_key` | Keyed by `<library>:<calibre id>` | Calibre books are not Zotero items. The draft invented `CAL_<md5(title+author)>` keys, which change when a title is edited and look like Zotero keys. |
| Duplicate outline, page reading, page images, and semantic search for Zotero items | Calibre only | zotero-mcp already provides these for Zotero attachments. |
| Fork Audiobookshelf | A small purpose-built scanner | About 600 books. A stat-based rescan is simpler than adopting and stripping a media server. |
| Syncthing from the workstation, or `calibredb` over the network | rsync pull from calibre-web.localdomain | The Calibre server is the source. rsync with `rrsync -ro` gives a read-only, resumable mirror with no daemon on either side. |
| Avoid `metadata.db`; use `metadata.opf` | Read `metadata.db` from an in-memory copy | The OPF backups are stale here. A read-only copy cannot lock or damage Calibre's database. |
| Two-way sync through `calibredb` | Read-only | Nothing in the authoring workflow needs to write to Calibre. |
| Postgres + pgvector | SQLite FTS5 in the LXC | The index is derived data. A file needs no server or migrations. Semantic search can be added later with sqlite-vec. |
| `pdf-parse`, PDF only | MuPDF: PDF, EPUB, MOBI | Most of the library is EPUB or MOBI. `pdf-parse` is unmaintained and reads PDF only. |
| Page numbers for every format | Printed page labels for PDF, chapters for reflowable books | Reflowable page numbers are not citable. |
| Embedding column (1536-d) left null | No embeddings in phase 1 | The draft never computed them. FTS works without them. |

The draft's code also had defects that the rewrite does not carry forward:
`CREATE EXTENSION pgvector` (the extension is named `vector`), a connection
opened for every tool call, an outline table that nothing populated, and the
first `.epub` or `.pdf` in a folder taken in directory order.
