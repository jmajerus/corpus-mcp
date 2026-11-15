import { expect, it } from "vitest";
import { run } from "../src/jobs.js";

it("stays up when a command exits before its stdin is written", async () => {
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);
  process.on("uncaughtException", onError);
  try {
    const code = await run(process.execPath, ["-e", "process.exit(0)"], () => {}, "x".repeat(1024 * 1024));
    expect(code).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    process.off("uncaughtException", onError);
  }
});

it("reports a command that cannot be started", async () => {
  await expect(run("no-such-corpus-command-xyz", [], () => {})).rejects.toThrow(/ENOENT/);
});
