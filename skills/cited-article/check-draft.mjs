#!/usr/bin/env node
// Checks a cited-article draft: marked quotes against their saved text, citekeys against the
// bibliography, and a Pandoc build. Prints JSON; exits 1 when something is wrong.
// Usage: node check-draft.mjs <draft.md> [--quotes <file.json>]   (file: { "<id>": "<prose>" })
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const draft = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--quotes");
const quotesFile = args.includes("--quotes") ? args[args.indexOf("--quotes") + 1] : undefined;
if (!draft) {
  console.error("Usage: node check-draft.mjs <draft.md> [--quotes <file.json>]");
  process.exit(2);
}
const dir = path.dirname(path.resolve(draft));
const source = fs.readFileSync(draft, "utf8");

// Front matter: only the fields this check needs, as one value or a [list].
const fm = /^---\n([\s\S]*?)\n---\n/.exec(source);
const field = (name) => {
  const m = fm && new RegExp(`^${name}:\\s*(.*)$`, "m").exec(fm[1]);
  if (!m) return [];
  return m[1].replace(/^\[|\]$/g, "").split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
};
const body = fm ? source.slice(fm[0].length) : source;
const unpinned = field("corpus-unpinned");

// Text the reader never sees: comments (kept apart, they hold the markers) and code.
const visible = body.replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

// Citekeys in bracketed citations, as Pandoc reads them.
const citekeys = new Set();
for (const group of visible.match(/\[[^\[\]]*@[^\[\]]*\]/g) ?? [])
  for (const m of group.matchAll(/(?:^|[\s\[;-])@([\p{L}\p{N}_][\p{L}\p{N}_:.#$%&+?<>~/-]*)/gu)) citekeys.add(m[1].replace(/[.:]+$/, ""));

const bibKeys = new Set();
const bibliography = [];
for (const file of field("bibliography")) {
  const full = path.resolve(dir, file);
  if (!fs.existsSync(full)) { bibliography.push({ file, missing: true }); continue; }
  bibliography.push({ file });
  for (const m of fs.readFileSync(full, "utf8").matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) bibKeys.add(m[1]);
}

// Block quotes, each with the marker on the line before it (if any).
const lines = body.split("\n");
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  if (!/^\s{0,3}>/.test(lines[i]) || (i > 0 && /^\s{0,3}>/.test(lines[i - 1]))) continue;
  let end = i;
  while (end + 1 < lines.length && /^\s{0,3}>/.test(lines[end + 1])) end++;
  const marker = i > 0 ? /<!--\s*corpus:quote\s+(\d+)\s*-->/.exec(lines[i - 1]) : null;
  blocks.push({ line: i + 1, id: marker ? Number(marker[1]) : null, text: lines.slice(i, end + 1).map((l) => l.replace(/^\s{0,3}>\s?/, "")).join("\n") });
  i = end;
}

// Quoted words only: no citations, footnote references, or line wrapping.
const words = (t) => t.replace(/\[\^[^\]]+\]/g, "").replace(/\[[^\[\]]*@[^\[\]]*\]/g, "").replace(/\s+/g, " ").trim();
const saved = quotesFile ? JSON.parse(fs.readFileSync(quotesFile, "utf8")) : null;
const quotes = blocks.filter((b) => b.id !== null).map((b) => {
  const text = words(b.text);
  const out = { id: b.id, line: b.line, text };
  if (saved) {
    const want = saved[b.id] === undefined ? undefined : words(saved[b.id]);
    if (want === undefined) out.problem = "no saved text given for this quote";
    else if (want !== text) {
      let at = 0;
      while (at < want.length && want[at] === text[at]) at++;
      out.problem = "differs from the saved quote";
      out.saved_at_difference = want.slice(Math.max(0, at - 30), at + 30);
      out.draft_at_difference = text.slice(Math.max(0, at - 30), at + 30);
    }
  }
  return out;
});

let pandoc;
const run = spawnSync("pandoc", [path.basename(draft), "--citeproc", "-t", "plain", "-o", process.platform === "win32" ? "NUL" : "/dev/null"], { cwd: dir, encoding: "utf8" });
if (run.error) pandoc = { ran: false, reason: run.error.message };
else pandoc = { ran: true, exit: run.status, warnings: run.stderr.split("\n").map((l) => l.trim()).filter(Boolean) };

const report = {
  draft,
  quotes,
  unmarked_block_quotes: blocks.filter((b) => b.id === null).map((b) => ({ line: b.line, text: words(b.text).slice(0, 80) })),
  citekeys: [...citekeys],
  missing_from_bibliography: [...citekeys].filter((k) => !bibKeys.has(k)),
  unpinned,
  bibliography,
  pandoc,
};
report.ok = quotes.every((q) => !q.problem) && !report.unmarked_block_quotes.length && !report.missing_from_bibliography.length &&
  !unpinned.length && bibliography.every((b) => !b.missing) && (!pandoc.ran || (pandoc.exit === 0 && !pandoc.warnings.length));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
