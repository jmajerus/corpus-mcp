#!/bin/bash
# One-time setup of the corpus-mcp LXC. Runs as root (tools/deploy.mjs --provision).
# Idempotent: rerunning it changes nothing that is already in place.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
apt-get install -y -q rsync openssh-client

id corpus >/dev/null 2>&1 || useradd --system --home-dir /var/lib/corpus-mcp --shell /usr/sbin/nologin corpus
install -d -o corpus -g corpus -m 0750 /var/lib/corpus-mcp /var/lib/corpus-mcp/.ssh
install -d -o corpus -g corpus -m 0755 /srv/corpus /srv/corpus/books
install -d -m 0755 /opt/corpus-mcp /opt/corpus-mcp/releases /etc/corpus-mcp

if [ ! -f /var/lib/corpus-mcp/.ssh/id_ed25519 ]; then
  sudo -u corpus ssh-keygen -q -t ed25519 -N '' -C "corpus-sync@$(hostname)" -f /var/lib/corpus-mcp/.ssh/id_ed25519
fi
# Pin calibre-web.localdomain's host key for the sync (StrictHostKeyChecking=yes).
if ! sudo -u corpus ssh-keygen -F calibre-web.localdomain -f /var/lib/corpus-mcp/.ssh/known_hosts >/dev/null 2>&1; then
  ssh-keyscan -t ed25519 calibre-web.localdomain 2>/dev/null >> /var/lib/corpus-mcp/.ssh/known_hosts
  chown corpus:corpus /var/lib/corpus-mcp/.ssh/known_hosts
fi

echo "pubkey=$(cat /var/lib/corpus-mcp/.ssh/id_ed25519.pub)"
