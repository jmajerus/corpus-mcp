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

Every write, from the admin pages or the API, needs a verified Cloudflare Access
identity (`CORPUS_ACCESS_TEAM_DOMAIN`, `CORPUS_ACCESS_AUD`). Direct LAN access
is read-only.

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

The server also answers `GET /health`.

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
and how far it is behind origin. In VS Code, the Deploy Corpus status-bar button (the Task Buttons
extension) runs each of these. [PLAN.md](../PLAN.md) records the
design decisions, the facts about the corpus, and the known issues.
