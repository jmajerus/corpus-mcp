# First re-extraction run

Started 2026-11-06 at 23:21 UTC on corpus-mcp.localdomain, using Pandoc 3.1.11.1 and navigation
adapter revision 3. The active extractor code matches merged PR #20. Re-extraction writes actual
pages, outline entries, FTS passages, counts, and profile pins into a private candidate index.

The corpus service and refresh timer were briefly stopped, with automatic restoration on failure,
to capture matching index/data snapshots. The regular refresh service was inactive. Both normal
services resumed before the background job started. Source EPUBs remain in place and each worker
checks the indexed SHA-256 before accepting extraction.

## Scope and isolation

- 301 indexed EPUBs without saved quotes/anchors are queued.
- Four EPUBs with saved anchors (`main:53`, `main:133`, `main:581`, `main:570`) retain their existing
  extraction pending coordinated quote-consumer validation. The anchored PDF is unaffected.
- Each worker opens only a tagged inspection candidate. It refuses books with saved quotes/anchors.
  All changes for an accepted book commit in one index transaction.
- Workers run sequentially, with a 15-minute book budget rather than the survey's 150 seconds.
  Failed workers and their Pandoc descendants are terminated together, their private temporary files
  are removed, and the controller continues. A committed book is recoverable after a worker exit.
- Progress and per-book outcomes are checkpointed to JSON. A candidate-index quick check runs when
  the batch finishes. CPU, memory, swap, and total-run limits apply to the independent service.

The run finished on 2026-11-07 at 03:38 UTC: 239 books staged and 62 refused, with all 301 queued
books accounted for. The active index remains on profile 1. The candidate retains the 62 refused
books and four anchored EPUBs on profile 1. See [candidate validation](pandoc-reextraction-validation.md)
for the completed checks, the metadata correction, and outstanding activation gates. No full software
suite or additional survey was run.

## Server locations

Run root: `/var/lib/corpus-mcp/reextraction/20261106-pandoc-v3`

- `snapshot/corpus.db` and `snapshot/data.db`: coordinated input snapshots.
- `candidate/corpus.db` and `candidate/data.db`: inspection-only output.
- `candidate/progress.json` and `candidate/books.jsonl`: current counters and outcomes.
- `manifest.json`: runtime, source profiles, and code hashes.
- `code/`: isolated runner and dependencies, independent of later application releases.

Background unit: `corpus-pandoc-reextraction-20261106.service`.

## Activation remains separate

No candidate is automatically promoted. The live service remains available on its current index.
The quote-mcp canonical-text patch is now deployed and verified. A separate anchored-book rehearsal
accepts two of the four held EPUBs and defers two, without changing production. See the updated
[validation brief](pandoc-reextraction-validation.md#consumer-handoff-verified-2026-11-07-utc) for the
release evidence, migration boundary, and remaining cutover checks. The corpus metadata correction
still needs deployment before activation.

The live service and normal refresh may create newer metadata, books, or anchors after capture.
Before activation, reconcile those changes and recheck file hashes, saved-anchor ownership, search,
sections, and reader behavior. Do not overwrite newer primary data with the older candidate data
snapshot. Prepare rollback for the actual cutover window. All run reports retain `promotionReady:
false`.
