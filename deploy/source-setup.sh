#!/bin/bash
# One-time setup on calibre-web.localdomain (CT 115). Runs as root (tools/deploy.mjs --source-setup).
# Adds a corpus-sync user whose key runs only the forced command (deploy/corpus-source.sh), which
# finds the library from Calibre-Web's own settings.
# Expects CORPUS_PUBKEY (the corpus LXC's public key, printed by provision.sh) and
# CORPUS_SOURCE_SCRIPT (deploy/corpus-source.sh, base64), the key's forced command.
set -euo pipefail

: "${CORPUS_PUBKEY:?CORPUS_PUBKEY is required}"
: "${CORPUS_SOURCE_SCRIPT:?CORPUS_SOURCE_SCRIPT is required}"
case "$CORPUS_PUBKEY" in ssh-ed25519\ *) ;; *) echo "CORPUS_PUBKEY is not an ed25519 public key" >&2; exit 1 ;; esac

id corpus-sync >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh corpus-sync
passwd -l corpus-sync >/dev/null
install -d -o corpus-sync -g corpus-sync -m 0700 /home/corpus-sync/.ssh
printf %s "$CORPUS_SOURCE_SCRIPT" | base64 -d \
  | sed -e 's|^TOOLS_DIR=.*|TOOLS_DIR="/usr/local/bin"|' \
  > /usr/local/bin/corpus-source
printf %s "${CORPUS_TAGS_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-tags.sh
printf %s "${CORPUS_CONVERT_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-convert.sh
printf %s "${CORPUS_DUPLICATES_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-duplicates.py
printf %s "${CORPUS_METADATA_RECOVER_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-metadata-recover.py
printf %s "${CORPUS_METADATA_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-metadata.py
# For the library owner's bulk imports by hand; the forced command never runs it.
printf %s "${CORPUS_IMPORT_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-import.sh
chmod 0755 /usr/local/bin/calibre-duplicates.py /usr/local/bin/calibre-metadata-recover.py /usr/local/bin/calibre-metadata.py /usr/local/bin/corpus-source /usr/local/bin/calibre-tags.sh /usr/local/bin/calibre-convert.sh /usr/local/bin/calibre-import.sh
# /admin's Calibre commands write the library, so corpus-sync needs the group of each directory
# Calibre-Web's settings name (metadata.db's and, in split mode, the book files').
library_json=$(SSH_ORIGINAL_COMMAND=library /usr/local/bin/corpus-source)
for dir in $(printf %s "$library_json" | python3 -c 'import json, sys; d = json.load(sys.stdin); print(d["metadata_dir"]); print(d["books_dir"])' | sort -u); do
  group=$(stat -c %G "$dir")
  if getent group "$group" >/dev/null; then usermod -aG "$group" corpus-sync; fi
done
echo "restrict,command=\"/usr/local/bin/corpus-source\" $CORPUS_PUBKEY" > /home/corpus-sync/.ssh/authorized_keys
chown corpus-sync:corpus-sync /home/corpus-sync/.ssh/authorized_keys
chmod 0600 /home/corpus-sync/.ssh/authorized_keys

echo "corpus-sync ready"
