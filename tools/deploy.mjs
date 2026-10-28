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

const USAGE = `Usage: npm run deploy -- [--current | --pr <number> | --main] [--skip-tests]
       npm run deploy -- [--provision | --source-setup | --source-setup-user-key | --vocabulary[=file] | --zotero]

  (no flag)       build, test, install a new release, restart, health-check, roll back on failure
  --pr <number>   the same from an open pull request's head commit instead of this checkout: it is
                  checked out in a temporary worktree and its own deploy script runs there
  --main          the same from origin/main, to switch back after a pull request
  --current       the same from the latest commit of what the server was last deployed from: the
                  same pull request, or the same branch on origin (recorded in /var/lib/corpus-mcp/deployed.json)
  --provision     one-time setup of the corpus LXC (Node 22, corpus user, sync key); prints the key
  --source-setup  one-time setup on calibre-web.localdomain: a corpus-sync user limited to
                  read-only rsync of /mnt/Calibre (private denied), keyed to the corpus LXC
  --source-setup-user-key
                  the same without root on calibre-web: adds the sync key to authoring's own
                  authorized_keys, forced to read-only rsync of /mnt/Calibre/main, and points
                  the corpus LXC's env at it
  --vocabulary[=file]
                  validate the tag vocabulary (default CORPUS_VOCABULARY_SOURCE) and install it as
                  /var/lib/corpus-mcp/vocabulary.json; the server picks it up without a restart.
                  A plain deploy also installs it when CORPUS_VOCABULARY_SOURCE is set, unless the
                  intake is configured (CORPUS_VOCABULARY_PUSH_CLIENT_ID): then the owner pushes it.
  --zotero        copy CORPUS_ZOTERO_LIBRARY, CORPUS_ZOTERO_API_KEY, and CORPUS_ZOTERO_INTERVAL_MINUTES
                  from .env into the server's /etc/corpus-mcp/env (mode 0640) and restart it;
                  an empty CORPUS_ZOTERO_API_KEY turns the mirror off
  --skip-tests    deploy without running the test suite first

Needs AUTHORING_DEPLOY_PASSWORD (npm run deploy loads .env when present; see .env.example).`;

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
  await runAsRoot(SOURCE_HOST, readScript("source-setup.sh"), {
    CORPUS_PUBKEY: pubkey,
    CORPUS_SOURCE_SCRIPT: Buffer.from(readScript("corpus-source.sh")).toString("base64"),
    CORPUS_TAGS_SCRIPT: fs.readFileSync(path.join(root, "tools", "calibre-tags.sh")).toString("base64"),
    CORPUS_CONVERT_SCRIPT: fs.readFileSync(path.join(root, "tools", "calibre-convert.sh")).toString("base64"),
    CORPUS_IMPORT_SCRIPT: fs.readFileSync(path.join(root, "tools", "calibre-import.sh")).toString("base64"),
  });
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
  // The forced command (deploy/corpus-source.sh) allows read-only rsync of main, the shelf export, and
  // /admin's named Calibre commands, which run the two scripts installed beside it.
  const encode = (file) => Buffer.from(fs.readFileSync(path.join(root, file))).toString("base64");
  const sourceUser = SOURCE_HOST.split("@")[0];
  await runAsUser(SOURCE_HOST, [
    "set -eu",
    "install -d -m 0755 ~/.local/bin",
    `printf %s ${shellQuote(encode("deploy/corpus-source.sh"))} | base64 -d | sed`
      + ` -e 's|^RSYNC_ROOT=.*|RSYNC_ROOT="/mnt/Calibre/main"|' -e 's|^LIBRARY=.*|LIBRARY="/mnt/Calibre/main"|'`
      + ` -e "s|^TOOLS_DIR=.*|TOOLS_DIR=\\"$HOME/.local/bin\\"|" > ~/.local/bin/corpus-source`,
    `printf %s ${shellQuote(encode("tools/calibre-tags.sh"))} | base64 -d > ~/.local/bin/calibre-tags.sh`,
    `printf %s ${shellQuote(encode("tools/calibre-convert.sh"))} | base64 -d > ~/.local/bin/calibre-convert.sh`,
    // Not reachable through the forced command: the library owner runs it by hand for bulk imports.
    `printf %s ${shellQuote(encode("tools/calibre-import.sh"))} | base64 -d > ~/.local/bin/calibre-import.sh`,
    "chmod 0755 ~/.local/bin/corpus-source ~/.local/bin/calibre-tags.sh ~/.local/bin/calibre-convert.sh ~/.local/bin/calibre-import.sh",
    "install -d -m 0700 ~/.ssh",
    "touch ~/.ssh/authorized_keys && chmod 0600 ~/.ssh/authorized_keys",
    // Replace any earlier line for this key (it was forced to rrsync alone).
    `grep -vF ${shellQuote(pubkey)} ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.new || true`,
    // OpenSSH requires the command option quoted: restrict,command="…" ssh-ed25519 …
    `printf 'restrict,command="%s" %s\\n' "$HOME/.local/bin/corpus-source" ${shellQuote(pubkey)} >> ~/.ssh/authorized_keys.new`,
    "chmod 0600 ~/.ssh/authorized_keys.new && mv ~/.ssh/authorized_keys.new ~/.ssh/authorized_keys",
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

/** Validates a vocabulary file with the built loader, then installs it where the server reads it. */
async function pushVocabulary(file) {
  if (!file) throw new Error(`No vocabulary file: pass --vocabulary=<file> or set CORPUS_VOCABULARY_SOURCE.\n\n${USAGE}`);
  const { Vocabulary } = await import(path.join(root, "dist", "vocabulary.js"));
  const vocabulary = Vocabulary.load(path.resolve(file));
  const encoded = fs.readFileSync(file).toString("base64");
  await runAsRoot(CORPUS_HOST, `
set -euo pipefail
printf %s ${shellQuote(encoded)} | base64 -d > /var/lib/corpus-mcp/vocabulary.json.new
chown corpus:corpus /var/lib/corpus-mcp/vocabulary.json.new && chmod 0644 /var/lib/corpus-mcp/vocabulary.json.new
mv /var/lib/corpus-mcp/vocabulary.json.new /var/lib/corpus-mcp/vocabulary.json
echo "vocabulary=${vocabulary.version ?? "(no version)"} (${vocabulary.tags.length} assignable terms)"`);
}

/** Sets the Zotero settings in the server's env from this machine's .env, so the key never passes through a chat or a command line. */
async function pushZotero() {
  const library = process.env.CORPUS_ZOTERO_LIBRARY ?? "";
  const key = process.env.CORPUS_ZOTERO_API_KEY ?? "";
  if (key && !/^(users|groups)\/\d+$/.test(library)) throw new Error(`CORPUS_ZOTERO_LIBRARY should be "users/<user id>" or "groups/<group id>", not "${library}".`);
  const settings = { CORPUS_ZOTERO_LIBRARY: library, CORPUS_ZOTERO_API_KEY: key, CORPUS_ZOTERO_INTERVAL_MINUTES: process.env.CORPUS_ZOTERO_INTERVAL_MINUTES ?? "" };
  const encoded = Buffer.from(Object.entries(settings).map(([k, v]) => `${k}=${v}`).join("\n")).toString("base64");
  await runAsRoot(CORPUS_HOST, `
set -euo pipefail
f=/etc/corpus-mcp/env
printf %s ${shellQuote(encoded)} | base64 -d > /tmp/corpus-zotero.env
grep -v -e '^CORPUS_ZOTERO_LIBRARY=' -e '^CORPUS_ZOTERO_API_KEY=' -e '^CORPUS_ZOTERO_INTERVAL_MINUTES=' "$f" > "$f.new" || true
grep -v '=$' /tmp/corpus-zotero.env >> "$f.new" || true
rm -f /tmp/corpus-zotero.env
chown root:corpus "$f.new" && chmod 0640 "$f.new" && mv "$f.new" "$f"
systemctl restart corpus-mcp.service
sleep 2
. "$f"; curl -sf "http://127.0.0.1:\${CORPUS_PORT:-8000}/api/zotero" | head -c 300; echo`);
}

/** The vocabulary intake's service token (client id, Access audience) from this machine's .env, set on the server when given. */
function intakeSettings() {
  return ["CORPUS_VOCABULARY_PUSH_CLIENT_ID", "CORPUS_VOCABULARY_PUSH_AUD"].filter((name) => process.env[name])
    .map((name) => `sed -i '/^${name}=/d' /etc/corpus-mcp/env && echo ${shellQuote(`${name}=${process.env[name]}`)} >> /etc/corpus-mcp/env\n`).join("");
}

async function deploy({ skipTests }) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (!skipTests) execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });
  // Once the vocabulary's owner pushes it to the intake, a local copy could be older than what it pushed.
  if (process.env.CORPUS_VOCABULARY_SOURCE && !process.env.CORPUS_VOCABULARY_PUSH_CLIENT_ID) await pushVocabulary(process.env.CORPUS_VOCABULARY_SOURCE);

  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const tarball = path.join(os.tmpdir(), `corpus-mcp-${id}.tgz`);
  execFileSync("tar", ["czf", tarball, "-C", root, "dist", "deploy", "package.json", "package-lock.json",
    "packages/citekey/package.json", "packages/citekey/dist", "packages/citekey/cases.json"]);
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
# The dashboard's "Refresh now" (polkit) and the refresh log's rotation.
if [ -d /etc/polkit-1/rules.d ]; then install -m 0644 deploy/50-corpus-refresh.rules /etc/polkit-1/rules.d/; fi
if [ -d /etc/logrotate.d ]; then install -m 0644 deploy/corpus-mcp.logrotate /etc/logrotate.d/corpus-mcp; fi
touch /var/lib/corpus-mcp/refresh.log && chown corpus:corpus /var/lib/corpus-mcp/refresh.log
# Settings added after first install.
grep -q '^CORPUS_ACCESS_TEAM_DOMAIN=' /etc/corpus-mcp/env || echo 'CORPUS_ACCESS_TEAM_DOMAIN=https://linkbud.cloudflareaccess.com' >> /etc/corpus-mcp/env
grep -q '^CORPUS_ACCESS_AUD=' /etc/corpus-mcp/env || echo 'CORPUS_ACCESS_AUD=' >> /etc/corpus-mcp/env
${intakeSettings()}# The two settings needed below, read before the release is switched so a failure leaves the server as it
# was. The file is systemd's EnvironmentFile, not a shell script: a value with parentheses must not run as shell.
env_value() { sed -n "s/^$1=//p" /etc/corpus-mcp/env | tail -n 1 | tr -d '"'; }
CORPUS_DB=$(env_value CORPUS_DB); CORPUS_PORT=$(env_value CORPUS_PORT)
: "\${CORPUS_DB:=/var/lib/corpus-mcp/corpus.db}" "\${CORPUS_PORT:=8000}"
previous=$(readlink /opt/corpus-mcp/current || true)
echo "previous=$previous"
ln -sfn "$release" /opt/corpus-mcp/current.new && mv -T /opt/corpus-mcp/current.new /opt/corpus-mcp/current
systemctl daemon-reload
systemctl enable --quiet corpus-mcp.service corpus-refresh.timer corpus-backup.timer
systemctl start corpus-refresh.timer corpus-backup.timer

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
  if (!process.env.CORPUS_DEPLOY_NESTED) {
    await writeDeployed({ branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), commit: git(["rev-parse", "HEAD"]), local: true, dirty: git(["status", "--porcelain"]) !== "" });
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const DEPLOYED = "/var/lib/corpus-mcp/deployed.json";

/** What the server runs, as the last deploy recorded it: { branch, pr?, commit, at, local? }, or null before the first record. */
async function readDeployed() {
  const out = await runAsRoot(CORPUS_HOST, `cat ${DEPLOYED} 2>/dev/null || true`);
  const line = out.trim().split("\n").pop();
  return line ? JSON.parse(line) : null;
}

async function writeDeployed(record) {
  const encoded = Buffer.from(JSON.stringify({ ...record, at: new Date().toISOString() })).toString("base64");
  await runAsRoot(CORPUS_HOST, `printf %s ${shellQuote(encoded)} | base64 -d > ${DEPLOYED}.new && chmod 0644 ${DEPLOYED}.new && mv ${DEPLOYED}.new ${DEPLOYED} && echo`);
}

/** A branch's head on origin. */
function branchSource(branch) {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", branch], { cwd: root, stdio: ["ignore", "inherit", "pipe"] });
  } catch {
    throw new Error(`origin has no branch ${branch}. Use --main or --pr <number>.`);
  }
  return { branch, commit: git(["rev-parse", "FETCH_HEAD"]), name: `origin/${branch}` };
}

/** An open pull request's head commit; refuses one that is closed, merged, or from a fork. */
function pullRequestSource(pr) {
  let view;
  try {
    view = JSON.parse(execFileSync("gh", ["pr", "view", String(pr), "--json", "state,headRefName,headRefOid,isCrossRepository,title"], { cwd: root, encoding: "utf8" }));
  } catch (error) {
    throw new Error(`Could not look up PR #${pr} with gh: ${error.stderr?.toString().trim() || error.message}`);
  }
  if (view.state !== "OPEN") throw new Error(`PR #${pr} is ${view.state.toLowerCase()}, not open. Use --main to switch the server back to main.`);
  if (view.isCrossRepository) throw new Error(`PR #${pr} comes from a fork; deploy only branches of this repository.`);
  execFileSync("git", ["fetch", "--quiet", "origin", `pull/${pr}/head`], { cwd: root, stdio: "inherit" });
  const commit = git(["rev-parse", "FETCH_HEAD"]);
  if (commit !== view.headRefOid) throw new Error(`PR #${pr} moved while fetching (${commit.slice(0, 7)} ≠ ${view.headRefOid.slice(0, 7)}); try again.`);
  return { branch: view.headRefName, pr: Number(pr), commit, name: `PR #${pr} (${view.headRefName}: ${view.title})` };
}

/** The latest commit of whatever the server was last deployed from. */
async function currentSource() {
  const deployed = await readDeployed();
  if (!deployed) throw new Error("The server has no record of its branch yet (it predates --current). Use --main or --pr <number> once.");
  if (deployed.pr) return pullRequestSource(deployed.pr);
  if (!deployed.branch || deployed.branch === "HEAD") throw new Error("The server was deployed from a detached checkout. Use --main or --pr <number>.");
  return branchSource(deployed.branch);
}

/** Deploys a commit from origin by running its own deploy script in a temporary worktree, so its build, tests, and deploy steps are its own. */
async function deployCommit(source, rest) {
  console.log(`Deploying ${source.name} at ${source.commit.slice(0, 7)}.`);
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-mcp-deploy-"));
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", tree, source.commit], { cwd: root, stdio: "inherit" });
  try {
    execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: tree, stdio: "inherit" });
    // The environment already holds .env, so the worktree's script needs no copy of it, but a relative
    // vocabulary path in it means this checkout, not the worktree. NESTED: this script records the
    // source below, which the worktree's (a detached checkout) would get wrong.
    const vocabulary = process.env.CORPUS_VOCABULARY_SOURCE ? { CORPUS_VOCABULARY_SOURCE: path.resolve(process.env.CORPUS_VOCABULARY_SOURCE) } : {};
    execFileSync(process.execPath, [path.join(tree, "tools", "deploy.mjs"), ...rest], { cwd: tree, stdio: "inherit", env: { ...process.env, ...vocabulary, CORPUS_DEPLOY_NESTED: "1" } });
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: root, stdio: "inherit" });
  }
  await writeDeployed({ branch: source.branch, ...(source.pr ? { pr: source.pr } : {}), commit: source.commit });
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const prIndex = argv.indexOf("--pr");
  const sources = ["--pr", "--main", "--current"].filter((flag) => argv.includes(flag));
  if (sources.length) {
    const pr = prIndex >= 0 ? argv[prIndex + 1] : null;
    const rest = argv.filter((a, i) => !sources.includes(a) && (prIndex < 0 || i !== prIndex + 1));
    if (sources.length > 1) throw new Error(`Pass one of ${sources.join(", ")}.\n\n${USAGE}`);
    if (prIndex >= 0 && !/^\d+$/.test(pr ?? "")) throw new Error(`--pr takes a pull request number.\n\n${USAGE}`);
    const other = rest.find((a) => a !== "--skip-tests");
    if (other) throw new Error(`${other} does not combine with ${sources[0]}.\n\n${USAGE}`);
    if (!password) throw new Error(`AUTHORING_DEPLOY_PASSWORD is not set.\n\n${USAGE}`);
    const source = pr ? pullRequestSource(pr) : argv.includes("--main") ? branchSource("main") : await currentSource();
    return deployCommit(source, rest);
  }
  const known = new Set(["--provision", "--source-setup", "--source-setup-user-key", "--skip-tests", "--vocabulary", "--zotero"]);
  const unknown = argv.find((a) => !known.has(a.split("=")[0]));
  if (unknown) throw new Error(`Unknown argument ${unknown}.\n\n${USAGE}`);
  if (!password) throw new Error(`AUTHORING_DEPLOY_PASSWORD is not set.\n\n${USAGE}`);
  if (argv.includes("--provision")) return provision();
  if (argv.includes("--source-setup")) return sourceSetup();
  if (argv.includes("--source-setup-user-key")) return sourceSetupUserKey();
  if (argv.includes("--zotero")) return pushZotero();
  const vocabularyArg = argv.find((a) => a.split("=")[0] === "--vocabulary");
  if (vocabularyArg) {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
    return pushVocabulary(vocabularyArg.split("=")[1] || process.env.CORPUS_VOCABULARY_SOURCE);
  }
  return deploy({ skipTests: argv.includes("--skip-tests") });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
