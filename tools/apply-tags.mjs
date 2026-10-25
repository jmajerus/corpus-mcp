#!/usr/bin/env node
// Applies approved tag proposals to Calibre: fetches the plan from corpus-mcp (/api/tag-plan) and runs
// tools/calibre-tags.sh on the Calibre-Web host as the library owner (the shared authoring login).
//
//   npm run tags:apply                             list what would change
//   npm run tags:apply -- --apply                  write the tags (backs up metadata.db first)
//   npm run tags:apply -- --plan cleanup.json [--apply]   a local plan instead of the approved tags
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORPUS_URL = process.env.CORPUS_URL ?? "http://corpus-mcp.localdomain:8000";
const SOURCE_HOST = process.env.CORPUS_SOURCE_ADMIN_HOST ?? "authoring@calibre-web.localdomain";
const LIBRARY = process.env.CORPUS_TAG_LIBRARY ?? "main";

const apply = process.argv.includes("--apply");
// --plan <file> applies a local plan (e.g. a cleanup listing tags to remove) instead of the approved tags.
const planIndex = process.argv.indexOf("--plan");
let plan;
if (planIndex > 0) {
  plan = JSON.parse(fs.readFileSync(process.argv[planIndex + 1], "utf8"));
} else {
  const response = await fetch(`${CORPUS_URL}/api/tag-plan?library=${encodeURIComponent(LIBRARY)}`);
  if (!response.ok) throw new Error(`tag plan request failed: HTTP ${response.status}`);
  plan = await response.json();
}
if (!plan.books.length) {
  console.log("No tag changes are waiting to be applied.");
  process.exit(0);
}

const encoded = Buffer.from(JSON.stringify(plan)).toString("base64");
const ssh = spawn("ssh", ["-o", "StrictHostKeyChecking=yes", SOURCE_HOST,
  `TAG_PLAN=${encoded} bash -s -- ${apply ? "--apply " : ""}/mnt/Calibre/${LIBRARY}`], {
  env: { ...process.env, SSH_ASKPASS: path.join(root, "tools", "askpass.mjs"), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || "corpus-tags" },
  stdio: ["pipe", "inherit", "inherit"],
});
ssh.stdin.end(fs.readFileSync(path.join(root, "tools", "calibre-tags.sh")));
ssh.on("exit", (code) => { process.exitCode = code ?? 1; });
