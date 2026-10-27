#!/usr/bin/env node
// Prints what the corpus server runs, as one JSON line for the vscode-status-probe status-bar
// extension (see .vscode/settings.json): the branch or pull request from /health's deploy record,
// and how far it is behind that branch on origin. It only reads: git ls-remote and gh api, never
// a fetch, so it cannot disturb the FETCH_HEAD a running deploy reads.
//
// Status items show state, not actions: a noun glyph ($(book)), no verbs, and a background only
// through `level`. The Deploy Corpus button is the action: a verb label and its own glyph.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.CORPUS_STATUS_URL ?? "http://corpus-mcp.localdomain:8000";
const ICON = "$(book)";
const MAX_BRANCH_LABEL = 16;

function print(probe) {
  process.stdout.write(`${JSON.stringify({ open: `${BASE}/admin`, ...probe })}\n`);
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

function tooltip(rows, note = "") {
  const table = ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${escapeMarkdown(k)} | ${escapeMarkdown(v)} |`)].join("\n");
  return `**Corpus server**\n\n${table}${note ? `\n\n${note}` : ""}`;
}

function run(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The head of a ref on origin, or null when it is gone or origin cannot be reached. */
function remoteHead(ref) {
  return run("git", ["ls-remote", "origin", ref])?.split(/\s/)[0] || null;
}

/** Commits on `head` that `commit` lacks, from GitHub, so they need not be fetched; null when unknown. */
function behindBy(commit, head) {
  if (commit === head) return 0;
  const count = Number(run("gh", ["api", `repos/{owner}/{repo}/compare/${commit}...${head}`, "--jq", ".ahead_by"]));
  return Number.isInteger(count) ? count : null;
}

function label(deployed) {
  if (deployed.pr) return `#${deployed.pr}`;
  const name = String(deployed.branch).slice(String(deployed.branch).lastIndexOf("/") + 1);
  return name.length > MAX_BRANCH_LABEL ? `${name.slice(0, MAX_BRANCH_LABEL - 1)}…` : name;
}

let health;
try {
  const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) });
  health = await response.json();
  if (!health.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  print({ text: `${ICON} ?`, tooltip: tooltip([["Server", BASE], ["Problem", `unreachable or unhealthy (${error.message})`]]), level: "error" });
  process.exit(0);
}

const deployed = health.deployed;
const rows = [["Version", health.version], ["Books", String(health.books)]];
if (!deployed?.commit) {
  print({ text: `${ICON} ?`, level: "warn",
    tooltip: tooltip(rows, "The server has no deploy record yet: it was installed before deploys recorded one. Deploy it once with the Deploy Corpus button.") });
  process.exit(0);
}

const marks = [];
let note = "";
let ref = deployed.pr ? `refs/pull/${deployed.pr}/head` : `refs/heads/${deployed.branch}`;
if (deployed.pr) {
  const state = run("gh", ["pr", "view", String(deployed.pr), "--json", "state", "--jq", ".state"]);
  if (state && state !== "OPEN") {
    marks.push(state === "MERGED" ? "✓merged" : "✗closed");
    note = "The pull request is no longer open. Switch the server to main with the Deploy Corpus button.";
    ref = null;
  }
}
const head = ref ? remoteHead(ref) : null;
const behind = head ? behindBy(deployed.commit, head) : null;
if (behind) marks.push(`↓${behind}`);
if (deployed.local) marks.push(deployed.dirty ? "local*" : "local");

rows.unshift(
  ["Running", `${deployed.branch}${deployed.pr ? ` (PR #${deployed.pr})` : ""}`],
  ["Commit", `${deployed.commit.slice(0, 7)}${deployed.local ? ` from a local checkout${deployed.dirty ? ", with uncommitted changes" : ""}` : ""}`],
  ...(ref ? [[`Behind origin`, behind == null ? "unknown" : String(behind)]] : []),
  ["Deployed", new Date(deployed.at).toLocaleString()],
);
rows.push(["Checked", new Date().toLocaleTimeString()]);
if (behind && !note) note = "Redeploy current branch with the Deploy Corpus button to catch up.";

print({
  text: [`${ICON} ${label(deployed)}`, ...marks].join(" "),
  tooltip: tooltip(rows, note),
  // Lag, a closed pull request, or code that is on no branch.
  level: behind || note || deployed.dirty || (ref && behind == null) ? "warn" : "ok",
});
