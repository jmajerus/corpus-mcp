# On Curiosity

`/cited-article file=auto On curiosity, quoting a book not yet in Zotero`

**Read it:** [on-curiosity.rendered.md](on-curiosity.rendered.md), the draft after
`pandoc --citeproc` (Chicago author-date, Pandoc's default style).

**Edit it:** [on-curiosity.md](on-curiosity.md), the draft as the skill hands it over. It
shows raw citekeys such as `[@hanh2007fidelity, chap. 4]` and a hidden
`<!-- corpus:quote <id> -->` marker before each block quote. That's on purpose: editors
work on this version, and Pandoc formats the citations when it's exported.

- The quotes cite two EPUBs by chapter (`chap. 3`, `chap. 4`) and a PDF by its printed
  page (`p. 211`, physical page 237). None of the three books was in Zotero: the skill
  filed them to a staging collection and pinned their citekeys.
- Quote 4 keeps the book's small capitals ("EACH OF US HAS A DEEP DESIRE TO know"),
  because quoted text stays as the book prints it.
- [quotes.json](quotes.json) is the saved text of each quote. The test suite runs
  `check-draft.mjs` against it.
