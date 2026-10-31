# Operations

How corpus-mcp is built, configured, and deployed, and how it changes Calibre.

## How it works

```text
Calibre library ── rsync (read-only) ──▶ books/<library>/…
                                              │
                        corpus-mcp index      ▼  metadata.db → MuPDF → SQLite FTS5
                                           corpus.db
                                              │  read-only
                        corpus-mcp serve      ▼  Streamable HTTP /mcp, or stdio
                                              │
                                         MCP clients
```

- **Catalogue.** Each library's `metadata.db` is the source of truth for
  books, authors, publishers, ISBNs, and format files. The indexer reads an
  in-memory copy, so it never locks Calibre's database. It doesn't use the
  `metadata.opf` backups, which go stale.
- **Extraction.** The official [`mupdf`](https://www.npmjs.com/package/mupdf)
  WebAssembly package reads all three formats. It provides each page's text,
  printed page labels, and the outline. Running heads and folios are stripped
  from PDFs.
- **Incremental indexing.** A rescan skips files whose size and modification
  time are unchanged, and rehashes the rest. Only changed books are
  re-extracted. Identical files in more than one library are collapsed in
  search results.
- **Exclusions.** Only allowlisted libraries are indexed. Books carrying an
  excluded Calibre tag (by default `private`) are never indexed.
- **The public catalogue.** With `CORPUS_PUBLIC=catalogue`, the server also
  copies the public part of the catalogue into `public.db` and keeps a copy in
  Cloudflare D1, which a Worker serves as a website. Book text never leaves the
  LAN. See [The public catalogue](public-site.md).

## Shelves

Calibre-Web shelves are topic collections, such as *Misinformation*, kept in
Calibre-Web's own `app.db` rather than in the Calibre library. The sync key's
forced command, [`deploy/corpus-source.sh`](../deploy/corpus-source.sh), allows
exactly two things: read-only rsync of the library, and a `shelves` command
that prints the public shelves and their book ids as JSON. `app.db`, which
also holds password hashes, never leaves the Calibre-Web host. Each refresh
replaces the index's `shelves` and `book_shelves` tables from that export.
If the export fails, the previous membership is kept.

## Access

The LAN is trusted. A request made directly on the LAN can read and write, as
`/mcp` always could, and the admin pages record its changes under
`CORPUS_LAN_ACTOR`. From outside, the server is reached through a Cloudflare
tunnel, where every write needs a verified Access identity
(`CORPUS_ACCESS_TEAM_DOMAIN`, `CORPUS_ACCESS_AUD`) and is recorded under its
email. Tunnelled requests also arrive from a LAN address, so "on the LAN" means
a private address with none of the headers a CDN or Cloudflare adds. A LAN
request must also name the server by one of its LAN names (`CORPUS_LAN_HOSTS`)
or an IP address, so that a web page can't use DNS rebinding to make changes
from a browser on the LAN. `CORPUS_LAN_EDITS=off` makes direct LAN access
read-only again.

| Address | What it is |
|---|---|
| `http://corpus-mcp.localdomain:8000` | The server, on the LAN: `/` is the dashboard, plus `/mcp` |
| `https://corpus-mcp.majerus.us` | The same server from anywhere, through the tunnel and an Access sign-in |
| `http://corpus-mcp.localdomain:8001` | The public catalogue's own port (`CORPUS_PUBLIC_PORT`): a preview, with D1 |
| `https://corpus.majerus.us` | The published public catalogue: a copy in D1, read-only |

## Calibre jobs

Calibre changes always run as preview, then apply (see
[Using the admin pages](admin-ui.md#changing-calibre-preview-then-apply)). The
apply runs exactly the previewed plan, backs up `metadata.db`, and refreshes the
index. Jobs run on the Calibre-Web host as named commands of the sync key's
forced command, never as a shell.

Applying an approved category set adds and removes vocabulary tags to match,
and never touches other tags.

## Bulk imports

Bulk imports are not a job. The library's owner runs
`calibre-import.sh [--apply] [--tags kindle] <folder>` on the Calibre-Web
host, which `--source-setup` installs beside the job scripts. Without
`--apply` it lists the files. With it, it backs up `metadata.db`, adds one
file at a time, and sorts each into `_done/`, `_duplicates/`, or `_failed/`
inside the folder. Kindle `.kfx-zip` archives need calibre's DeDRM plugin,
with the account's keyfile imported, and KFX Input; one still encrypted after
the add is removed again and counts as failed. The EPUB job then converts
MOBI, AZW3, and KFX books so they get chapter locators.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CORPUS_BOOKS_ROOT` | `/srv/corpus/books` | Directory containing one folder per Calibre library |
| `CORPUS_LIBRARIES` | `main` | Comma-separated library folders to index |
| `CORPUS_EXCLUDE_TAGS` | `private` | Calibre tags that keep a book out of the index |
| `CORPUS_DB` | `/var/lib/corpus-mcp/corpus.db` | Index file (derived; can be rebuilt) |
| `CORPUS_DATA_DB` | `/var/lib/corpus-mcp/data.db` | Primary data such as pinned citekeys (never rebuilt) |
| `CORPUS_BACKUP_DIR` | `/var/lib/corpus-mcp/backups` | Where `corpus-mcp backup` writes daily copies of `data.db` (14 kept) |
| `CORPUS_HOST` / `CORPUS_PORT` | `0.0.0.0` / `8000` | HTTP listen address |
| `CORPUS_LAN_EDITS` | `on` | `off` makes direct LAN access read-only |
| `CORPUS_LAN_ACTOR` | `LAN` | The name changes made directly on the LAN are recorded under, such as your email |
| `CORPUS_LAN_HOSTS` | the host name, and it with `.localdomain` | Comma-separated names the server is reached by on the LAN; IP addresses always work |
| `CORPUS_PUBLIC` | `none` | `catalogue` turns on the public catalogue; its other settings are in [The public catalogue](public-site.md#setting-it-up) |
| `CORPUS_D1_PROXY_URL` / `CORPUS_D1_PROXY_TOKEN` | unset | The D1 proxy the public catalogue uploads through; deploy copies them from `.env` |

On the server, these live in `/etc/corpus-mcp/env`. That file is systemd's
`EnvironmentFile`, not a shell script, so put a value with spaces or parentheses
in double quotes. It holds secrets (the Zotero key and the D1 proxy's token), so
every deploy keeps it readable only by root and the `corpus` group.

The server also answers `GET /health`. It reports what's deployed, under
`deployed`, and the public catalogue's upload queue, under `replica`.

## Deployment

[`deploy/`](../deploy/) holds systemd units, the rsync pull script, and the setup
scripts. [`tools/deploy.mjs`](../tools/deploy.mjs) provisions a Debian LXC,
installs releases with a health check, and rolls back on failure. Both are
written for the author's own Proxmox network (`*.localdomain` hosts), so adapt
the hostnames before using them elsewhere. `npm run deploy` and
`npm run tags:apply` read their settings from a gitignored `.env` (see
[`.env.example`](../.env.example)). `npm run deploy` installs this
checkout; `npm run deploy -- --pr <number>` installs an open pull request's head
commit instead, built and tested in a temporary worktree, so the server can try a
change before it merges, and `npm run deploy -- --main` switches back to
`origin/main`. Each deploy records its source on the server in
`/var/lib/corpus-mcp/deployed.json`, and `npm run deploy -- --current` redeploys
the latest commit of that same pull request or branch. `GET /health` returns that record as `deployed`, and
[`tools/corpus-status.mjs`](../tools/corpus-status.mjs) turns it into a status-bar
item for the Status Probe extension: the branch or pull request the server runs,
and how far it is behind origin. A second item,
[`tools/replica-status.mjs`](../tools/replica-status.mjs), shows the public
catalogue's upload queue (see [The public catalogue](public-site.md#day-to-day)).

In VS Code, the Deploy Corpus status-bar button (the Task Buttons extension)
runs each of these deploys, pushes the Zotero settings, and, with the
`$(cloud-upload)` items, deploys the public catalogue's two Cloudflare Workers.
Those Workers aren't part of the LAN deploy: deploy the public Worker after
changing the public pages. [PLAN.md](../PLAN.md) records the design decisions,
the facts about the corpus, and the known issues.

## Shared authoring Access applications

The private HTTP listener validates Cloudflare Access JWT assertions before
serving MCP, administration pages or private API reads/writes. Configure the
following in the server's `/etc/corpus-mcp/env`:

```dotenv
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
ACCESS_MCP_AUD=<authoring-mcp-access audience>
ACCESS_ADMIN_AUD=<authoring-admin-access audience>
```

`/mcp` requires the MCP audience; other private routes, including `/api`,
require the admin audience. Protect the UI's API and asset routes in the admin
Access application too. Cloudflare Managed OAuth supplies client authorization
and forwards `Cf-Access-Jwt-Assertion`; the origin verifies the signature,
issuer, expiry and subject. An admin token cannot use MCP and an MCP token
cannot read the private admin API. Missing/invalid tokens fail closed.

Direct requests from a private peer naming the service's LAN hostname/IP,
without Cloudflare proxy headers, retain their existing LAN behavior. Separate
public snapshot listeners and Workers are unaffected.

Corpus retains its separately authenticated `/api/intake/vocabulary` service-token route. Its audience and client identity remain independent of these user-facing applications. `ACCESS_ADMIN_AUD` and `ACCESS_TEAM_DOMAIN` take precedence over the legacy `CORPUS_ACCESS_AUD` and `CORPUS_ACCESS_TEAM_DOMAIN` settings.
