# @jmajerus/citekey

Citekeys from [CSL JSON](https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html) items by a
configurable rule in the manner of Better BibTeX: an author part, a year, and significant title words.
Pure ESM, no dependencies. A key from here is a proposal; the project that files the work decides the
final key, including any a–z suffix that keeps keys unique.

## Install

From a GitHub release (npm can't install a git subdirectory):

```bash
npm install https://github.com/jmajerus/corpus-mcp/releases/download/citekey-v1.0.0/jmajerus-citekey-1.0.0.tgz
```

## Use

```js
import { proposeCitekey, citekeyWellFormed, presets } from "@jmajerus/citekey";

const item = { title: "The Future of Power", author: [{ family: "Nye", given: "Joseph S., Jr." }], issued: { "date-parts": [[2011]] } };
proposeCitekey(item);                  // "nye2011future"     (preset "author-year-word", the default)
proposeCitekey(item, "bbt-default");   // "nyeFuturePower2011"
proposeCitekey(item, { titleWords: 2, separator: "_" }); // options over "author-year-word": "nye_2011_futurepower"
citekeyWellFormed("nye2011futurea", item); // true: the rule's shape, with an optional a–z suffix
```

## Rule

- **Author:** the first author's family name (else the first editor's), lowercased and
  ASCII-folded (ligatures written out: "æ" → "ae"); hyphens are kept. An organization (`literal`)
  becomes its acronym when that stays at four letters or fewer ("U.S. Geological Survey" → `usgs`),
  else its first two significant words (`ussenate`); an all-capitals publisher is taken as its short
  name (`nist`). With no names, the publisher, less a trailing "University" or "Press".
- **Year:** the first four-digit year in `issued`.
- **Title:** the first significant words, split on spaces, en and em dashes, slashes, and colons;
  hyphenated words stay whole. Better BibTeX's skip words are skipped, and so is a word equal to the
  author part.

## Options

| Option | `author-year-word` | `bbt-default` | Meaning |
|---|---|---|---|
| `order` | author, year, title | author, title, year | Parts, in order |
| `institution` | `acronym` | `words` | An organization's key part |
| `publisherFallback` | true | false | Use the publisher when there are no names |
| `titleWords` | 1 | 3 | Significant title words; 0 for none |
| `titleCase` | `lower` | `capitalize` | `future` or `FuturePower` |
| `skipWords` | `bbt` | `bbt` | Better BibTeX's list, or your own |
| `skipAuthorWord` | true | false | Skip a title word equal to the author part |
| `separator` | `""` | `""` | Between parts |

`bbt-default` approximates Better BibTeX's default formula, `auth.lower + shorttitle(3,3) + year`.
Better BibTeX's own name and title handling has cases it does not reproduce, so prefer a key Better
BibTeX assigned when you have one.

## Cases

[`cases.json`](cases.json) (also exported as `@jmajerus/citekey/cases.json`) holds the rule's test
cases: a CSL input, a preset, and the expected key. A rule change ships as a new release.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md), as for corpus-mcp.
