#!/bin/bash
# Adds a readable format to every book in a Calibre library that has neither an EPUB nor a PDF, only
# MOBI, AZW, AZW3, PRC, or KFX, so corpus-mcp can index and cite it (MuPDF reads no outline from MOBI,
# and the indexer cannot read KFX at all). Runs on the Calibre host, as the library's owner, whose
# calibre has the KFX Input plugin.
#
#   calibre-convert.sh [--apply] [library]     (default: Calibre-Web's library)
#
#   - MOBI, AZW, AZW3, PRC and reflowable KFX become an EPUB, with the same ebook-convert call
#     Calibre-Web makes.
#   - Print-replica KFX (fixed-layout textbooks that wrap a publisher's PDF) gives up that PDF, through
#     KFX Input's own command line; ebook-convert hangs on these. If no PDF comes out, it falls back to EPUB.
#   - DRM-encrypted files (a KFX "DRMION" container, or a MOBI with an encryption type) are listed but
#     never attempted: download the book again and add it through DeDRM.
#
# Without --apply it only lists the books and what each would get. With --apply it backs up metadata.db
# first, converts each book in a temporary directory with a time limit (CONVERT_TIMEOUT seconds, default
# 600), adds the result with --dont-replace, and keeps the source format.
set -euo pipefail

apply=0
[ "${1:-}" = "--apply" ] && { apply=1; shift; }
# Without a library argument, Calibre-Web's library, from its own settings (asked of corpus-source,
# installed beside this script); refused if Calibre-Web keeps the library split.
library="${1:-$(SSH_ORIGINAL_COMMAND=calibre-library "$(dirname "$0")/corpus-source")}"
bin="${CALIBRE_BIN:-/usr/bin}"
limit="${CONVERT_TIMEOUT:-600}"

books=$(python3 - "$library" <<'EOF'
import json, sqlite3, sys

SOURCES = ('azw3', 'kfx', 'azw', 'mobi', 'prc')  # one source per book, in this order: KF8 converts best


def sniff(path):
    """What the file really is, whatever its extension: (kind, problem)."""
    with open(path, 'rb') as f:
        head = f.read(128)
        if head.startswith(b'\xeaDRMION\xee'):
            return 'kfx', 'encrypted'
        if head.startswith(b'CONT'):
            data = head + f.read()
            replica = b'%PDF-' in data and (b'yj_textbook' in data or b'yj_fixed_layout' in data)
            return ('kfx-replica' if replica else 'kfx'), None
        if head[60:68] in (b'BOOKMOBI', b'TEXtREAd'):
            f.seek(int.from_bytes(head[78:82], 'big'))  # record 0: the PalmDOC header
            record = f.read(16)
            return 'mobi', ('encrypted' if int.from_bytes(record[12:14], 'big') else None)
    return None, 'unrecognized'


db = sqlite3.connect(f"file:{sys.argv[1]}/metadata.db?mode=ro", uri=True)
formats = {}
for book, fmt in db.execute('SELECT book, LOWER(format) FROM data'):
    formats.setdefault(book, set()).add(fmt)
for id_, path, title, uuid in db.execute('SELECT id, path, title, uuid FROM books ORDER BY id'):
    have = formats.get(id_, set())
    if 'epub' in have or 'pdf' in have:
        continue
    fmt = next((f for f in SOURCES if f in have), None)
    if fmt is None:
        continue
    name = db.execute('SELECT name FROM data WHERE book = ? AND LOWER(format) = ?', (id_, fmt)).fetchone()[0]
    source = f'{path}/{name}.{fmt}'
    try:
        kind, problem = sniff(f'{sys.argv[1]}/{source}')
    except OSError as error:
        kind, problem = None, f'unreadable ({error.strerror})'
    action = problem or ('pdf' if kind == 'kfx-replica' else 'epub')
    # The last field is the change as JSON, printed as an "@@change" line for /admin's change table.
    item = {"calibre_id": id_, "uuid": uuid, "title": title, "source_format": fmt}
    item.update({"convert_skipped": problem} if problem else {"added_format": action})
    print(f"{id_}\t{source}\t{title}\t{action}\t{json.dumps(item)}")
EOF
)

count=$(printf '%s' "$books" | grep -c . || true)
todo=$(printf '%s' "$books" | awk -F'\t' '$4 == "epub" || $4 == "pdf"' | grep -c . || true)
echo "$count book(s) in $library have no EPUB or PDF, only MOBI, AZW, AZW3, PRC, or KFX; $todo can be converted."
[ "$count" -eq 0 ] && exit 0
describe() {
  case "$1" in
    epub) echo "EPUB" ;;
    pdf) echo "PDF from print replica" ;;
    encrypted) echo "SKIP: DRM-encrypted; download again and add through DeDRM" ;;
    *) echo "SKIP: $1 file" ;;
  esac
}
if [ "$apply" -eq 0 ]; then
  while IFS=$'\t' read -r id source title action item; do
    printf '  %5s  %s → %s\n@@change %s\n' "$id" "$title" "$(describe "$action")" "$item"
  done <<< "$books"
  [ "$todo" -gt 0 ] && echo "Run again with --apply to convert them."
  exit 0
fi

backup="$library/metadata.db.before-epub-$(date +%Y%m%d-%H%M%S)"
cp -p "$library/metadata.db" "$backup"
echo "Backed up metadata.db to $backup"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ok=0 failed=0 skipped=0
while IFS=$'\t' read -r id source title action item; do
  if [ "$action" != epub ] && [ "$action" != pdf ]; then
    echo "  skip    $id  $title: $(describe "$action")"
    skipped=$((skipped + 1)); continue
  fi
  out=""
  if [ "$action" = pdf ]; then
    # KFX Input writes <name>.pdf beside its input and exits 0 even when the book has no PDF to give.
    # A timeout or crash is a failure, not a reason to try EPUB, which hangs on these books.
    rc=0
    { mkdir "$work/$id" && cp -- "$library/$source" "$work/$id/book.kfx" &&
      timeout "$limit" "$bin/calibre-debug" -r "KFX Input" -- -p "$work/$id/book.kfx" "$work/$id.pdf"; } > "$work/$id.log" 2>&1 || rc=$?
    rm -rf "$work/$id"
    if [ "$rc" -eq 0 ] && [ -s "$work/$id.pdf" ]; then out="$work/$id.pdf"
    elif [ "$rc" -eq 0 ]; then action=epub; echo "  note    $id  no print-replica PDF; converting to EPUB instead"
    else action=failed; fi
  fi
  if [ "$action" = epub ]; then
    out="$work/$id.epub"
    timeout "$limit" "$bin/ebook-convert" "$library/$source" "$out" >> "$work/$id.log" 2>&1 || out=""
  fi
  if [ -n "$out" ] && [ -s "$out" ] && "$bin/calibredb" add_format --dont-replace --with-library "$library" "$id" "$out" >> "$work/$id.log" 2>&1; then
    echo "  ok      $id  $title → ${action^^}"
    printf '@@change %s\n' "$(printf '%s' "$item" | sed "s/\"added_format\": \"[a-z]*\"/\"added_format\": \"$action\"/")"
    ok=$((ok + 1))
  else
    echo "  FAILED  $id  $title (${action}; time limit ${limit}s)"
    tail -3 "$work/$id.log" | sed 's/^/          /'
    failed=$((failed + 1))
  fi
  rm -f "$work/$id.epub" "$work/$id.pdf"
done <<< "$books"
echo "$ok converted, $failed failed, $skipped skipped. corpus-mcp picks up the new files on its next refresh."
[ "$failed" -eq 0 ]
