#!/bin/sh
# Forced command for corpus-mcp's sync key on the Calibre-Web host (authorized_keys:
# restrict,command="<this script>"). It allows exactly these commands, never a shell:
#   - "library": where Calibre-Web's library is, as JSON (see below)
#   - "calibre-library": the library path for Calibre's own tools (refused in split mode)
#   - "catalogue": a consistent snapshot of the library's metadata.db (SQLite backup API)
#   - read-only rsync of the library's book files, through rrsync (the refresh pull)
#   - "shelves": Calibre-Web's public shelves and their book ids as JSON, read from app.db
#     read-only, so the corpus LXC never copies app.db (which also holds password hashes)
#   - "tags-preview" / "tags-apply": calibre-tags.sh with a plan on stdin (/admin's tag jobs)
#   - "convert-preview" / "convert-apply": calibre-convert.sh (/admin's EPUB job)
# Metadata corrections use metadata-preview / metadata-apply with JSON on stdin.
# The write scripts back up metadata.db before every apply. Installed by tools/deploy.mjs
# (--source-setup or --source-setup-user-key), which sets TOOLS_DIR.
#
# Where the library is comes from Calibre-Web's own settings in app.db, read on every call:
# config_calibre_dir holds metadata.db, and in split mode (config_calibre_split) the book files
# live under config_calibre_split_dir instead. Nothing here names the library's path, so moving
# the library in Calibre-Web moves the sync with it.
TOOLS_DIR="/usr/local/bin"
APP_DB="/opt/calibre-web/data/app.db"

# Prints Calibre-Web's library as JSON ("json") or as shell-readable lines ("lines"):
# metadata dir, 1 if split, book files dir, and 1 if the book files dir would expose app.db.
calibre_web_library() {
  python3 - "$APP_DB" "$1" <<'EOF'
import json, os, sqlite3, sys
app_db, form = sys.argv[1], sys.argv[2]
def fail(message):
    sys.exit(f"corpus-source: {message}")
try:
    db = sqlite3.connect(f"file:{app_db}?mode=ro", uri=True)
    columns = {r[1] for r in db.execute("PRAGMA table_info(settings)")}
    wanted = ["config_calibre_dir"] + [c for c in ("config_calibre_split", "config_calibre_split_dir") if c in columns]
    row = dict(zip(wanted, db.execute(f"SELECT {', '.join(wanted)} FROM settings").fetchone() or ()))
except sqlite3.Error as error:
    fail(f"cannot read Calibre-Web's settings from {app_db}: {error}")
metadata_dir = row.get("config_calibre_dir") or ""
split = bool(row.get("config_calibre_split"))
books_dir = (row.get("config_calibre_split_dir") or "") if split else metadata_dir
for name, value in (("library location (config_calibre_dir)", metadata_dir), ("book files location (config_calibre_split_dir)", books_dir)):
    if not value or not os.path.isabs(value) or "\n" in value:
        fail(f"Calibre-Web's {name} is not an absolute path: {value!r}")
    if not os.path.isdir(value):
        fail(f"Calibre-Web's {name} {value} is not a directory")
metadata_dir, books_dir = os.path.normpath(metadata_dir), os.path.normpath(books_dir)
if not os.path.isfile(os.path.join(metadata_dir, "metadata.db")):
    fail(f"no metadata.db in Calibre-Web's library location {metadata_dir}")
# rrsync serves everything under the book files dir, so it must not hold app.db (password hashes).
books_real, app_real = os.path.realpath(books_dir), os.path.realpath(os.path.dirname(app_db))
exposes_app_db = app_real == books_real or app_real.startswith(books_real.rstrip(os.sep) + os.sep)
if form == "json":
    print(json.dumps({"metadata_dir": metadata_dir, "books_dir": books_dir, "split": split}, sort_keys=True))
else:
    print(metadata_dir, int(split), books_dir, int(exposes_app_db), sep="\n")
EOF
}

# Sets METADATA_DIR, SPLIT, BOOKS_DIR, and EXPOSES_APP_DB, or exits with Calibre-Web's problem.
resolve_library() {
  paths=$(calibre_web_library lines) || exit 1
  METADATA_DIR=$(printf '%s\n' "$paths" | sed -n 1p)
  SPLIT=$(printf '%s\n' "$paths" | sed -n 2p)
  BOOKS_DIR=$(printf '%s\n' "$paths" | sed -n 3p)
  EXPOSES_APP_DB=$(printf '%s\n' "$paths" | sed -n 4p)
}

# Calibre's own tools (calibredb, calibre-debug) expect the book files beside metadata.db, so in
# split mode they would put new files in the wrong place. The write jobs refuse instead.
require_unsplit() {
  resolve_library
  if [ "$SPLIT" = 1 ]; then
    echo "corpus-source: Calibre-Web keeps this library split (metadata.db in $METADATA_DIR, book files in $BOOKS_DIR). Calibre's own tools, which this job runs, can't write to a split library. Turn off \"Separate Book Files from Library\" in Calibre-Web's database settings to use it." >&2
    exit 1
  fi
  LIBRARY="$METADATA_DIR"
}

case "$SSH_ORIGINAL_COMMAND" in
  library)
    calibre_web_library json
    ;;
  calibre-library)
    # The library path for Calibre's own tools, or why they can't use it; the hand-run scripts
    # beside this one (calibre-import.sh and friends) default to it.
    require_unsplit
    printf '%s\n' "$LIBRARY"
    ;;
  catalogue)
    resolve_library
    exec python3 - "$METADATA_DIR/metadata.db" <<'EOF'
import os, shutil, sqlite3, sys, tempfile
# The backup API copies a consistent snapshot even while Calibre-Web is writing.
source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=60)
with tempfile.TemporaryDirectory() as tmp:
    copy = os.path.join(tmp, "metadata.db")
    target = sqlite3.connect(copy)
    source.backup(target)
    target.close()
    with open(copy, "rb") as f:
        shutil.copyfileobj(f, sys.stdout.buffer)
EOF
    ;;
  "rsync --server --sender "*)
    resolve_library
    if [ "$EXPOSES_APP_DB" = 1 ]; then
      echo "corpus-source: Calibre-Web's book files location $BOOKS_DIR also holds app.db, so it won't be served" >&2
      exit 1
    fi
    exec /usr/bin/rrsync -ro "$BOOKS_DIR"
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
    require_unsplit
    TAG_PLAN="$(base64 -w0)"
    export TAG_PLAN
    if [ "$SSH_ORIGINAL_COMMAND" = tags-apply ]; then
      exec bash "$TOOLS_DIR/calibre-tags.sh" --apply "$LIBRARY"
    fi
    exec bash "$TOOLS_DIR/calibre-tags.sh" "$LIBRARY"
    ;;
  duplicates-preview|duplicates-apply)
    require_unsplit
    if [ "$SSH_ORIGINAL_COMMAND" = duplicates-apply ]; then
      exec /usr/bin/calibre-debug -e "$TOOLS_DIR/calibre-duplicates.py" -- "$LIBRARY" "$APP_DB" --apply
    fi
    exec /usr/bin/calibre-debug -e "$TOOLS_DIR/calibre-duplicates.py" -- "$LIBRARY" "$APP_DB"
    ;;
  metadata-preview)
    require_unsplit
    exec python3 "$TOOLS_DIR/calibre-metadata.py" "$LIBRARY"
    ;;
  metadata-apply)
    require_unsplit
    exec python3 "$TOOLS_DIR/calibre-metadata.py" --apply "$LIBRARY"
    ;;
  convert-preview)
    require_unsplit
    exec bash "$TOOLS_DIR/calibre-convert.sh" "$LIBRARY"
    ;;
  convert-apply)
    require_unsplit
    exec bash "$TOOLS_DIR/calibre-convert.sh" --apply "$LIBRARY"
    ;;
  *)
    echo "corpus-source: only 'library', 'calibre-library', 'catalogue', read-only rsync, 'shelves', and the tags-/convert- commands are allowed, plus metadata-preview, metadata-apply, duplicates-preview and duplicates-apply" >&2
    exit 1
    ;;
esac
