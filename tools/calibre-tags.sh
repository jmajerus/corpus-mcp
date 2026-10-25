#!/bin/bash
# Adds approved vocabulary tags to books in a Calibre library, keeping each book's existing tags.
# Runs on the Calibre-Web host as the library's owner (tools/apply-tags.mjs sends it there), with
# the plan from corpus-mcp's /api/tag-plan in TAG_PLAN (base64 JSON).
#
#   TAG_PLAN=<base64> calibre-tags.sh [--apply] [library]     (default library: /mnt/Calibre/main)
#
# Without --apply it lists the changes. With --apply it backs up metadata.db first, then sets each
# book's tags to its current tags plus the approved ones with calibredb set_metadata.
set -euo pipefail

apply=0
[ "${1:-}" = "--apply" ] && { apply=1; shift; }
library="${1:-/mnt/Calibre/main}"
bin="${CALIBRE_BIN:-/usr/bin}"
: "${TAG_PLAN:?TAG_PLAN is required}"

# One line per book: id<TAB>title<TAB>merged tags (comma-separated, as calibredb expects)<TAB>added.
changes=$(python3 - "$library" <<'EOF'
import base64, json, os, sqlite3, sys
plan = json.loads(base64.b64decode(os.environ["TAG_PLAN"]))
db = sqlite3.connect(f"file:{sys.argv[1]}/metadata.db?mode=ro", uri=True)
for book in plan["books"]:
    book_id, title = book["calibre_id"], book["title"]
    row = db.execute("SELECT uuid FROM books WHERE id = ?", (book_id,)).fetchone()
    if not row or row[0] != book["uuid"]:
        print(f"skip {book_id} {title}: that Calibre id no longer belongs to this book", file=sys.stderr)
        continue
    have = [t for (t,) in db.execute(
        "SELECT t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag WHERE l.book = ? ORDER BY t.name", (book_id,))]
    lower = {t.lower() for t in have}
    add = [t for t in book["add"] if t.lower() not in lower]
    if any("," in t for t in have + add):
        print(f"skip {book_id} {title}: a tag contains a comma, which calibredb would split", file=sys.stderr)
        continue
    if add:
        print("\t".join([str(book_id), title, ",".join(have + add), " | ".join(add)]))
EOF
)

count=$(printf '%s' "$changes" | grep -c . || true)
echo "$count book(s) in $library get new tags."
[ "$count" -eq 0 ] && exit 0
if [ "$apply" -eq 0 ]; then
  printf '%s\n' "$changes" | awk -F'\t' '{ printf "  %5s  %s\n         + %s\n", $1, $2, $4 }'
  echo "Run again with --apply to write them."
  exit 0
fi

backup="$library/metadata.db.before-tags-$(date +%Y%m%d-%H%M%S)"
cp -p "$library/metadata.db" "$backup"
echo "Backed up metadata.db to $backup"
ok=0 failed=0
while IFS=$'\t' read -r id title tags added; do
  if out=$("$bin/calibredb" set_metadata --with-library "$library" --field "tags:$tags" "$id" 2>&1); then
    echo "  ok      $id  $title  + $added"
    ok=$((ok + 1))
  else
    echo "  FAILED  $id  $title"
    printf '%s\n' "$out" | tail -2 | sed 's/^/          /'
    failed=$((failed + 1))
  fi
done <<< "$changes"
echo "$ok tagged, $failed failed. corpus-mcp picks up the tags on its next refresh."
[ "$failed" -eq 0 ]
