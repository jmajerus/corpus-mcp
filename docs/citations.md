# Citations, citekeys, and quotes

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

## Citekeys

Every book gets a proposed citekey (author + year + first significant title
word, as in `nye2011future`), built from its Calibre metadata by
[`@jmajerus/citekey`](../packages/citekey), a Better BibTeX–style rule packaged
for reuse (other projects install it from a GitHub release). The preset is
`CORPUS_CITEKEY_PRESET`: `author-year-word` (the default) or `bbt-default`.

To file a cited book in a reference manager, `cite_passage` returns a BibTeX
`@book` entry built from Calibre's own metadata (`bibtex`) and the book's
ISBN when it passes its check digit (`isbn`). The project that files the book
assigns the final key; `pin_citekey` (or a book's admin page) then stores it
against the book's Calibre UUID. Any BibTeX-safe key is accepted and kept as
given; one that doesn't follow this server's rule gets a warning. A pinned key
never changes on its own and is accepted anywhere a book id is. A `citekey`
identifier set in Calibre takes precedence over a pinned key.

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
- **Duplicates:** other items with a matched book's title (ignoring a
  subtitle), first author, and year are listed as possible second copies.
- **Citing:** `cite_passage` and `cite_quote` add `zotero` (the matched item)
  and warn before filing a book that is already there.
- **Setup:** make a key with read-only library access at
  zotero.org/settings/keys, put `CORPUS_ZOTERO_LIBRARY=users/<id>` and
  `CORPUS_ZOTERO_API_KEY` in `.env`, and run `npm run deploy -- --zotero`.

## Quotes

Quotes are passages saved from the books, by agents (`save_quote`) or by
people (select text in a book's [reader](admin-ui.md#reading-and-saving-quotes-adminbooksidread)).
Either way, the passage is checked against the book's text. Quote marks, dashes,
spacing, case, and a page break inside the passage may differ; what's stored is
the book's exact wording. A passage that isn't in the book isn't saved, and the
closest passages are returned instead.

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
