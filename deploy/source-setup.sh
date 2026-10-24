#!/bin/bash
# One-time setup on calibre-web.localdomain (CT 115). Runs as root (tools/deploy.mjs --source-setup).
# Adds a corpus-sync user whose only permission is read-only rsync under /mnt/Calibre,
# with the private library denied by ACL.
# Expects CORPUS_PUBKEY: the corpus LXC's public key printed by provision.sh.
set -euo pipefail

: "${CORPUS_PUBKEY:?CORPUS_PUBKEY is required}"
case "$CORPUS_PUBKEY" in ssh-ed25519\ *) ;; *) echo "CORPUS_PUBKEY is not an ed25519 public key" >&2; exit 1 ;; esac

id corpus-sync >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh corpus-sync
passwd -l corpus-sync >/dev/null
install -d -o corpus-sync -g corpus-sync -m 0700 /home/corpus-sync/.ssh
echo "restrict,command=\"/usr/bin/rrsync -ro /mnt/Calibre\" $CORPUS_PUBKEY" > /home/corpus-sync/.ssh/authorized_keys
chown corpus-sync:corpus-sync /home/corpus-sync/.ssh/authorized_keys
chmod 0600 /home/corpus-sync/.ssh/authorized_keys

# rrsync exposes all of /mnt/Calibre; deny the private library outright.
command -v setfacl >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q acl
setfacl -m u:corpus-sync:--- /mnt/Calibre/private
echo "corpus-sync ready"
