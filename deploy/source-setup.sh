#!/bin/bash
# One-time setup on calibre-web.localdomain (CT 115). Runs as root (tools/deploy.mjs --source-setup).
# Adds a corpus-sync user whose only permission is read-only rsync under /mnt/Calibre,
# with the private library denied by ACL.
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
  | sed -e 's|^RSYNC_ROOT=.*|RSYNC_ROOT="/mnt/Calibre"|' -e 's|^LIBRARY=.*|LIBRARY="/mnt/Calibre/main"|' -e 's|^TOOLS_DIR=.*|TOOLS_DIR="/usr/local/bin"|' \
  > /usr/local/bin/corpus-source
printf %s "${CORPUS_TAGS_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-tags.sh
printf %s "${CORPUS_CONVERT_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-convert.sh
# For the library owner's bulk imports by hand; the forced command never runs it.
printf %s "${CORPUS_IMPORT_SCRIPT:-}" | base64 -d > /usr/local/bin/calibre-import.sh
chmod 0755 /usr/local/bin/corpus-source /usr/local/bin/calibre-tags.sh /usr/local/bin/calibre-convert.sh /usr/local/bin/calibre-import.sh
# /admin's Calibre commands write the library, so corpus-sync needs the library owner's group.
if getent group "$(stat -c %G /mnt/Calibre/main)" >/dev/null; then usermod -aG "$(stat -c %G /mnt/Calibre/main)" corpus-sync; fi
echo "restrict,command=\"/usr/local/bin/corpus-source\" $CORPUS_PUBKEY" > /home/corpus-sync/.ssh/authorized_keys
chown corpus-sync:corpus-sync /home/corpus-sync/.ssh/authorized_keys
chmod 0600 /home/corpus-sync/.ssh/authorized_keys

# rrsync exposes all of /mnt/Calibre; deny the private library outright.
command -v setfacl >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q acl
setfacl -m u:corpus-sync:--- /mnt/Calibre/private
echo "corpus-sync ready"
