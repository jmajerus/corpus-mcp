import { Worker } from "node:worker_threads";
import type { PdfTask } from "./pdf-tasks.js";

/** A task that ran past its time limit; the worker running it was stopped. */
export class PdfTimeout extends Error {
  constructor(readonly seconds: number) {
    super(`took longer than ${seconds} s`);
  }
}

interface Pending { id: number; task: PdfTask; resolve: (value: unknown) => void; reject: (error: Error) => void }

/**
 * Runs MuPDF tasks one at a time in a worker thread, so the server's own thread stays free while a file is
 * read. A task past its time limit stops the worker (MuPDF can't be interrupted otherwise) and fails with
 * PdfTimeout; the next task starts a fresh worker. An idle worker is stopped to give its memory back.
 */
export class PdfRunner {
  private worker: Worker | null = null;
  private queue: Pending[] = [];
  private busy: Pending | null = null;
  private timer: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private nextId = 1;

  constructor(readonly timeoutMs: number, private readonly idleMs = 300_000) {}

  run<T>(task: PdfTask): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, task, resolve: resolve as (value: unknown) => void, reject });
      this.next();
    });
  }

  /** Stops the worker and fails whatever is queued (server shutdown, tests). */
  close(): void {
    for (const p of [...(this.busy ? [this.busy] : []), ...this.queue]) p.reject(new Error("The PDF worker was stopped."));
    this.busy = null;
    this.queue = [];
    this.stop();
  }

  private start(): Worker {
    // Built, the worker is dist/pdf-worker.js; under the tests (tsx), src/pdf-worker.ts, loaded through tsx.
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(new URL(source ? "./pdf-worker.ts" : "./pdf-worker.js", import.meta.url), source ? { execArgv: ["--import", "tsx"] } : {});
    worker.unref();
    worker.on("message", (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.busy;
      if (!p || p.id !== message.id) return;
      this.finish();
      if (message.ok) p.resolve(message.result);
      else p.reject(new Error(message.error));
      this.next();
    });
    const lost = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      const p = this.busy;
      this.finish();
      p?.reject(error);
      this.next();
    };
    worker.on("error", lost);
    worker.on("exit", (code) => lost(new Error(`The PDF worker stopped (exit code ${code}).`)));
    return worker;
  }

  private next(): void {
    if (this.busy || !this.queue.length) {
      if (!this.busy && !this.queue.length && this.worker && !this.idle) {
        this.idle = setTimeout(() => this.stop(), this.idleMs);
        this.idle.unref();
      }
      return;
    }
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    const p = this.queue.shift()!;
    this.busy = p;
    this.worker ??= this.start();
    this.timer = setTimeout(() => {
      if (this.busy !== p) return;
      this.finish();
      this.stop();
      p.reject(new PdfTimeout(Math.round(this.timeoutMs / 1000)));
      this.next();
    }, this.timeoutMs);
    this.timer.unref();
    this.worker.postMessage({ id: p.id, task: p.task });
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.busy = null;
  }

  private stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
  }
}

/** How the server runs MuPDF: in workers (the HTTP server), or inline on the caller's thread (CLI, tests). */
let runners: { profile: PdfRunner; render: PdfRunner } | null = null;

/**
 * Switches MuPDF work to worker threads: one for content profiles, which run in the background and may take
 * a while, and one for page renders, which a person waits for. Called by the HTTP server at startup.
 */
export function usePdfWorkers(options: { profileTimeoutMs?: number; renderTimeoutMs?: number } = {}): void {
  runners ??= { profile: new PdfRunner(options.profileTimeoutMs ?? 120_000), render: new PdfRunner(options.renderTimeoutMs ?? 30_000) };
}

export function pdfWorkers(): { profile: PdfRunner; render: PdfRunner } | null {
  return runners;
}

/** Back to inline MuPDF work (tests). */
export function stopPdfWorkers(): void {
  runners?.profile.close();
  runners?.render.close();
  runners = null;
}
