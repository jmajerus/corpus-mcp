# Quote MCP plan

Proposed 2026-10-27; revised the same day so Quote MCP owns the quotes. Not
built. This file moves to Quote MCP's own repo when work starts.

Quote MCP is the store for quotations: structured records you can search,
tag, repair, and cite. Most of its quotes come from a few thousand paper
books that will not be digitized. Today those quotes exist only as Zotero
child notes, many of them generated programmatically years ago, some by
OCR, with their structure (where the quote ends, the page, the chapter
author, the concepts) held in conventions inside rich text. Quote MCP
imports them once into real fields and becomes their home from then on.

## Decisions

| Area | Decision |
|---|---|
| Source of truth | Quote MCP's database, for every quote. Zotero stays the authority for *books*: item metadata, citekeys, and citations. |
| Why not Zotero notes | Zotero has no quote type. Only a note's tags are structured; the page, chapter author, status, and the quote's own boundaries are conventions in HTML, which nothing validates and which Zotero 7's note editor can rewrite on any edit. Zotero's structured kind, the annotation, needs an attached file, which paper books don't have. |
| Import | One pass that reads the notes, plus a watch for new quote notes typed into Zotero later. The import never writes to Zotero. Each quote records the note it came from and that note's version. |
| Concept tags | Imported exactly as they appear on the notes. Nothing is removed or renamed without a person approving it. |
| Quoted text is protected | People edit quotes directly. Agents add quotes and change tags and comments, but changes to an existing quote's text or locator are proposals that a person approves. |
| Zotero copies | Optional and later: Quote MCP can write a read-only copy of each book's quotes into Zotero as child notes. A copy is never read back as data; an edit made to one becomes a proposal. |
| Corpus quotes | Quote MCP owns their content and tags too. corpus-mcp keeps what only it can do: checking text against a Calibre book and re-anchoring after scans. |
| Storage | SQLite (`quotes.db`), primary data from day one: a nightly online backup kept 14 days (corpus-mcp's pattern), Proxmox backups of the LXC, and a full JSON export. |
| Runtime | A second systemd service on the corpus-mcp LXC to begin with, on its own port, with its own Access application and claude.ai connector. It can move to its own LXC later without changes. |
| Language | TypeScript on Node 22. The Zotero Web API client comes from corpus-mcp's `src/zotero.ts`, either copied or moved into a shared package like `packages/citekey`. |

## Survey (Business collection, 2026-10-27)

40 quote notes read in full as HTML and about 80 more as previews, from about
70 of the collection's 308 items.

- **Usual form:** `<p><span class="quote" title="innovation"> "…" (p. 63) </span></p>`,
  about 90% of quote notes. Catalog notes ("Includes index", contents
  lists, "Originally published…") never have the span. One quote per note
  throughout.
- **Locators:** 22 of 40 have a page, written `(p. 63)` or `(p 169)`. Two have
  `(Kindle loc. 208-210)`. Three add a chapter author from an edited volume,
  as in `(p. 209, Richard L. Daft and Robert H. Lengel)`. About 13 have no
  locator; a few of those are web articles, most are books.
- **Tags:** note tags carry the concepts. The `title` attribute usually
  repeats them but can be incomplete (`title="environment"` on a note
  tagged `environment` and `innovation`). Some tags are compound
  (`fear, job loss`).
- **Variants:** the span written out as escaped text (`&lt;span…&gt;`); a
  quote that continues from the span into a `<ul>`; nested spans; a
  `<blockquote cite="…">` with no span; your comment followed by a quote
  broken with `<br />`; a missing opening quotation mark, or none at all;
  an empty note. Inside quotes: `<em>`, `<cite>`, `[Good bosses]`,
  `...`/`....`/`…` for cuts, and straight and curly quotes mixed.
- **OCR errors:** `over die next few years`, `a line line between`,
  `eEorts`, `showod`, `carefirlly`, `ot' self-esteem`, `can also he
  established`, `lleaders hesitate to team`. Some are non-words a
  dictionary catches; many are real words that need context.

Other collections may follow other conventions. Phase 0 surveys the whole
library before the parser is fixed.

## Data model

- **`quotes`:** id (Quote MCP's own, stable), Zotero item key, cached
  citekey and Calibre UUID when there is one, text (paragraphs and list
  items, emphasis kept), locator kind (`page`, `kindle`, `none`) and value,
  printed page label, chapter author, comment (your own words about the
  quote, kept apart from the quoted text), status, grade, flags, origin,
  and who created and last changed it, and when.
- **Status:** `transcribed` (typed or OCR'd, not checked against a text),
  `verified` (checked against a Calibre text by corpus-mcp, with an anchor),
  `unparsed` (imported but not yet split into fields by a person).
- **Origin:** `zotero-note` with the note key and version, `capture`,
  `agent`, `corpus`, or `zotero-annotation`. The origin is provenance, not a
  link that keeps syncing.
- **`quote_tags`:** quote, tag, and where the tag came from (`note`,
  `title`, `added`). The parent item's own tags, often Library of Congress
  subject headings, are read from Zotero as a separate book-level set for
  filtering and never mixed in. A taxonomy term id comes later.
- **`dismissals`:** quote, flag, reason, by, at. "Web article, no page" and
  "sic, as printed" stop a flag from coming back.
- **`proposals`:** quote, change (text, locator, chapter author, tags),
  rationale, evidence, proposer, status, reviewer.
- **`history`:** every change to every quote, before and after, who made or
  approved it, and why. This is the undo.

## Import

**Reading Zotero.** Quote MCP syncs incrementally by Zotero's library
version, as corpus-mcp's mirror does: `items?itemType=note&since=<version>`
for notes and the parent items they hang from. It keeps each note's raw HTML
and version, so a parser change re-runs locally without fetching anything
again, until a quote has been edited in Quote MCP.

**Forms the parser reads.**

1. The legacy span: `span.quote`, its `title` attribute, and anything up
   to the closing quotation mark and locator, including a list that follows
   it.
2. The legacy span written as escaped text. It is decoded once and then
   parsed as form 1.
3. A `<blockquote>`, with an optional locator in the paragraph after it.
4. A note whose text starts with a quotation mark and ends with a quotation
   mark and an optional locator. This is the form you get by typing a quote
   into a note by hand.

**Steps.** For each note:

1. Decode the escaped span if present.
2. Classify the note: quote, catalog note, empty, or unclear. Catalog notes
   are skipped and counted.
3. Extract the quote body, keeping paragraphs, list items, and emphasis.
   Strip the outer quotation marks, and record whether either was missing.
4. Read the trailing locator: page, page range, roman numerals, `p` without
   a period, Kindle location, and an optional chapter author after a comma
   or semicolon.
5. Collect tags: the note's tags, plus the `title` attribute split on
   commas, kept with origin `title`.

**Grades.**

| Grade | Meaning | Where it goes |
|---|---|---|
| A | Clean: recognised form, balanced quotation marks, no flags except a missing locator | Imported and searchable |
| B | Extracted with flags (below) | Imported and searchable; flags feed worklists |
| C | Not parsed with confidence: commentary mixed in, several quotes suspected, no recognisable structure | Imported as `unparsed`, out of search until a person splits it |

Grades A and B are the easily extractable quotes, all searchable and
citable from phase 1. A citation for a quote without a locator says so,
rather than inventing one.

**Flags.** `no_locator`, `kindle_locator`, `chapter_author`, `ocr_suspect`,
`unbalanced_quotes`, `list_quote`, `title_tag_only` (a `title` term missing
from the note's tags), `compound_tag`, `commentary_mixed`, `long` (over
2,000 characters; allowed, but worth a look).

**OCR detector.** A first pass needs no model. It flags tokens that are
not in a dictionary (Hunspell en_US, plus an allowlist built from creators,
titles, and existing quotes) and that match common OCR confusions: `rn`↔`m`,
`li`↔`h`, `cl`↔`d`, `e`↔`c`, `f`↔`t`, capitals inside a word (`eEorts`),
punctuation inside a word (`ot'`), and repeated words (`line line`). Real-word
errors (`die` for `the`, `he` for `be`) need context, so a model pass in
phase 2 handles them.

**After the import.** Zotero notes aren't modified. Quote MCP keeps watching
notes for two cases:

- *A new quote note* (one it hasn't imported) is imported as a new quote,
  so typing a quote into Zotero keeps working.
- *An imported note that changed* in Zotero produces a proposal showing the
  difference, rather than changing the quote silently.

## Repairing quotes

Repairs are ordinary edits to Quote MCP records, kept in history.

| Class | Examples | Who decides | How it's applied |
|---|---|---|---|
| Tag hygiene | Add `title`-only terms; split compound tags; merge near-duplicates (`work-life balance`, `work life balance`) | Rules propose. A person approves each kind of change once, for all the quotes it affects. | Batch, from a preview |
| Evidence-backed | A page or the correct wording, found in a Calibre copy of the same book | The source text. A person spot-checks and approves in bulk. | Proposals queue; the quote becomes `verified` |
| Judgement | A missing page for a paper book; real-word OCR errors without a source; a chapter author; splitting an `unparsed` note | A person. An agent may propose. | Edit directly, or approve a proposal |

**Calibre-backed repairs.** Where a quote's book is also in Calibre (linked
through `Calibre UUID:` in the Zotero item's Extra, as corpus-mcp's mirror
does), corpus-mcp finds the passage. That gives the printed page and the
book's exact wording, which fixes OCR errors with evidence. corpus-mcp
needs a small read-only verify endpoint for this (book, text, optional page
→ match with anchor, or the closest passages), using the same check
`save_quote` uses.

**Shelf sessions.** Missing pages and wording checks for paper books need
the physical book. The by-book worklist lists books by how many of their
quotes need it. A book's page shows every quote that needs a page or a
check, in reading order where that's known. It's laid out for a phone, so
you can work with the book in hand and fix all of its quotes at once.

**OCR proposals by an agent.** An agent takes `ocr_suspect` quotes with the
flagged tokens and the book's metadata, and proposes corrections with a
confidence and a reason for each. If you can't check the book, you can
still accept a correction marked as conjectural. You can also dismiss the
flag as "sic, as printed", which stops it from being re-flagged.

**Surfaces.**

- *Admin pages:* the queues (one per flag, plus `unparsed`), the by-book
  view, and a quote page with the source note, the fields, flags, history,
  and any proposal as a diff, with buttons to accept, edit, reject, or
  dismiss.
- *MCP tools* for agents: `quote_worklist(queue, book?)` and
  `propose_quote_fix(quote, text?, locator?, chapter_author?, rationale,
  evidence?)`.
- *CLI:* `survey` (read-only report), `import`, `reparse` (re-runs the
  parser on quotes nobody has edited yet), and `export`.

## Adding quotes

| Where you are | How | Status |
|---|---|---|
| At the shelf, phone or any browser | Quote MCP's capture form: find the book by title, citekey, or ISBN; paste the text (the phone's camera text recognition works well for this); add the page and tags, with tags suggested as you type. The OCR detector runs before saving and highlights suspect words. | `transcribed` |
| A conversation with Claude | `add_quote(book, text, locator, tags, comment?)`, with the same checks | `transcribed` |
| Zotero desktop | Type a note in form 4 (`"…" (p. 63)`) with concept tags as note tags. The watch imports it. | `transcribed` |
| A Calibre book | `add_quote` with the Calibre book; Quote MCP asks corpus-mcp to check it | `verified` |
| A PDF or EPUB attached in Zotero | A highlight annotation with tags, imported with its page label | `transcribed` |
| A book not yet in Zotero | Filed first into `Corpus MCP/Staging`, the way the cited-article skill files books, then the quote is added | as above |

New tags reuse an existing tag's spelling, ignoring case, the same rule
corpus-mcp's quotes use, so one concept keeps one name.

## Citing

`cite_quote` returns the quote text, its locator, and the book's CSL JSON
from Zotero (by item key), with the chapter author given where there is
one. A Calibre book not yet in Zotero is cited through corpus-mcp's
`cite_passage` data until it's filed.

## Zotero copies (optional)

For browsing quotes from inside Zotero, Quote MCP can write one read-only
child note per book listing its quotes:

```html
<h2>Quotes (managed by Quote MCP; edit at https://…/quotes/book/ITEMKEY)</h2>
<blockquote><p>Innovators rarely find support within mainstream organizations, …</p></blockquote>
<p>(p. 63) · innovation</p>
```

- One note per book, not per quote, so the copies don't double the number of
  notes; tagged `quote-mcp:copy` so the watch skips them.
- Rewritten when the book's quotes change, with `If-Unmodified-Since-Version`.
  If the copy was edited in Zotero, Quote MCP turns the edits into proposals
  before rewriting it.
- The format uses only elements Zotero 7's note editor keeps, so test it in
  the editor first.

## Corpus quotes

corpus-mcp's quotes split along what each service is for:

- **Quote MCP** owns the record: text, locator, comment, tags, history.
- **corpus-mcp** keeps the *anchor*: Calibre UUID, offsets, prefix and suffix,
  file hash, and `verified` or `orphaned`. It re-anchors after scans, as it
  does today, and publishes anchor changes as a feed that Quote MCP reads to
  update a quote's status.

The migration moves corpus-mcp's quote content and tags into Quote MCP,
leaves the anchors behind with the new quote ids, and turns corpus-mcp's
quote tools into calls to Quote MCP or retires them. The reader view keeps
highlighting quotes from the anchors.

## Concept tags

- A tag report lists counts and likely duplicates (case, plurals, hyphens)
  as merge proposals.
- Searches combine tags with authors, books, and book-level subjects.
- Later: map tags to living-taxonomy term ids in `quote_tags`, without
  renaming them. This joins quotes to the same keys as Calibre tags and
  Concept Clusters subcategories (see PLAN.md, *Living taxonomy*).

## Phases

0. **Survey.** A CLI runs the parser over every note in the library through
   the Web API and reports counts by form, grade, and flag, with examples of
   each and a tag inventory. No service and no writes. The phase is done
   when the parser rules are fixed and grade C is small enough to work
   through by hand.
1. **Import and search.** The store and its backups, the import and the watch,
   full-text search, `search_quotes`, `get_quote`, `cite_quote`, `export`,
   and the worklists as pages. Every grade A and B quote is imported. Zotero
   stays read-only.
2. **Repair.** Editing and history on the admin pages, proposals,
   tag hygiene, the corpus-mcp verify endpoint, the OCR detector's agent
   pass, and shelf sessions.
3. **Capture.** The capture form and `add_quote`, filing new books into
   staging (the first Zotero writes), and Zotero annotations as a source.
4. **Zotero copies.** The read-only book notes.
5. **Corpus quotes.** The anchor split and migration described above.

## Open questions

- **Write access.** Phase 3 needs a Zotero key with write access, which can
  write any item, not only staging. Is that acceptable, or should new books
  go through the Zotero MCP server instead?
- **Legacy notes.** Once a book's quotes are repaired, keep its original
  notes as they are, or let Quote MCP replace them with its copy note?
- **Libraries.** The personal library only, or group libraries too?
- **Kindle locations.** Keep them as a locator kind, and re-locate them when
  the book reaches Calibre? They can't be converted to pages reliably.
- **Hosting and name.** The corpus-mcp LXC, or a new one; "Quote MCP" or
  something else.
