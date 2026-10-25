#!/usr/bin/env node
// Deploys corpus-mcp to its LXC (corpus-mcp.localdomain), on the pattern of concept-clusters'
// zotero-deploy: SSH as the shared `authoring` login, one `sudo -S` call per host with the
// password piped on stdin, health check, and rollback to the previous release on failure.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORPUS_HOST = process.env.CORPUS_DEPLOY_HOST ?? "authoring@corpus-mcp.localdomain";
const SOURCE_HOST = process.env.CORPUS_SOURCE_ADMIN_HOST ?? "authoring@calibre-web.localdomain";
const ASKPASS = path.join(root, "tools", "askpass.mjs");

const USAGE = `Usage: npm run deploy -- [--provision | --source-setup | --source-setup-user-key | --skip-tests]

  (no flag)       build, test, install a new release, restart, health-check, roll back on failure
  --provision     one-time setup of the corpus LXC (Node 22, corpus user, sync key); prints the key
  --source-setup  one-time setup on calibre-web.localdomain: a corpus-sync user limited to
                  read-only rsync of /mnt/Calibre (private denied), keyed to the corpus LXC
  --source-setup-user-key
                  the same without root on calibre-web: adds the sync key to authoring's own
                  authorized_keys, forced to read-only rsync of /mnt/Calibre/main, and points
                  the corpus LXC's env at it
  --skip-tests    deploy without running the test suite first

Needs AUTHORING_DEPLOY_PASSWORD (npm run deploy loads ../concept-clusters/.env when present).`;

const password = process.env.AUTHORING_DEPLOY_PASSWORD;

function sshEnv() {
  return { ...process.env, SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || "corpus-deploy" };
}

const sshOptions = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];

/** Runs a bash script as root on a host; resolves with its stdout (also echoed). */
function runAsRoot(host, script, env = {}) {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join("");
  const encoded = Buffer.from(exports + script).toString("base64");
  const command = `sudo -S -p '' bash -c "$(printf %s '${encoded}' | base64 -d)"`;
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", [...sshOptions, host, command], { env: sshEnv(), stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    ssh.stdout.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    ssh.stdin.end(`${password}\n`);
    ssh.on("error", reject);
    ssh.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${host}: remote script exited with ${code}`))));
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readScript(name) {
  return fs.readFileSync(path.join(root, "deploy", name), "utf8");
}

async function provision() {
  const out = await runAsRoot(CORPUS_HOST, readScript("provision.sh"));
  if (!/^pubkey=ssh-ed25519 /m.test(out)) throw new Error("provision.sh did not report the sync key.");
  console.log("\nProvisioned. Next: npm run deploy -- --source-setup");
}

async function sourceSetup() {
  const out = await runAsRoot(CORPUS_HOST, "echo \"pubkey=$(cat /var/lib/corpus-mcp/.ssh/id_ed25519.pub)\"");
  const pubkey = out.match(/^pubkey=(ssh-ed25519 \S+ \S+)$/m)?.[1];
  if (!pubkey) throw new Error("No sync key on the corpus LXC. Run --provision first.");
  await runAsRoot(SOURCE_HOST, readScript("source-setup.sh"), { CORPUS_PUBKEY: pubkey });
  console.log("\nSource ready. Next: npm run deploy");
}

/** Runs a command as the login user (no sudo); resolves with its stdout. */
function runAsUser(host, command) {
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", [...sshOptions, host, command], { env: sshEnv(), stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    ssh.stdout.on("data", (chunk) => (out += chunk));
    ssh.on("error", reject);
    ssh.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${host}: exited with ${code}`))));
  });
}

async function sourceSetupUserKey() {
  const out = await runAsRoot(CORPUS_HOST, "echo \"pubkey=$(cat /var/lib/corpus-mcp/.ssh/id_ed25519.pub)\"");
  const pubkey = out.match(/^pubkey=(ssh-ed25519 \S+ \S+)$/m)?.[1];
  if (!pubkey) throw new Error("No sync key on the corpus LXC. Run --provision first.");
  const line = `restrict,command="/usr/bin/rrsync -ro /mnt/Calibre/main" ${pubkey}`;
  const sourceUser = SOURCE_HOST.split("@")[0];
  await runAsUser(SOURCE_HOST, [
    "set -eu",
    "install -d -m 0700 ~/.ssh",
    "touch ~/.ssh/authorized_keys && chmod 0600 ~/.ssh/authorized_keys",
    `grep -qF ${shellQuote(pubkey)} ~/.ssh/authorized_keys || echo ${shellQuote(line)} >> ~/.ssh/authorized_keys`,
  ].join("\n"));
  await runAsRoot(CORPUS_HOST, `
set -euo pipefail
install -d -m 0755 /etc/corpus-mcp
[ -f /etc/corpus-mcp/env ] || touch /etc/corpus-mcp/env
set_env() { grep -q "^$1=" /etc/corpus-mcp/env && sed -i "s|^$1=.*|$1=$2|" /etc/corpus-mcp/env || echo "$1=$2" >> /etc/corpus-mcp/env; }
set_env CORPUS_SOURCE ${sourceUser}@calibre-web.localdomain
set_env CORPUS_LIBRARIES main
set_env CORPUS_REMOTE_PATH ./
echo "env updated"`);
  console.log("\nSource key installed. Next: npm run deploy");
}

async function deploy({ skipTests }) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (!skipTests) execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });

  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const tarball = path.join(os.tmpdir(), `corpus-mcp-${id}.tgz`);
  execFileSync("tar", ["czf", tarball, "-C", root, "dist", "deploy", "package.json", "package-lock.json"]);
  execFileSync("scp", [...sshOptions, tarball, `${CORPUS_HOST}:/tmp/`], { env: sshEnv(), stdio: "inherit" });
  fs.rmSync(tarball);

  const script = `
set -euo pipefail
release=/opt/corpus-mcp/releases/${id}
mkdir -p "$release"
tar xzf /tmp/corpus-mcp-${id}.tgz -C "$release"
rm -f /tmp/corpus-mcp-${id}.tgz
cd "$release"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chmod +x deploy/*.sh
[ -f /etc/corpus-mcp/env ] || install -m 0644 deploy/corpus-mcp.env.example /etc/corpus-mcp/env
install -m 0644 deploy/corpus-mcp.service deploy/corpus-refresh.service deploy/corpus-refresh.timer \
  deploy/corpus-backup.service deploy/corpus-backup.timer /etc/systemd/system/
previous=$(readlink /opt/corpus-mcp/current || true)
echo "previous=$previous"
ln -sfn "$release" /opt/corpus-mcp/current.new && mv -T /opt/corpus-mcp/current.new /opt/corpus-mcp/current
systemctl daemon-reload
systemctl enable --quiet corpus-mcp.service corpus-refresh.timer corpus-backup.timer
systemctl start corpus-refresh.timer corpus-backup.timer

. /etc/corpus-mcp/env
: "\${CORPUS_DB:=/var/lib/corpus-mcp/corpus.db}" "\${CORPUS_PORT:=8000}"
if [ ! -f "$CORPUS_DB" ]; then
  systemctl start --no-block corpus-refresh.service
  systemctl restart corpus-mcp.service
  echo "installed=${id} (first sync and index started; the server starts once the index exists)"
  exit 0
fi
# Migrate the index schema and refresh metadata with the new code before the server restarts.
# A start while the timer's run is in progress waits for that run instead.
systemctl start corpus-refresh.service || echo "refresh failed; continuing to the health check"
systemctl restart corpus-mcp.service
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$CORPUS_PORT/health"; then echo; echo "installed=${id}"; break; fi
  sleep 1
done
if ! curl -sf -o /dev/null "http://127.0.0.1:$CORPUS_PORT/health"; then
  journalctl -u corpus-mcp.service -n 20 --no-pager || true
  if [ -n "$previous" ]; then
    ln -sfn "$previous" /opt/corpus-mcp/current
    systemctl restart corpus-mcp.service
    echo "rolled_back=$previous"
  fi
  exit 1
fi
ls -1dt /opt/corpus-mcp/releases/* | tail -n +4 | xargs -r rm -rf
`;
  await runAsRoot(CORPUS_HOST, script);
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const known = new Set(["--provision", "--source-setup", "--source-setup-user-key", "--skip-tests"]);
  const unknown = argv.find((a) => !known.has(a));
  if (unknown) throw new Error(`Unknown argument ${unknown}.\n\n${USAGE}`);
  if (!password) throw new Error(`AUTHORING_DEPLOY_PASSWORD is not set.\n\n${USAGE}`);
  if (argv.includes("--provision")) return provision();
  if (argv.includes("--source-setup")) return sourceSetup();
  if (argv.includes("--source-setup-user-key")) return sourceSetupUserKey();
  return deploy({ skipTests: argv.includes("--skip-tests") });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
