#!/bin/sh
# Pulls a read-only mirror of Calibre-Web's library from calibre-web.localdomain into
# $CORPUS_BOOKS_ROOT/<library> (CORPUS_SHELVES_LIBRARY, else the first of CORPUS_LIBRARIES).
#
# The source's forced command (deploy/corpus-source.sh) reads where the library is from
# Calibre-Web's own settings on every call, so nothing here names a remote path. Each run:
#   1. asks the source where the library is ("library") and keeps the answer in
#      CORPUS_LIBRARY_FILE; when it differs from the last run, the change is logged and kept
#      in the sync status for the admin dashboard
#   2. takes a consistent snapshot of metadata.db ("catalogue")
#   3. rsyncs the book files (only the formats the indexer reads) from the book files location,
#      which in Calibre-Web's split mode is not where metadata.db is
#   4. installs the new metadata.db only if the book files came through, so the catalogue and
#      the files move together (rsync holds its own changes until the transfer completes)
#   5. fetches Calibre-Web's public shelves ("shelves") into CORPUS_SHELVES_FILE, replacing it
#      only on success so a failed fetch keeps the previous membership
# The local mirror is always unsplit: metadata.db sits beside the book folders.
set -eu

: "${CORPUS_SOURCE:=corpus-sync@calibre-web.localdomain}"
: "${CORPUS_BOOKS_ROOT:=/srv/corpus/books}"
: "${CORPUS_LIBRARIES:=main}"
: "${CORPUS_SSH_KEY:=/var/lib/corpus-mcp/.ssh/id_ed25519}"
: "${CORPUS_SHELVES_FILE:=/var/lib/corpus-mcp/shelves.json}"
: "${CORPUS_SYNC_STATUS:=/var/lib/corpus-mcp/sync-status.json}"
: "${CORPUS_LIBRARY_FILE:=/var/lib/corpus-mcp/calibre-library.json}"
library="${CORPUS_SHELVES_LIBRARY:-$(echo "$CORPUS_LIBRARIES" | cut -d, -f1 | tr -d ' ')}"
dest="$CORPUS_BOOKS_ROOT/$library"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ssh_opts="-i $CORPUS_SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes"
# shellcheck disable=SC2086 # ssh_opts is a list of options
source_cmd() { ssh $ssh_opts "$CORPUS_SOURCE" "$1"; }

status=0
pull=ok
mkdir -p "$dest"

# 1. Where Calibre-Web says its library is.
if source_cmd library > "$CORPUS_LIBRARY_FILE.new" && [ -s "$CORPUS_LIBRARY_FILE.new" ]; then
  if [ -s "$CORPUS_LIBRARY_FILE" ] && ! cmp -s "$CORPUS_LIBRARY_FILE" "$CORPUS_LIBRARY_FILE.new"; then
    echo "Calibre-Web's library moved: was $(cat "$CORPUS_LIBRARY_FILE"), now $(cat "$CORPUS_LIBRARY_FILE.new")"
    printf '{"at":"%s","from":%s}\n' "$now" "$(cat "$CORPUS_LIBRARY_FILE")" > "$CORPUS_LIBRARY_FILE.changed"
  fi
  mv "$CORPUS_LIBRARY_FILE.new" "$CORPUS_LIBRARY_FILE"
else
  echo "could not ask the source where Calibre-Web's library is; keeping the previous mirror" >&2
  rm -f "$CORPUS_LIBRARY_FILE.new"
  pull=failed
fi

# 2. A snapshot of metadata.db.
if [ "$pull" = ok ]; then
  if source_cmd catalogue > "$dest/metadata.db.new" && [ "$(head -c 15 "$dest/metadata.db.new")" = "SQLite format 3" ]; then
    :
  else
    echo "catalogue snapshot failed; keeping the previous mirror" >&2
    pull=failed
  fi
fi

# 3. The book files. metadata.db (and its .new) are excluded, which also keeps --delete off them.
# --delay-updates and --delete-delay hold every change until the transfer is complete, so a pull
# that fails partway leaves the previous files in place for the previous metadata.db.
if [ "$pull" = ok ]; then
  rsync -rt --delete --delete-delay --delay-updates --prune-empty-dirs --timeout=600 \
    -e "ssh $ssh_opts" \
    --exclude='/metadata.db*' --exclude='/.caltrash/' --include='*/' \
    --include='cover.jpg' --include='*.pdf' --include='*.epub' --include='*.mobi' --include='*.azw3' \
    --exclude='*' \
    "$CORPUS_SOURCE:./" "$dest/" || {
      echo "sync of the book files failed; keeping the previous metadata.db" >&2
      pull=failed
    }
fi

# 4. The new catalogue, only alongside the files it describes.
if [ "$pull" = ok ]; then
  if cmp -s "$dest/metadata.db.new" "$dest/metadata.db"; then
    rm -f "$dest/metadata.db.new"
  else
    mv "$dest/metadata.db.new" "$dest/metadata.db"
  fi
else
  rm -f "$dest/metadata.db.new"
  status=1
fi

# 5. Shelves.
if source_cmd shelves > "$CORPUS_SHELVES_FILE.new" && [ -s "$CORPUS_SHELVES_FILE.new" ]; then
  mv "$CORPUS_SHELVES_FILE.new" "$CORPUS_SHELVES_FILE"
  shelves=ok
else
  echo "shelf export failed; keeping the previous shelves" >&2
  rm -f "$CORPUS_SHELVES_FILE.new"
  shelves=failed
  status=1
fi

# For the admin dashboard: when the last pull finished, what succeeded, where Calibre-Web's
# library is, and when it last moved.
json_or_null() { if [ -s "$1" ]; then tr -d '\n' < "$1"; else printf null; fi; }
printf '{"finished_at":"%s","libraries":{"%s":"%s"},"shelves":"%s","calibre_library":%s,"library_changed":%s}\n' \
  "$now" "$library" "$pull" "$shelves" "$(json_or_null "$CORPUS_LIBRARY_FILE")" "$(json_or_null "$CORPUS_LIBRARY_FILE.changed")" \
  > "$CORPUS_SYNC_STATUS.new" && mv "$CORPUS_SYNC_STATUS.new" "$CORPUS_SYNC_STATUS"
exit $status
