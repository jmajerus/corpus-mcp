#!/usr/bin/env node
// Prints the public Worker's build id for its ETag: a hash of everything a deploy ships that can change
// what a page renders or how it is served. The ETag must not outlive the code — after a deploy that
// changes only markup or styles, a revalidating client holding the snapshot's hash alone would keep its
// stale page until the catalogue itself next changed. Hashing all of src/ and worker/ over-invalidates
// (a server-only change also forces one re-render per client), which is harmless next to a stale page.
// worker:deploy passes the value to wrangler as --define RENDER_BUILD; tests and wrangler dev see none.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash = createHash("sha256");
const walk = (dir, prefix = "") => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name > b.name ? 1 : -1))) {
    if (entry.isDirectory()) {
      if (entry.name !== ".wrangler") walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    } else hash.update(`${prefix}${entry.name}`).update(readFileSync(path.join(dir, entry.name)));
  }
};
for (const dir of ["src", "worker"]) walk(path.join(root, dir));
console.log(JSON.stringify(hash.digest("hex").slice(0, 12)));
