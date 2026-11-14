import { parentPort } from "node:worker_threads";
import { type PdfTask, runPdfTask } from "./pdf-tasks.js";

/** The worker thread src/pdf-runner.ts starts: one task at a time, answered by id. */
parentPort!.on("message", ({ id, task }: { id: number; task: PdfTask }) => {
  try {
    parentPort!.postMessage({ id, ok: true, result: runPdfTask(task) });
  } catch (error) {
    parentPort!.postMessage({ id, ok: false, error: (error as Error).message });
  }
});
