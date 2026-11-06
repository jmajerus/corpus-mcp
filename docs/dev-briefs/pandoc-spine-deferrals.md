# Investigation of navigation targets outside the linear spine

The navigation-adapter survey completed 306 records on 2026-11-06: 168 converted, 115 deferred,
and 23 failed. This investigation covers the 71 deferrals reported as targets outside the linear
XHTML spine; it does not classify the other deferrals or the timeouts.

## Findings

| Cause of first reported deferral | Books | Evidence |
| --- | ---: | --- |
| Auxiliary cover document marked `linear="no"` | 63 | Target exists in the archive, manifest, and spine; Pandoc omits it from primary reading content. |
| Referenced document absent from archive | 8 | Literal TOC/NCX path is absent; no same-basename or case-only match, and no base-URI override. |

Of the 63 auxiliary documents, 62 are explicitly identified as covers by package guide or body
semantics. The remaining document (`main:153`) contains no body text and one image that matches
the package-declared cover image. All 63 books have exactly one auxiliary document referenced by
their TOC; their other TOC document paths belong to the linear spine. This path-level check does
not establish that every remaining fragment will resolve to a readable Pandoc location.

This is a normal EPUB structure. The [EPUB specification](https://www.w3.org/TR/epub-33/#sec-itemref-elem)
defines `linear="no"` as auxiliary content and requires a means of reaching it, including through
navigation. [Reading systems may skip it during sequential reading](https://www.w3.org/TR/epub-rs-33/#sec-spine).
Our adapter filters these documents out of its primary spine and then requires their TOC targets
to resolve within that filtered spine. The resulting cover deferrals reflect that policy conflict.

A synthetic two-document EPUB reproduces the behavior: Pandoc's native AST includes the primary
chapter's spine marker but omits the non-linear cover marker, and our adapter defers the book even
though the primary chapter is present. No private book data was needed for this reproduction.

The eight absent-target books are `main:147`, `main:101`, `main:102`, `main:133`, `main:149`,
`main:160`, `main:134`, and `main:155`. All eight already have unresolved outline entries in the
legacy index: seven have one unresolved entry each, and `main:101` has 20. The inspected links
therefore expose existing navigation defects rather than a new Pandoc path-resolution difference.
No filename repair or first-match substitution was attempted.

## Cover correction (adapter revision 3)

The adapter now handles positively identified auxiliary covers separately from primary chapter
navigation. It preserves their TOC label/nesting with a null reading location and records the cover
evidence. Every primary chapter target must still resolve; unidentified auxiliary content, absent
cover resources, broken fragments, and genuinely missing targets remain deferred. This refines the
earlier "every target must have a reading location" policy for known auxiliary resources.

Twelve focused cover/deferral/staging checks passed, together with typecheck and build. The full
suite and another whole-library survey were explicitly skipped for the requested direct deployment.

Revalidate the affected books after that change, since the first deferral may have masked additional
fragment/location issues. The eight books with absent resources remain deferred for separate
source/navigation repair. This investigation does not activate any extraction candidates or change
the source EPUBs, active index, or quote data.

## Evidence retained on the indexing host

Detailed per-book metadata reports are private to corpus-mcp.localdomain:

- `/var/lib/corpus-mcp/validation/pandoc-navigation-final-20261106/spine-deferral-analysis.json`
- `/var/lib/corpus-mcp/validation/pandoc-navigation-final-20261106/spine-deferral-details.json`
- `/var/lib/corpus-mcp/validation/pandoc-navigation-final-20261106/auxiliary-cover-confirmation.json`

The reports were built by reading package, spine, TOC/NCX, guide, and cover metadata in place.
No source EPUB or book prose was transferred off the server.
