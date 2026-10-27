import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Each example is a draft the cited-article skill produced, with its quotes' saved text.
const ROOT = path.join(import.meta.dirname, "..");
const CHECK = path.join(ROOT, "skills/cited-article/check-draft.mjs");
const EXAMPLES = path.join(ROOT, "examples/cited-article");

describe("cited-article examples", () => {
  for (const slug of fs.readdirSync(EXAMPLES).filter((d) => fs.statSync(path.join(EXAMPLES, d)).isDirectory())) {
    it(`${slug} passes check-draft`, () => {
      const dir = path.join(EXAMPLES, slug);
      const run = spawnSync(process.execPath, [CHECK, path.join(dir, `${slug}.md`), "--quotes", path.join(dir, "quotes.json")], { encoding: "utf8" });
      const report = JSON.parse(run.stdout);
      expect(report.quotes.length).toBeGreaterThan(0);
      expect(report, JSON.stringify(report, null, 2)).toMatchObject({ ok: true });
    });
  }
});
