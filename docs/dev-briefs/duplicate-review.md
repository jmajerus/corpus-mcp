# Duplicate review and resolution

The duplicate screen supports exact selected-file matches and candidate metadata
matches. It never auto-deletes a candidate. Keep-both decisions are primary data in
`data.db`'s `duplicate_decisions` table (schema 11), tied to each pair's fingerprint.
Candidate generation buckets books by selected-file hash/format, normalized
identifier, and normalized title/author keys. Only books sharing a key are paired;
overlapping evidence is combined into one result per pair. Large actual duplicate
groups still produce one result per matching pair. Unchanged mirrored catalogue
metadata is cached by file identity/size/nanosecond modification and change times,
including the WAL signature. Indexed records, decisions and grouped reference
counts are read fresh on every request. Filed Zotero UUIDs are blockers even
without an explicit link, including old items with active merged survivors.

A change invalidates that decision; cross-library pairs are reviewable but cannot be
merged or trashed by this workflow.

## Apply and recovery

The admin uses its existing Access authorization and single-job runner. Apply
reuses a successful source preview no older than one hour. The source checks UUIDs,
metadata and complete non-OPF file hashes again, verifies reference blockers, and
backs up metadata.db plus both full book folders before copying or trashing anything.
Native `add_format(..., replace=False, run_hooks=False)` preserves unique formats
without replacing keeper files. The native `remove_books(..., permanent=False)`
operation runs only after format verification and a second source-reference check.
The helper runs through Calibre's installed Python environment, via `calibre-debug`.

The snapshots are `metadata.db.before-duplicates-TIMESTAMP` and its matching `.files`
directory. The latter contains folders named by the two Calibre IDs and `review.json`
with the reviewed fields, paths and file hashes. Both snapshots and `/.caltrash/` are
excluded from sync to the corpus mirror. Snapshots remain on the source host until
operator cleanup; a resolution may require space for both book folders plus their
copied unique formats. Backup failure stops before mutations.

This is not an atomic multi-record operation. An error after copying a format may
leave that format in the keeper while both records remain. The job reports an
interrupted resolution, retains the backup paths and attempts an index refresh.
Inspect Calibre and the job before retrying; a new preview recognizes completed
copies and will not replace existing keeper formats. If trash itself reports an
error, inspect its actual state before retrying.

To undo a completed trash, restore the removed book from Calibre's trash before its
retention period expires, then refresh corpus. Merged additions to the keeper are
retained; restoring the duplicate does not automatically reverse those additions.
Use the snapshot and `review.json` for any selective operator restoration. The
metadata-correction recovery tool's manifest is different: do not pass a duplicate
backup to `calibre-metadata-recover.py`, and do not replace the live database alone.

Saved references are held for manual review instead of silently remapped. Existing
corpus writes are paused for the apply, and source references are checked twice.
Separate applications/operators can still change the library concurrently: perform
reviewed resolution without simultaneous external edits to either selected book.
No distributed transaction or reference migration across services is claimed.

## Source-host validation, 2026-11-07

The committed `tools/validate-calibre-duplicates.py` ran as `authoring` (UID 1000)
on calibre-web.localdomain using Calibre 8.5 and a new disposable library on the
same ext4 filesystem as production. Evidence is retained privately in:

`/mnt/Calibre/.corpus-duplicate-operator-qijyuzXy`

It passed:

- Explicit review of different PDF bytes and preservation of a unique EPUB.
- A successful, reviewable preview showing public-shelf membership and conflicting
  formats together. It explains when the keeper already belongs to that shelf.
- Refusal after a new Calibre-Web shelf link appeared following preview, without
  an expected-reference-error traceback.
- Refusal after source metadata changed following preview.
- Preview blockers for a damaged EPUB that would survive the resolution.
- An injected native failure immediately after copying a format: both records
  remained, an interrupted-resolution event was emitted, and retry succeeded.
- Merging tags, comments, a missing cover, and supplementary content, trashing the duplicate, and
  restoring it through Calibre's native trash API.
- Retention of both pre-mutation snapshots from the interrupted attempt and retry.

The source helper SHA-256 was:
`7270e3a83cb63b6bdfa13fe09ac9d0f23bf8a351456614342659e13f03cdb593`.
Read-only fingerprints of production books/authors/author links/formats matched
before and after the exercise. No production helper was installed, no real book
was merged or deleted, and no production service was restarted.

To repeat, copy the helper and validator into a new
`.corpus-duplicate-operator-*` directory outside the live library, owned by its
operator, supply synthetic `seeds/operator.pdf`, `seeds/operator.epub`, and `seeds/cover.png`, then run:

```sh
python3 /mnt/Calibre/.corpus-duplicate-operator-NEW/validate-calibre-duplicates.py \
  /mnt/Calibre/.corpus-duplicate-operator-NEW
```

The validator refuses a reused `library` directory, isolates config/cache, and
retains its logs and JSON report. Live-library fingerprints were separate operator
checks, outside the committed validator. An app deployment and updated source setup
are both required before the new screen can execute resolutions.
