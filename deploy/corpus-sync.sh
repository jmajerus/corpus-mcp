#!/bin/sh
# Pulls a read-only mirror of the allowlisted Calibre libraries from calibre-web.localdomain.
# Only metadata.db and the formats the indexer reads are copied. The source key is restricted
# with `rrsync -ro /mnt/Calibre`, so remote paths are relative to /mnt/Calibre. A key rooted at
# one library instead (`rrsync -ro /mnt/Calibre/main`) sets CORPUS_REMOTE_PATH=./
#
# It then fetches Calibre-Web's public shelves (the key's forced command answers "shelves") into
# CORPUS_SHELVES_FILE, replacing it only on success so a failed fetch keeps the previous membership.
#
# A metadata.db caught mid-write is either unreadable (the indexer keeps that library's previous
# index) or slightly stale; the next run corrects it.
set -eu

: "${CORPUS_SOURCE:=corpus-sync@calibre-web.localdomain}"
: "${CORPUS_BOOKS_ROOT:=/srv/corpus/books}"
: "${CORPUS_LIBRARIES:=main}"
: "${CORPUS_SSH_KEY:=/var/lib/corpus-mcp/.ssh/id_ed25519}"
: "${CORPUS_REMOTE_PATH:={library}/}"
: "${CORPUS_SHELVES_FILE:=/var/lib/corpus-mcp/shelves.json}"

status=0
for library in $(echo "$CORPUS_LIBRARIES" | tr ',' ' '); do
  mkdir -p "$CORPUS_BOOKS_ROOT/$library"
  remote=$(echo "$CORPUS_REMOTE_PATH" | sed "s|{library}|$library|g")
  rsync -rt --delete --prune-empty-dirs --timeout=600 \
    -e "ssh -i $CORPUS_SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes" \
    --include='*/' --include='/metadata.db' \
    --include='*.pdf' --include='*.epub' --include='*.mobi' --include='*.azw3' \
    --exclude='*' \
    "$CORPUS_SOURCE:$remote" "$CORPUS_BOOKS_ROOT/$library/" || {
      echo "sync of $library failed" >&2
      status=1
    }
done
if ssh -i "$CORPUS_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes "$CORPUS_SOURCE" shelves > "$CORPUS_SHELVES_FILE.new" \
   && [ -s "$CORPUS_SHELVES_FILE.new" ]; then
  mv "$CORPUS_SHELVES_FILE.new" "$CORPUS_SHELVES_FILE"
else
  echo "shelf export failed; keeping the previous shelves" >&2
  rm -f "$CORPUS_SHELVES_FILE.new"
  status=1
fi
exit $status
