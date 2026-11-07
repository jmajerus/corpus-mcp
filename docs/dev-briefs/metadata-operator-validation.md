# Calibre metadata writes: operator validation and recovery

PR #22's review correctly identified a validation gap: an empty Calibre record does
not exercise filesystem renames or recovery of actual book files. The original
writer also could leave partial changes without an audit event or index refresh.
This follow-up adds complete book-file snapshots, a per-book recovery tool, and
partial-failure reporting and refresh. It does not make a multi-field write atomic.

## Source-host exercise, 2026-11-07

The final run started at 18:43:26 UTC on `calibre-web.localdomain`, using the
production library owner `authoring` (UID 1000), `/usr/bin/calibre-debug` 8.5, and
the same ext4 filesystem as `/mnt/Calibre/main`. The isolated library was
`/mnt/Calibre/.corpus-metadata-operator-ORynkvnv/library`, outside the live library.
Its private parent retains `report.json`, `operator.log`, scripts, and fixtures.
A separate SQLite backup of the live catalogue also opened successfully with the
native runtime; its book count and a book UUID matched SQLite's read-only values.

The exercise passed these checks:

- A title/author/year correction moved real PDF and EPUB files, a cover, and a
  supplementary file. Content hashes remained identical. Ordered Unicode and
  comma-containing author names survived the native API round trip.
- Recovery preview left book state unchanged. Applying recovery restored the
  original title, author list, complete publication timestamp, custom sort fields,
  original paths, and file hashes.
- Stale values, a mismatched UUID, and a missing runtime failed without changing
  the book.
- A fixture-only wrapper raised an exception immediately after the native title
  setter renamed files. The writer failed and reported actual partial values.
  The application regression test verifies those values are audited and the
  index refresh is attempted while the job remains failed.
- Restoring only `metadata.db` in a disposable copy demonstrably broke format
  paths after the rename.
- Seven incomplete/inconsistent inventory cases were rejected before metadata
  writes: omitted format or supplementary checksum entries, mismatched format
  rows or folder, missing or unlisted snapshot files, and an indexed format
  missing from both the snapshot and checksum map.
- An injected mismatch between Calibre's restored folder and the saved folder
  stopped recovery before restoring a deliberately missing PDF or reporting
  success. Metadata setters had already run; this failure is not rolled back.
- A corrupt snapshot was rejected before recovery writes. After repairing the
  fixture snapshot, recovery restored a deliberately deleted PDF and the partial
  correction. A later comment edit on another book survived.

Read-only fingerprints of live `books`, `authors`, `books_authors_link`, and `data`
rows matched before and after. No source helper was installed, no real book was
edited, and no production service was restarted. This is source-host runtime and
filesystem validation using synthetic books, not a live-book Apply test or an
end-to-end test through the deployed admin UI.

The tested script SHA-256 values were:

| Script | SHA-256 |
| --- | --- |
| `tools/calibre-metadata.py` | `a4d6efcf0c33f174e0ba3f667936efc9e4ef33d05d4509693129826f9ac9479e` |
| `tools/calibre-metadata-recover.py` | `7a52956b6652bd295330c445e252f29fd40ce7831a6ae373eba345ab64703183` |
| `tools/validate-calibre-metadata.py` | `6e0bb7d8ad60b116fe1f64c7e556f14664114b727ce3e14f9e164289022ce102` |

## Repeating the exercise

Use a new directory named `.corpus-metadata-operator-*` outside the live library,
on the same filesystem. Copy the three scripts above into it, and supply small
synthetic `seeds/operator.pdf`, `seeds/operator.epub`, and `seeds/cover.png` files.
Give the library owner ownership of that directory and run as that owner:

```sh
python3 /mnt/Calibre/.corpus-metadata-operator-NEW/validate-calibre-metadata.py \
  /mnt/Calibre/.corpus-metadata-operator-NEW
```

The harness refuses an existing `library` directory and isolates Calibre's config
and cache. It retains logs and a JSON pass/fail report. It needs `/usr/bin/calibre-debug`
and `/usr/bin/calibredb`. The live-catalogue clone and before/after fingerprints
were additional operator checks, outside the harness.

## Recovering a failed correction

The job log identifies `metadata.db.before-metadata-TIMESTAMP` and its companion
`metadata.db.before-metadata-TIMESTAMP.files`. Keep them together. The companion
contains the complete pre-write book folder and a checksum manifest. Both backup
creation and file verification finish before invoking the metadata writer.

Pause further corrections to the affected book and review the failed job. As the
library owner, preview with the installed recovery script (the user-key setup puts
it in `~/.local/bin`; root source setup uses `/usr/local/bin`):

```sh
calibre-debug -e ~/.local/bin/calibre-metadata-recover.py -- \
  /mnt/Calibre/main /mnt/Calibre/main/metadata.db.before-metadata-TIMESTAMP
```

After reviewing the before/restore values, run the same command with `--apply`:

```sh
calibre-debug -e ~/.local/bin/calibre-metadata-recover.py -- \
  /mnt/Calibre/main /mnt/Calibre/main/metadata.db.before-metadata-TIMESTAMP --apply
```

Recovery verifies the UUID, database format rows, complete snapshot inventory and
checksums before writes. It refuses changed existing book
content, and uses the current Calibre API to restore the selected metadata and
reverse folder renames. It verifies the resulting folder equals the saved path
before restoring files; a mismatch stops with an explicit warning that metadata
may already have changed. It restores missing formats, cover, and supplementary
files, regenerates metadata.opf, and preserves unrelated catalogue edits. Recovery
restores the saved correction fields; later edits to those same fields would be
overwritten, so review them first. It does not overwrite the live database or
provide automatic rollback if recovery itself fails. Keep the backups and inspect
the failure before retrying. Refresh corpus after recovery and check the book's
formats, cover, and metadata in Calibre.

Source setup must install the updated writer and recovery script before using the
new Apply workflow. The recovery tool is operator-only and is not exposed as a
forced SSH command. Full snapshots consume space and are not automatically pruned;
retain them until the correction is verified, then remove them according to the
library's backup practice. Sync excludes these snapshots from the corpus mirror.
