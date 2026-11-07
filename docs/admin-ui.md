# Using the admin pages

The admin pages are corpus-mcp's web interface, served by the corpus server
at `/admin`. They show the current state of the corpus, and anything an MCP agent
can change, a person can change here too. Every page shares one navigation bar:
Dashboard, Books, Quotes, Categories, Taxonomy, Citekeys, Zotero, Proposals,
Shelves, Jobs, Changes, and About.

## Where to find them

The admin pages, and everything they change, live on the corpus server on
your LAN. There are two ways to reach them, both to the same server and data:

| Address | From | Editing |
|---|---|---|
| `http://corpus-mcp.localdomain:8000/admin` | Home, on the LAN | Yes, recorded as `CORPUS_LAN_ACTOR` |
| `https://corpus-mcp.majerus.us/admin` | Anywhere, through a Cloudflare tunnel and an Access sign-in | Yes, recorded as your Access email |

`/` on either address opens the dashboard. The public catalogue is something
else: a published copy, at its own address and read-only (see
[The public catalogue](public-site.md)).

## Signing in

The top right of every page says who your changes are recorded as:

- **On the LAN, as you@example.com**: you're on the LAN directly. The name is
  the server's `CORPUS_LAN_ACTOR`, and every button works.
- **Signed in as you@example.com**: you came through Cloudflare Access, and
  every button works.
- **Read-only**: you came through Cloudflare without an Access sign-in, or LAN
  editing is turned off (`CORPUS_LAN_EDITS=off`). Hover over it for the reason.
  You can browse everything, but editing buttons are disabled.

Every change is recorded with that name, on the [Changes](#changes) page and
wherever the change shows up.

## Dashboard (`/admin`)

The dashboard is the place to start. Along the top, a strip shows the
neighbouring services (green when they answer, with response times) and the
running corpus-mcp version. It refreshes every 30 seconds.

**Corpus cards.** Each number links to the books or page behind it:

| Card | What to look for |
|---|---|
| Books indexed | Counts by format, plus books that failed, have no text layer, or have no outline |
| Categories | Uncategorized books, proposals pending, approved sets not yet in Calibre, suspect tags |
| Citekeys | Pinned keys, books ready to file, books blocked from a key |
| Quotes | A link to quote-mcp's admin pages, where quotes are kept |
| Zotero | Books found in Zotero, possible matches, citekey mismatches, possible duplicates |
| ISBNs | Books whose only ISBN is printed inside them |
| Years | Books whose only publication year is printed on their copyright page |
| Authors | Books with no author in Calibre whose pages print one, books with none found, books with several people in one author record, and titles that are file names |
| Last refresh / Last pull | When the index was rebuilt and Calibre last copied; amber when stale |
| Data / Disk free | Database sizes, backups (amber when the newest is over 36 hours old), free space |

Amber and red numbers are the ones that need attention.

**Actions.** One card per job:

| Job | Runs as |
|---|---|
| Refresh now (pull from Calibre-Web, then index) | Run at once; normally every 10 minutes on a timer |
| Back up data.db | Run at once |
| Apply approved tags to Calibre | Preview, then apply |
| Remove non-subject tags from Calibre | Preview, then apply; type extra tags to remove in the box |
| Add EPUBs for MOBI/AZW3/KFX-only books | Preview, then apply |
| Sync from Zotero now | Run at once; normally every 30 minutes |

Starting a job opens its page. Below the actions are the recent jobs and the
refresh history.

## Changing Calibre: preview, then apply

Jobs that change Calibre never run directly:

1. Press **Preview**. The job page lists every book that *would* change, with
   tags to add (+) and remove (−).
2. Read the list. If it's right, press **Apply this preview** and confirm.
3. The apply runs exactly that list, nothing newer. It backs up Calibre's
   `metadata.db` first and refreshes the index afterwards.

A preview with nothing to do says *Nothing to apply*. An applied job links to
its entries in the change log.

## Books (`/admin/books`)

Every book in the index. Search by title, author, id, ISBN, or citekey, and
narrow by library, shelf, or category/tag. Sort by title, newest, or Calibre id.
The filter buttons below the search (Categories, Citekey, ISBN, Problems,
Format, Status) show counts; press one to filter, press it again to clear.

Each row shows badges for the book's state. Every badge has a sign as well as a
colour:

- **Categories:** ○ Uncategorized · ? Proposal pending · ↻ Approved, not in Calibre · ✓ Categorized
- **Citekey:** ✓ Set in Calibre · ✓ Pinned · → Ready to file · ! Blocked
- **ISBN:** ✓ ISBN · ! Invalid ISBN · ? Printed ISBN only · ○ No ISBN
- **Problems:** ! Extraction failed · ! No readable file · ! No text layer · ○ No outline

The URL keeps your filters, so a filtered list can be bookmarked or shared.
The dashboard's links are such URLs.

## A book's page (`/admin/books/<id>`)

Everything about one book, with **Read** and **Open in Calibre-Web** links at
the top.

**Categories.** Shows the book's categories in Calibre, any pending agent
proposal and its rationale, and an editor:

1. Under **Set categories**, remove a category with × or type one (title or slug;
   suggestions appear) and press **Add**. Only vocabulary terms are accepted.
2. Press **Save**. This records the set as the book's approved, *complete* set.
   Calibre doesn't change yet.
3. The card now lists what Calibre lacks (+) and has extra (−). Press **Preview
   and apply this book** to run the tags job for this book alone.

**Citekey.** Shows the key's state, any key set in Calibre, the pinned key, the
proposed key, and what blocks one (no author, no year, an author record naming
several people). Under **Pin a citekey**, enter the key the book got in your
reference manager and press **Pin** (or **Replace**). **Unpin** removes it.

The **Zotero** row shows the matched Zotero item, and how it matched. When a
Zotero item only *looks* like this book, press **This book** to link it (which pins
its citekey if the book has none) or **Not this book** to dismiss it.

The other cards show shelves and non-vocabulary tags (⚠ marks tags the cleanup
job would remove), ISBNs (including ones printed in the book), the publication year and the title
page (the years, authors, and title the book prints, where each was found), the file, and the
outline. At the bottom are a link to the book's quotes in quote-mcp (found by
its Zotero item, or by its title when it has none) and its recent changes.

## Reading and saving quotes (`/admin/books/<id>/read`)

The reader shows the book four pages at a time. Use **Previous**/**Next**, type a
page number, or pick a chapter. Each page's heading gives its printed page label
and section. For EPUB and MOBI books the numbers are *locations*, reading
positions rather than page numbers.

The book's quotes, kept in quote-mcp, are highlighted; hover over one for its
comment and tags. Click a highlight to open that quote in quote-mcp's admin
pages, where it can be edited or deleted. A quote anchored on an earlier file of
the book isn't highlighted until its place is found in the new one.

To save a quote:

1. Select a passage (up to 2,000 characters; it may cross pages).
2. In the bar that appears, add an optional note and tags. Typing a tag
   suggests the ones on this book's quotes, so a theme keeps one spelling.
3. Press **Save as quote**.

The quote is saved in quote-mcp, recorded under your name, after it's checked
against the book here. Small differences in quote marks, dashes, spacing, or
case are fine, and the book's exact wording is stored. If the passage isn't
found, nothing is saved, and the bar tells you which pages were closest.
Pressing **Save** again for the same selection doesn't save it twice.

## Quotes

Quotes are kept in quote-mcp. The **Quotes** item in the menu opens its admin
pages: `quote-mcp.localdomain:8000/admin/quotes` on the LAN, or
`quote-mcp.majerus.us` when this page came through the tunnel. Search, edit,
and delete quotes there.

## Proposals (`/admin/proposals`)

Category sets proposed by agents through `propose_tags`, in three tabs: Pending,
Approved, Rejected. Each card shows the book, its shelves and current tags, the
agent's rationale, the proposed set, and what approving would change in Calibre.

- Edit the set with × and **Add**, then **Approve**. The approved set becomes
  the book's complete set of categories.
- **Reject** dismisses the proposal.
- **Reopen**, on an approved or rejected proposal, sends it back to Pending.

Approving doesn't write to Calibre. Afterwards, run **Apply approved tags to
Calibre** from the dashboard (all books), or apply from a book's page (one book).

## Categories (`/admin/categories`)

The vocabulary as a tree, with how many books sit under each term (and how
many directly at it). Click a count to list those books. Below it:

- **Against the vocabulary:** the vocabulary's version, then retired terms
  still in Calibre (automatic when the term has one replacement; otherwise
  review on each book's page), unknown terms, and books tagged only at a broad
  term.
- **Other tags:** tags outside the vocabulary. Edit those in Calibre-Web; the
  cleanup job removes the ones flagged ⚠.

Nothing on this page is edited here: the vocabulary comes from terminology-mcp
(see the Taxonomy page).

## Taxonomy (`/admin/taxonomy`)

Where the vocabulary comes from. The cards show the vocabulary (terms, retired
tags, version, any problem) and how far corpus-mcp follows terminology-mcp's
`cc-subjects` (its change number, when it last synced and reported, any
problem). A link opens terminology-mcp's editor, where terms are added, renamed,
moved, and retired.

**Provisional terms** are those proposed in terminology-mcp and not yet
confirmed there, with how many books carry each. They can be used for tagging
now. Nothing is edited on this page.

## Citekeys (`/admin/citekeys`)

Counts of books pinned, set in Calibre, ready to file, and blocked, each
linking to those books. Below is every pinned key, with who pinned it and,
when it differs, the key this server would have proposed. Pin, replace, or unpin
on a book's page.

## Zotero (`/admin/zotero`)

How Calibre's books stand against a read-only mirror of the Zotero library. The
summary shows when it last synced. **Sync now** runs a sync job.

- **Possible matches:** same title, first author, and year, but nothing ties
  them. **This book** links it and pins its citekey; **Not this book** dismisses it.
- **Citekey mismatches:** the book's key differs from Zotero's. Fix whichever
  is wrong; corpus-mcp never changes a pin on its own.
- **Possible duplicates in Zotero:** perhaps a second copy filed by mistake.
  Merge them in Zotero, keeping the item whose key you cite, or press **Not a
  duplicate** (another edition, say).
- **Matched, without a citekey.**

If Zotero isn't configured, the page explains what to set.

## Shelves (`/admin/shelves`)

Calibre-Web's public shelves, with book counts, refreshed with every pull.
Click one to list its books. Edit shelves in Calibre-Web.

## Jobs (`/admin/jobs`)

Every job, newest first: its kind, mode (preview or apply), status, who ran it,
and when. A job's page shows the books it changed (or would change), its live
output, and for a successful preview, **Apply this preview**.

## Changes (`/admin/changes`)

The history behind the other pages: every change, when, from where, and by
whom. Filter by time range, source (admin jobs, admin pages, command line,
seen in Calibre, review, agents), book, tag, job number, or person. Press a
change type to show only that type. The chart shows changes per day.

## About (`/admin/about`)

What the server runs and how it stands: the same as the two VS Code status-bar
items, for when VS Code isn't at hand. It refreshes every minute.

- **Running:** the branch or pull request the server was deployed from, its
  commit, when it was deployed, and how many commits it's behind origin. It also
  notes a merged or closed pull request, or a deploy from a local checkout, and
  says what to do about it.
- **Server:** the version, Node, when it started, the books indexed, and the
  last scan.
- **Editing:** whether edits work on the LAN and who they're recorded as, and
  whether Cloudflare Access is set up.
- **Public catalogue:** the public site and whether it answers as published,
  the LAN preview, and the upload queue (waiting rows, the last upload, and any
  error).

How far behind origin, and whether the public site answers, come from GitHub's
API and from the site itself, checked every few minutes. While the Internet is
down they show as unknown or unreachable, and the rest of the page is current.


### Correcting missing authors and filename titles

Use **Books → Correct authors, title, or year** to list books needing review. The book's Title page card has an editable title, one author per line, and publication year, prefilled
from its title page when available. It shows the cover beside the correction;
PDFs can render the first page when no Calibre cover image has been mirrored yet.
Compare the values with the book, edit them if needed, then choose **Apply to Calibre**.
The single action checks the same reviewed plan on the source host, backs up
`metadata.db`, changes title/authors/year and regenerates sort fields for changed titles or authors through Calibre’s metadata API, records the change,
and refreshes the index. An unchanged-file move caused by Calibre renaming the
book's folder preserves extracted text and saved anchors. Resolved citekey blockers
then clear normally; other missing fields can still block a citekey.

If metadata changed since the form loaded, reload and review it again. Extracted
names remain suggestions until Apply; they do not silently become citation authors.
The source host needs the updated named `metadata-preview` and `metadata-apply`
commands (`deploy --source-setup` or `--source-setup-user-key`). These commands use
`tools/calibre-metadata.py`; the existing tag and conversion commands are unchanged.

The source writer uses `calibre-debug` from the same Calibre installation as the existing source tools. The metadata API accepts ordered author lists directly, preserving author order and comma-containing names, and recomputes title/author sort values. See the [Calibre database API](https://manual.calibre-ebook.com/db_api.html).

Publication year defaults to Calibre's current year, falling back to the extracted
publication/copyright year when Calibre has none. It can be edited or left unknown.
The review filter includes books missing only a Calibre year. Saving a new year
writes a year-only publication date (January 1 at noon UTC); an unchanged year
preserves the full existing date. The refresh recomputes the proposed citekey,
while pinned or Calibre-assigned citekeys retain their usual precedence.
