// Copy the pre-cutover index/data pair and rotate the anchor feed generation. No service changes.
import { parseArgs } from "node:util";
import { prepareEpubRollback } from "../dist/reextraction.js";

try {
  const { values } = parseArgs({ options: { index: { type: "string" }, data: { type: "string" }, output: { type: "string" } } });
  if (!values.index || !values.data || !values.output) throw new Error("Usage: node tools/prepare-epub-rollback.mjs --index snapshot/corpus.db --data snapshot/data.db --output /tmp/new-rollback-pair");
  console.log(JSON.stringify(await prepareEpubRollback({ index: values.index, data: values.data, output: values.output }), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
