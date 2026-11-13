# Duplicate review and resolution

The duplicate screen supports exact selected-file matches and candidate metadata
matches, grouped by connected pairs, and resolves groups singly or as a batch. It
never auto-deletes a candidate. Keep-both decisions are primary data in
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

Browser reloads do not trigger source synchronization. The duplicate API includes
`last_scan`, the configured Calibre-Web URL and writable library. The screen can
start the existing authorized refresh job, wait for completion and reload candidates;
it also reloads index data when returning from another tab or browser history.
Calibre's native trash does not touch Calibre-Web's `app.db`, so the helper moves
each duplicate's shelf links to its keeper itself, in one `BEGIN IMMEDIATE`
transaction per duplicate, just before the trash: a link is re-pointed (keeping its
order and date added) or deleted where the keeper is already on that shelf, and the
shelf's `last_modified` is set, as Calibre-Web's own shelf edits do (Kobo sync reads
it). The apply backs up `app.db` into the batch's `.files/app.db` first. Every other
Calibre-Web table that references the duplicate, and an orphaned shelf link, still
blocks. Corpus ranks keepers with the public shelves it mirrors and each cover's
colourfulness (Hasler–Süsstrunk, cached by file identity); neither is part of a
fingerprint, so keep-both decisions survive them.

## Batches

The plan sent to the source is `{"groups": [{keep, remove: [...], discard_conflicts}]}`.
The corpus checks each book's own fingerprint from the review screen (not the pair or
group, so regrouping does not matter), that every book appears once, and that each
trashed record pairs directly with its keeper, is writable and is unreferenced. The
source reviews each group under one write lock and fingerprints its members and its
conflict choice. Apply
re-reviews every group first; groups that changed or gained blockers are skipped
before the single `metadata.db` backup. Each remaining group then backs up its own
folders into `…/.files/<keeper id>/` and resolves in turn. A group whose files change
during its backup is skipped. Any error after a group's first change stops the whole
batch, leaving the later groups untouched. The helper exits non-zero when any group was
skipped, naming each one, so the job is marked failed while recording what changed.

## Apply and recovery

The admin uses its existing Access authorization and single-job runner. Apply
reuses a successful source preview no older than one hour. The source checks UUIDs,
metadata and complete non-OPF file hashes again, verifies reference blockers, and
backs up metadata.db plus both full book folders before copying or trashing anything.
Native `add_format(..., replace=False, run_hooks=False)` preserves unique formats
without replacing keeper files. The native `remove_books(..., permanent=False)`
operation runs only after format verification and a second source-reference check.
The helper runs through Calibre's installed Python environment, via `calibre-debug`.
Only explicitly raised `DuplicateReviewError` validation failures receive concise
stderr output. Unexpected native, programming, OS, and database exceptions propagate
with their tracebacks; invalid JSON and malformed book identities are explicitly
validated before opening Calibre.

The snapshots are `metadata.db.before-duplicates-TIMESTAMP` and its matching `.files`
directory. The latter has one folder per group, named by the keeper's Calibre ID, with
a folder per member record and `review.json` holding the reviewed fields, paths and
file hashes. Both snapshots and `/.caltrash/` are
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

`/mnt/Calibre/.corpus-duplicate-operator-z3QMuEg4`

It passed:

- Explicit review of different PDF bytes and preservation of a unique EPUB.
- A successful, reviewable preview showing public-shelf membership and conflicting
  formats together. It explains when the keeper already belongs to that shelf.
- Refusal after a new Calibre-Web shelf link appeared following preview, without
  an expected-reference-error traceback.
- Refusal after source metadata changed following preview.
- Preview blockers for a damaged EPUB that would survive the resolution.
- An injected native failure immediately after copying a format retained its
  unexpected OSError traceback while an expected shelf blocker stayed concise. Both records
  remained, an interrupted-resolution event was emitted, and retry succeeded.
- Merging tags, comments, a missing cover, and supplementary content, trashing the duplicate, and
  restoring it through Calibre's native trash API.
- Retention of both pre-mutation snapshots from the interrupted attempt and retry.

The source helper SHA-256 was:
`8569fbd3b623593e65292248b34ec052c9357e4b5bab204abb2081d2a41891b9`.
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

## Batch validation, 2026-11-13

The batch helper ran the same validator on calibre-web.localdomain (Calibre 8.5, as
`authoring`) in a new disposable library,
`/mnt/Calibre/.corpus-duplicate-operator-MTqajYxJ`. All earlier checks passed under the
batch plan format. The new checks also passed:

- A plan previewed with conflicting formats kept, then sent to apply with
  `discard_conflicts` turned on, was refused as changed since preview: the conflict
  choice is part of each group's fingerprint.
- Two duplicates with different EPUB files, and a keeper without one, stayed blocked
  with or without `discard_conflicts`: that choice only keeps the keeper's own
  version, so it never picks between duplicates.

- A three-group batch preview reviewed each group: a keeper with an identical copy and
  an EPUB-only record, a second pair, and a third pair.
- After the third group changed, apply resolved the first two (trashing 4, 5 and 7),
  skipped the third without changes, and exited non-zero naming it. It made one
  `metadata.db` backup, with folders for the two resolved groups only.
- The keeper gained the EPUB and the duplicates' tags, and all three trashed records
  restored from Calibre's trash.

Helper SHA-256: `cca1ab1b18850287fd1e3e1b57ce42d0636989f443e81e24afb87d6198a72f41`.
No production book was changed.

## Shelf moves, 2026-11-13

The helper ran the validator on calibre-web.localdomain (Calibre 8.5, as `authoring`)
in `/mnt/Calibre/.corpus-duplicate-operator-2TjRiQ1Y`, with Calibre-Web's own `shelf`,
`book_shelf_link` and `bookmark` columns. All 14 checks passed, including:

- A preview with the duplicate on a shelf the keeper shares and on a private shelf
  reported a drop and a move, with no blocker and no private name.
- A bookmark added after preview still skipped the group at apply.
- After apply, the keeper held both links with their original order and date, the
  duplicate held none, both shelves were marked modified, and the batch backup's
  `app.db` still had the duplicate's links.

Helper SHA-256: `a46c2181a9fa60193f36eca0277987e43a0dc35a70e672dcf6d5a10dd74270d4`.
No production book or shelf was changed.
