#!/bin/sh
# Forced command for corpus-mcp's sync key on the Calibre-Web host (authorized_keys:
# restrict,command="<this script>"). It allows exactly two things:
#   - read-only rsync of the library, through rrsync
#   - "shelves": Calibre-Web's public shelves and their book ids as JSON, read from app.db
#     read-only, so the corpus LXC never copies app.db (which also holds password hashes)
# Installed by tools/deploy.mjs (--source-setup or --source-setup-user-key), which sets these two paths.
RSYNC_ROOT="/mnt/Calibre/main"
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
  *)
    echo "corpus-source: only read-only rsync and 'shelves' are allowed" >&2
    exit 1
    ;;
esac
