# On Curiosity

`/cited-article file=auto On curiosity, quoting a book not yet in Zotero`

- [on-curiosity.md](on-curiosity.md) is the draft as the skill hands it over: Pandoc
  citekeys, a `<!-- corpus:quote <id> -->` marker before each block quote, and footnotes
  for the reader. [on-curiosity.rendered.md](on-curiosity.rendered.md) is the same draft
  after `pandoc --citeproc`.
- The quotes cite two EPUBs by chapter (`chap. 3`, `chap. 4`) and a PDF by its printed
  page (`p. 211`, physical page 237). None of the three books was in Zotero: the skill
  filed them to a staging collection and pinned their citekeys.
- Quote 4 keeps the book's small capitals ("EACH OF US HAS A DEEP DESIRE TO know"),
  because quoted text stays as the book prints it.
- [quotes.json](quotes.json) is the saved text of each quote. The test suite runs
  `check-draft.mjs` against it.
