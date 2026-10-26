#!/bin/bash
# Adds every ebook file in a staging folder to a Calibre library, tagging each book. Runs on the
# Calibre host as the library's owner, whose calibre has the DeDRM plugin (with the Kindle keyfile
# imported) and KFX Input, so Kindle .kfx-zip archives are decrypted as they are added.
#
#   calibre-import.sh [--apply] [--tags kindle,...] <folder> [library]   (default library: /mnt/Calibre/main)
#
# Without --apply it lists the files. With --apply it backs up metadata.db first, then adds one file
# at a time and moves it into _done/, _duplicates/ (calibre already has that title and author), or
# _failed/ inside the folder. A .kfx-zip that is still encrypted after the add (calibre lists it as
# KFX-ZIP, not KFX) is removed from the library again and counts as failed. Afterwards, the /admin
# EPUB job converts MOBI, AZW3, and KFX books so corpus-mcp can cite them by chapter.
set -euo pipefail

apply=0 tags=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --tags) tags="$2"; shift 2 ;;
    *) break ;;
  esac
done
folder="${1:?usage: calibre-import.sh [--apply] [--tags a,b] <folder> [library]}"
library="${2:-/mnt/Calibre/main}"
bin="${CALIBRE_BIN:-/usr/bin}"

# The _done, _duplicates, and _failed folders hold files already handled, so they are never re-added.
mapfile -d '' files < <(find "$folder" -type d -name '_*' -prune -o -type f \
  \( -iname '*.pdf' -o -iname '*.epub' -o -iname '*.mobi' -o -iname '*.azw' -o -iname '*.azw3' -o -iname '*.kfx-zip' \) \
  -print0 | sort -z)

count=${#files[@]}
echo "${count} file(s) in $folder to add to $library${tags:+, tagged $tags}."
[ "$count" -eq 0 ] && exit 0
if [ "$apply" -eq 0 ]; then
  for f in "${files[@]}"; do printf '%s\n' "${f##*.}"; done | tr '[:upper:]' '[:lower:]' | sort | uniq -c | sed 's/^/  /'
  for f in "${files[@]}"; do printf '  %s\n' "${f#"$folder"/}"; done
  echo "Run again with --apply to add them."
  exit 0
fi

backup="$library/metadata.db.before-import-$(date +%Y%m%d-%H%M%S)"
cp -p "$library/metadata.db" "$backup"
echo "Backed up metadata.db to $backup"

# Moves a handled file under _<outcome>/, keeping its path below the folder.
file_away() {
  local dest="$folder/_$1/${2#"$folder"/}"
  mkdir -p "$(dirname "$dest")"
  mv -- "$2" "$dest"
}

ok=0 dup=0 failed=0
for f in "${files[@]}"; do
  name="${f#"$folder"/}"
  if ! out=$("$bin/calibredb" add --with-library "$library" ${tags:+--tags "$tags"} -- "$f" 2>&1); then
    echo "  FAILED  $name"
    printf '%s\n' "$out" | tail -3 | sed 's/^/          /'
    file_away failed "$f"; failed=$((failed + 1)); continue
  fi
  id=$(printf '%s\n' "$out" | sed -n 's/^Added book ids: *\([0-9]*\).*/\1/p' | head -1)
  if [ -z "$id" ]; then
    echo "  dup     $name"
    file_away duplicates "$f"; dup=$((dup + 1)); continue
  fi
  formats=$("$bin/calibredb" list --with-library "$library" --search "id:$id" --fields formats --for-machine)
  if printf '%s' "$formats" | grep -qi '\.kfx-zip"'; then
    "$bin/calibredb" remove --permanent --with-library "$library" "$id" >/dev/null
    echo "  FAILED  $name: still encrypted (is the keyfile imported into DeDRM?)"
    file_away failed "$f"; failed=$((failed + 1)); continue
  fi
  echo "  ok      $id  $name"
  file_away done "$f"; ok=$((ok + 1))
done
echo "$ok added, $dup duplicates, $failed failed. corpus-mcp picks them up on its next refresh."
[ "$failed" -eq 0 ]
