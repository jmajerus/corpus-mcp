#!/bin/bash
# Adds an EPUB to every book in a Calibre library that has MOBI or AZW3 but no EPUB, so corpus-mcp
# can cite it by chapter (MuPDF reads no outline from MOBI). Runs on the Calibre host, as the
# library's owner, with the same ebook-convert + calibredb add_format calls Calibre-Web makes.
#
#   calibre-convert.sh [--apply] [library]     (default library: /mnt/Calibre/main)
#
# Without --apply it only lists the books. With --apply it backs up metadata.db first, converts
# each book in a temporary directory, adds the EPUB with --dont-replace, and keeps the source format.
set -euo pipefail

apply=0
[ "${1:-}" = "--apply" ] && { apply=1; shift; }
library="${1:-/mnt/Calibre/main}"
bin="${CALIBRE_BIN:-/usr/bin}"

books=$(python3 - "$library" <<'EOF'
import sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}/metadata.db?mode=ro", uri=True)
rows = db.execute("""
  SELECT b.id, b.path, d.name, LOWER(d.format), b.title FROM books b JOIN data d ON d.book = b.id
  WHERE LOWER(d.format) IN ('mobi', 'azw3')
    AND NOT EXISTS (SELECT 1 FROM data e WHERE e.book = b.id AND LOWER(e.format) = 'epub')
  ORDER BY b.id, CASE LOWER(d.format) WHEN 'azw3' THEN 0 ELSE 1 END""")
seen = set()
for id_, path, name, fmt, title in rows:
    if id_ in seen:
        continue  # one source per book; AZW3 (KF8) converts better than old MOBI
    seen.add(id_)
    print(f"{id_}\t{path}/{name}.{fmt}\t{title}")
EOF
)

count=$(printf '%s' "$books" | grep -c . || true)
echo "$count book(s) in $library have MOBI or AZW3 but no EPUB."
[ "$count" -eq 0 ] && exit 0
if [ "$apply" -eq 0 ]; then
  printf '%s\n' "$books" | awk -F'\t' '{ printf "  %5s  %s\n", $1, $3 }'
  echo "Run again with --apply to convert them."
  exit 0
fi

backup="$library/metadata.db.before-epub-$(date +%Y%m%d-%H%M%S)"
cp -p "$library/metadata.db" "$backup"
echo "Backed up metadata.db to $backup"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ok=0 failed=0
while IFS=$'\t' read -r id source title; do
  out="$work/$id.epub"
  if "$bin/ebook-convert" "$library/$source" "$out" > "$work/$id.log" 2>&1 \
     && "$bin/calibredb" add_format --dont-replace --with-library "$library" "$id" "$out" >> "$work/$id.log" 2>&1; then
    echo "  ok      $id  $title"
    ok=$((ok + 1))
  else
    echo "  FAILED  $id  $title"
    tail -3 "$work/$id.log" | sed 's/^/          /'
    failed=$((failed + 1))
  fi
  rm -f "$out"
done <<< "$books"
echo "$ok converted, $failed failed. corpus-mcp picks up the EPUBs on its next refresh."
[ "$failed" -eq 0 ]
