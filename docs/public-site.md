# The public catalogue

corpus-mcp can publish the library's catalogue as a public website, while
everything else stays private. This site's copy is at
[corpus.majerus.us](https://corpus.majerus.us). It's off unless you turn it on.

## What's public

| Public | Never public |
|---|---|
| Title, authors, year, publisher, ISBN, language, format | Book text and page images |
| Subjects: the vocabulary terms a book carries, and the terms above them | Quotes |
| Calibre-Web's public shelves | Tag proposals, jobs, and the change log |
| Citekeys: pinned, set in Calibre, or from the matched Zotero item | Proposed citekeys |
| Links to the same book on other public sites | `/admin`, `/api`, `/mcp` |

Books with an excluded tag (`CORPUS_EXCLUDE_TAGS`, by default `private`) aren't
indexed, so they're never in the catalogue either.

What's public is decided in one place: the snapshot builder
([`src/public/snapshot.ts`](../src/public/snapshot.ts)) copies only those fields
into a separate database. The pages read only that database, so they can't
show anything else.

## The pages

| Path | What it shows |
|---|---|
| `/` | Counts, a search box, the shelves, the top-level subjects, and links to other sites |
| `/books` | Every book, by author. `?q=` searches titles, authors, and subjects |
| `/books/<id>` | One book's catalogue entry, with links to it on other sites |
| `/subjects` | The subject tree, each with a count that includes narrower subjects |
| `/subjects/<tag>` | The books under a subject, and its narrower subjects |
| `/shelves`, `/shelves/<id>` | Calibre-Web's public shelves, in the shelf's own order |
| `/site.json`, `/api/public/citekeys` | For other sites; see [Linking with other sites](#linking-with-other-sites) |

Pages can be cached for five minutes. Each response has an ETag, so a browser
revalidating an unchanged page gets a 304.

## Linking with other sites

Two public sites can link their pages for the same book, without sharing code.
For example, a book page here links to "Quotes from this book" on the quotes
site, and that site's page links back.

- **`/site.json`** describes the site:
  `{ "version": 1, "name", "kind": "library", "url", "level": "catalogue", "citekeys": "/api/public/citekeys" }`.
- **`/api/public/citekeys`** maps each book's keys to its page:
  `{ "citekeys": { "<citekey>": "<path>" }, "zotero_keys": { "users/<id>/<item key>": "<path>" } }`.
  A link matches on either kind of key. Zotero item keys are the stable ones.
- **`CORPUS_SITE_LINKS`** lists the other sites. On each rebuild the server fetches
  their `site.json` and key lists, and stores them in the snapshot. If a site
  can't be reached, its last links are kept. Requests stay on that site's own
  origin, redirects included.

Only real keys go in the key list: a book's pinned or Calibre citekey, and the
Zotero item the mirror matched it to, with that item's citekey. A book links to
another site only once it's filed in Zotero or pinned.

## From the LAN to the web

```text
corpus.db + data.db ──▶ public.db ──▶ queue (replica.db) ──▶ D1 proxy ──▶ D1 ──▶ public Worker
      (LAN server)      snapshot,       drain, every 15 s     Worker              corpus.majerus.us
                        every 10 min
```

1. **The snapshot.** The server rebuilds `public.db` on start and every
   `CORPUS_PUBLISH_INTERVAL_MINUTES` (10). That picks up scans, pins, category
   changes, and Zotero matches. An unchanged catalogue leaves the file alone.
2. **The queue.** When the snapshot changes, each row is compared with what was
   last sent to D1. New, changed, and removed rows are queued in `replica.db`
   beside the snapshot.
3. **The drain.** Every 15 seconds the server sends the queue to D1 through the
   proxy Worker, in batches that D1 runs as transactions. A failed batch stays
   queued for the next try. Nothing else writes D1.
4. **The public Worker** serves the same pages as the LAN server, read from D1.
   It answers "hasn't been published yet" until the first complete upload.

The catalogue has a listener of its own, on `CORPUS_PUBLIC_PORT` (by default
`8001`; `off` turns it off), that serves the same pages from `public.db`, and
nothing else. With D1 configured, it's a
preview of what goes out next, and each page says so in a banner. Without D1,
it's the public site itself, for hosting behind a proxy without Cloudflare. The
server's main port never shows the catalogue: `/` there is the admin dashboard.
Before 2026-10-29 the main port served it at `/`; a proxy that pointed there for
the catalogue should now point at the catalogue's port.

## Setting it up

**On the server**, in `/etc/corpus-mcp/env`:

| Variable | Example | Meaning |
|---|---|---|
| `CORPUS_PUBLIC` | `catalogue` | Turns the public catalogue on (default `none`) |
| `CORPUS_PUBLIC_TITLE` | `"A Library (books on work)"` | The site's name. Quote a value with spaces or parentheses |
| `CORPUS_PUBLIC_URL` | `https://corpus.majerus.us` | The public address, given in `site.json` |
| `CORPUS_SITE_LINKS` | `https://quotes.majerus.us` | Other public sites to link to, comma-separated |
| `CORPUS_PUBLIC_PORT` | `8001` | The listener that serves only the public pages (the default); `off` for none |
| `CORPUS_PUBLIC_DB` | `/var/lib/corpus-mcp/public.db` | Where the snapshot is written |
| `CORPUS_PUBLISH_INTERVAL_MINUTES` | `10` | How often the snapshot is rebuilt |

**In `.env` on your workstation**, which every deploy copies to the server:

| Variable | Meaning |
|---|---|
| `CORPUS_D1_PROXY_URL` | The proxy Worker's address, e.g. `https://corpus-mcp-d1-proxy.<account>.workers.dev` |
| `CORPUS_D1_PROXY_TOKEN` | The proxy's bearer token: the same value as its `D1_PROXY_TOKEN` secret |

**On Cloudflare, once.** The site needs its own D1 database. Don't share
another site's: both snapshots have tables such as `meta`.

1. `npx wrangler d1 create corpus-mcp-public`, then put its id in
   `worker/wrangler.jsonc` and `worker/wrangler.proxy.jsonc`.
2. `npx wrangler d1 migrations apply DB --remote -c worker/wrangler.jsonc` creates the tables.
3. Set the hostname in `routes` in `worker/wrangler.jsonc`. The hostname must
   have no DNS record yet; deploying creates it.
4. Deploy the proxy, then set its token from `.env`, so the token never appears on screen:

   ```bash
   npx wrangler deploy -c worker/wrangler.proxy.jsonc
   node --env-file=.env -e 'process.stdout.write(process.env.CORPUS_D1_PROXY_TOKEN)' \
     | npx wrangler secret put D1_PROXY_TOKEN -c worker/wrangler.proxy.jsonc
   ```

5. Deploy the public Worker: `npm run worker:deploy`.
6. Deploy corpus-mcp. Within about 15 seconds of the server starting, the first
   upload reaches D1 and the site is live.

## Day to day

Nothing needs doing: the snapshot and the drain keep the site current. To act
by hand:

- **The Deploy Corpus button** in the VS Code status bar has two Cloudflare items:
  - **Deploy the public Worker** (`npm run worker:deploy`) runs the tests, then deploys the pages.
  - **Deploy the D1 proxy** (`npm run worker:deploy-proxy`).

  Deploy the Worker after changing the pages, their styles, or the favicon. The
  LAN server's own deploy doesn't update it.
- **`corpus-mcp publish`** on the server rebuilds the snapshot and uploads once.
  `--status` shows the queue. If the server's drain is uploading at that moment,
  `publish` leaves the changes to it: only one upload runs at a time.
- **`GET /health`** reports the drain under `replica`: its phase, how many rows
  are waiting, when it last uploaded, and its last error.

The status bar's **public replica** item reads `/health` and checks the public
site every minute:

| Shows | Meaning |
|---|---|
| `$(cloud)` | D1 is up to date and the site is live |
| `$(cloud) ↑n` | n rows are waiting to upload |
| `$(cloud) !` | The last upload failed; the tooltip gives the error |
| `$(cloud) off` | The server has no D1 settings |
| `$(cloud) —` | The server reports no drain: `CORPUS_PUBLIC` is `none`, or it runs an older build |
| `$(cloud) ?` | The server can't be reached, or the site doesn't answer as published |

## Running it locally

`npm run worker:load` builds a snapshot from your local settings, then loads it
into a local D1. `npm run worker:dev` then serves the Worker at
`http://localhost:8787`. `npm run worker:proxy` runs the proxy locally on port
8788, with its token in `worker/.dev.vars`. Run the proxy and the Worker one at
a time: two `wrangler dev` Workers can't share the local D1 file.

## Troubleshooting

- **The site says it hasn't been published yet.** The first upload hasn't
  finished. Check the status-bar item or `/health`.
- **The drain reports `Unauthorized`.** The proxy's `D1_PROXY_TOKEN` secret
  doesn't match `CORPUS_D1_PROXY_TOKEN`. Set the secret again with the piped
  command in step 4 above; a stray newline from pasting is a common cause.
- **The drain is `off`.** The server has no `CORPUS_D1_PROXY_URL` and
  `CORPUS_D1_PROXY_TOKEN`. Add them to `.env` and deploy.
- **The preview port says the catalogue hasn't been built.** The server builds
  it a moment after starting. Run `corpus-mcp publish` if it doesn't appear.
- **A book doesn't link to the quotes site.** The book needs a real key: pin
  its citekey, or file it in Zotero so the mirror matches it. The other site
  must list the same key, and the link appears after this site's next rebuild.
