# On Curiosity

`/cited-article file=auto On curiosity, quoting a book not yet in Zotero`

**Read it:** the finished piece, with citations, footnotes, and references written out
(Chicago author-date style):

- **[Read it here](on-curiosity.formatted.md)**, as Markdown that GitHub displays.
- To download: [HTML](on-curiosity.formatted.html), the skill's default format, to open
  in a browser (GitHub shows HTML as code), or [Word](on-curiosity.formatted.docx).

**Edit it:** [on-curiosity.md](on-curiosity.md), the source the formatted copy is made
from. Its bracketed codes, such as `[@hanh2007fidelity, chap. 4]`, link each quote to its
book, and a hidden `<!-- corpus:quote <id> -->` marker before each block quote links it to
the saved passage. The skill turns the codes into citations each time it formats the piece.

- The quotes cite two EPUBs by chapter (`chap. 3`, `chap. 4`) and a PDF by its printed
  page (`p. 211`, physical page 237). None of the three books was in Zotero: the skill
  filed them to a staging collection and pinned their citekeys.
- Quote 4 keeps the book's small capitals ("EACH OF US HAS A DEEP DESIRE TO know"),
  because quoted text stays as the book prints it.
- [quotes.json](quotes.json) is the saved text of each quote. The test suite runs
  `check-draft.mjs` against it.
