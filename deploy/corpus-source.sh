#!/bin/sh
# Forced command for corpus-mcp's sync key on the Calibre-Web host (authorized_keys:
# restrict,command="<this script>"). It allows exactly these commands, never a shell:
#   - read-only rsync of the library, through rrsync (the refresh pull)
#   - "shelves": Calibre-Web's public shelves and their book ids as JSON, read from app.db
#     read-only, so the corpus LXC never copies app.db (which also holds password hashes)
#   - "tags-preview" / "tags-apply": calibre-tags.sh with a plan on stdin (/admin's tag jobs)
#   - "convert-preview" / "convert-apply": calibre-convert.sh (/admin's EPUB job)
# The two scripts back up metadata.db before every apply. Installed by tools/deploy.mjs
# (--source-setup or --source-setup-user-key), which sets the paths below.
RSYNC_ROOT="/mnt/Calibre/main"
LIBRARY="/mnt/Calibre/main"
TOOLS_DIR="/usr/local/bin"
APP_DB="/opt/calibre-web/data/app.db"

case "$SSH_ORIGINAL_COMMAND" in
  "rsync --server --sender "*)
    exec /usr/bin/rrsync -ro "$RSYNC_ROOT"
    ;;
  shelves)
    exec python3 - "$APP_DB" <<'EOF'
import json, sqlite3, sys
from datetime import datetime, timezone
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
shelves = [{"id": i, "name": n, "books": []} for i, n in db.execute("SELECT id, name FROM shelf WHERE is_public = 1 ORDER BY id")]
by_id = {s["id"]: s for s in shelves}
for shelf, book, order in db.execute('SELECT shelf, book_id, "order" FROM book_shelf_link ORDER BY shelf, "order", id'):
    if shelf in by_id:
        by_id[shelf]["books"].append({"book_id": book, "order": order})
json.dump({"exported_at": datetime.now(timezone.utc).isoformat(), "shelves": shelves}, sys.stdout)
EOF
    ;;
  tags-preview|tags-apply)
    TAG_PLAN="$(base64 -w0)"
    export TAG_PLAN
    if [ "$SSH_ORIGINAL_COMMAND" = tags-apply ]; then
      exec bash "$TOOLS_DIR/calibre-tags.sh" --apply "$LIBRARY"
    fi
    exec bash "$TOOLS_DIR/calibre-tags.sh" "$LIBRARY"
    ;;
  convert-preview)
    exec bash "$TOOLS_DIR/calibre-convert.sh" "$LIBRARY"
    ;;
  convert-apply)
    exec bash "$TOOLS_DIR/calibre-convert.sh" --apply "$LIBRARY"
    ;;
  *)
    echo "corpus-source: only read-only rsync, 'shelves', and the tags-/convert- commands are allowed" >&2
    exit 1
    ;;
esac
