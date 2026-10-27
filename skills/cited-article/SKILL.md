---
name: cited-article
description: Write a short article or essay that quotes books from the Calibre libraries through the Corpus MCP tools, for any writer, not only editors. Each passage is saved as a verified quote and cited with a footnote; books not yet in Zotero are filed to a staging collection. Hands over an editable Markdown source and a formatted copy anyone can read. Use when asked to write, outline, check, or format a piece that quotes or cites books in the corpus, such as "write a short piece quoting my books on X".
---

# Cited article

The agent finds, checks, files, drafts, and formats. The human picks the
passages, edits the prose, and publishes. Two files come out:

- `<slug>.md`, the **source**: Markdown with citekeys (`[@key, chap. 2]`)
  that Pandoc formats. This is the file to edit.
- `<slug>.formatted.html` (and any other formats asked for), the
  **formatted copy**: the same piece with citations and a reference list
  written out. This is the file to read and share. The agent makes it again
  after every change.

Don't assume the human knows Pandoc, citekeys, or BibTeX. Explain them in
plain words when they come up, and run every command yourself.

## Switches

Read switches from the arguments as `name=value`; anything else in the
arguments is the brief. Defaults:

| Switch | Default | Values |
|---|---|---|
| `draft` | `full` | `full`: finished prose. `outline`: headings, placed quotes with citations, and bullet notes on what each section argues; no prose. |
| `file` | `auto` | `auto`: file books that are not in Zotero into the staging collection. `ask`: show the BibTeX and wait for the human to file them. `off`: don't file; keys stay unpinned. |
| `staging` | `Corpus MCP/Staging` | Zotero collection path for newly filed books. |
| `bib` | `generate` | `generate`: write `references.bib` beside the draft. A path: use that file and only check it. |
| `project` | the draft's slug | Quote tag, saved as `project:<value>`. |
| `candidates` | `5` | Passages to offer at the gather checkpoint. |
| `dir` | `drafts/<slug>/` | Where the draft goes: `<slug>.md` and `references.bib`. Without a `drafts/` folder in the working directory, use the session's scratchpad (or a temporary folder) and say where. |
| `render` | `html` | Formats of the formatted copy, comma-separated: `html`, `md`, `docx`, `epub`, or `none`. A draft path instead: run only Verify and Format on it (for "check and format my draft"). |
| `verify` | — | A draft path: run only Verify on it. |

## Phases and checkpoints

Stop at each **checkpoint** and wait for the human, unless they have already
answered it (for example by naming the passages to use).

### 1. Brief

Settle the topic or argument, audience, and length (default 600–900 words).
Ask only about what the arguments leave open. Pick a short slug.

### 2. Gather

`search_corpus` with several phrasings, then `read_book` around the best hits
until each passage's sentence boundaries and context are clear. Offer
`candidates` passages, each with: the book, its chapter (`section`) or printed
page, the passage, a line of context either side, and why it fits.

**Checkpoint: the human chooses passages** (or asks for more, or brings their own).

### 3. Secure

For each chosen passage:

1. `save_quote` with the book id, the start page `read_book` reported, the
   text, `labels: ["project:<project>", <themes>]`, and a note on its role in
   the piece. If it isn't found, use the closest passages returned; never
   save altered text.
2. `cite_quote` with the quote id. Keep `quote` (the prose text to put in the
   draft), `csl`, `position`, `citekey`, `proposed_citekey`, `bibtex`, `isbn`,
   `zotero`, and `warnings`.
3. Settle the citekey (below).

#### Citekeys and Zotero filing

- **Pinned** (`citekey` is set): use it.
- **In Zotero, not pinned** (`zotero` is set, `citekey` is null): read the
  item's key (`zotero_get_item_metadata` format `json`: `citationKey`, or a
  `Citation Key:` line in `extra`) and `pin_citekey`.
- **Not in Zotero** — by `file`:
  - `auto`:
    1. Look first: `zotero_search_items` for the title and first author. The
       Corpus mirror syncs every 30 minutes, so `zotero: null` may be stale.
       If there's a match, treat it as "in Zotero".
    2. File: `zotero_add_item` with `source` = the `bibtex` (add
       `isbn = {…}` when `isbn` is set; never use `isbn_candidates`),
       `source_type: "bibtex"`, `collections: [<staging>]`,
       `create_missing_collections: true`, `tags: ["corpus-mcp"]`, plus
       `corpus-mcp:needs-review` when `warnings` mention missing metadata.
    3. Check: `zotero_get_item_metadata` format `json`. Corpus matches books by
       a `Calibre UUID: <uuid>` line in `extra` (the uuid is in the BibTeX
       `note`); if it's missing, add it with `zotero_update_item`, keeping
       what `extra` already has.
    4. `pin_citekey` with the item's key. If no key was kept, pin
       `proposed_citekey` and set it on the item with `zotero_update_item`
       `fields: {citation_key: …}`.
    5. If writing fails, call `zotero_write_capabilities`, report what it
       says, and continue as `ask`.
  - `ask`: give the human the BibTeX for each book and wait. Then look the
    book up again and continue as "In Zotero, not pinned".
  - `off`: use `proposed_citekey` and list it under `corpus-unpinned` in the
    draft's front matter.

Never move items out of staging, delete Zotero items, or replace a pinned key
(`pin_citekey` `replace`). Moving items out of staging is the human's review step.

### 4. Draft

Start from [template.md](template.md). Rules:

- **Quotes.** Put `<!-- corpus:quote <id> -->` on the line before each block
  quote. Use `cite_quote`'s `quote` text unchanged, wrapped across `>` lines;
  a `\n\n` in it is a paragraph break (`>` on an empty line). End the block
  with the citation. Run-in quotes (inside a sentence) must also be saved
  quotes, with the marker just before the paragraph.
- **Citations.** `[@key, <locator>]`. PDFs: `p. <page_label>` (or the CSL
  `locator`). EPUB and MOBI: `chap. <n>` from `position.section`, never a
  location number. When the book is a collection ("Complete Works"), name the
  work in the prose or the footnote, since the citation names only the book.
- **Footnotes.** One for each quote, for the reader: the work, chapter or
  page, edition, and anything an editor should know (such as "EPUB: cited by
  chapter"). Keep Corpus ids out of footnotes; the marker carries them.
- **Front matter.** `title`, `bibliography: references.bib`,
  `link-citations: true`, and `corpus-project: <project>`. Add
  `corpus-unpinned: [keys]` only when some keys aren't pinned.
- **Bibliography.** With `bib=generate`, write `references.bib` from each
  book's `cite_quote` `bibtex` (call it again after pinning so the entry
  carries the pinned key), one entry per book. With a path, leave the file alone.
- **Outline** (`draft=outline`): the same front matter, headings, markers,
  quotes, and citations, with bullet notes in place of prose.

Then run Verify and Format, and hand over:

- where both files are, with the formatted copy named first as the one to read
- its quotes: book, chapter or page, and citekey
- what was filed to Zotero staging, and anything there that needs review
- any unpinned keys
- how to edit, in plain words: "Edit `<slug>.md`. The bracketed codes such as
  `[@key, chap. 2]` link each quote to its book, so leave them in, and don't
  change the words inside quoted passages. Everything else is yours. When
  you're done, ask me to check and format the draft."

**Checkpoint: the human edits the draft.** They may cut, move, or reword
anything except quoted text. To shorten a quote, save the shorter passage as
a new quote and swap the marker.

### 5. Verify

Run it after drafting, when asked, or with `verify=<path>`:

1. For each marked quote, `get_quote` and collect `{ "<id>": prose }` into a
   JSON file in a scratch directory. An `orphaned` status is a problem to
   report.
2. Run `node <skill dir>/check-draft.mjs <draft.md> --quotes <file.json>`. It
   compares each marked block quote with the saved prose (ignoring line
   wrapping), finds block quotes without markers, checks every citekey
   against the bibliography and `corpus-unpinned`, and builds with
   `pandoc --citeproc` to collect its warnings. It prints JSON and exits 1
   when something is wrong.
3. Report problems in plain words, not the JSON: "Quote 2 no longer matches
   the book: the draft says '…most honourable…' where the book says '…most
   respectable…'", "The citation `[@nobody2020]` doesn't match any book in
   the bibliography". Don't fix quoted text yourself: say where a quote
   differs from its source and let the human decide.

### 6. Format

After every draft, and on `render=<path>`, write the formatted copy in each
`render` format beside the source, in the draft's folder (skip this with
`render=none`). Set `lang` to the piece's language (`en` unless it's written
in another):

- `html` (the default): `pandoc <slug>.md --citeproc -s -M lang=en -o <slug>.formatted.html`.
  One self-contained page, readable in any browser and by screen readers:
  it declares its language, and its footnotes and reference list are
  marked up as such.
- `md`: `{ echo "# <title>"; echo; pandoc <slug>.md --citeproc -M link-citations=false -t gfm-raw_html; } > <slug>.formatted.md`.
  Plain Markdown that GitHub and other Markdown viewers show with
  citations, footnotes, and references in place.
- `docx`: `pandoc <slug>.md --citeproc -M lang=en -o <slug>.formatted.docx`, for Word.
- `epub`: `pandoc <slug>.md --citeproc -M lang=en -o <slug>.formatted.epub`, for e-readers.

Add `--csl <style.csl>` when the human names a citation style; otherwise
Pandoc uses Chicago author-date, which leaves "p." out of page citations.

**Without Pandoc** (claude.ai, or a machine without it): write the formatted
copy yourself, as HTML (or Markdown when that's the only format asked for),
replacing each citation with author, year, and locator in parentheses, and
adding a References list from each book's CSL item. Say that it hasn't been
checked against a citation style. Docx and EPUB need Pandoc.

The formatted copy is made from the source and replaced every time, so edits
to it are lost. If the human edited it, carry those edits into the source
before formatting again.

**Checkpoint: the human publishes** the formatted copy, or asks for another
format or citation style. The agent doesn't publish.

## Cleaning up

A piece's quotes are `search_quotes` with `label: project:<project>`. Delete
them (`delete_quote`) only when the human asks.
