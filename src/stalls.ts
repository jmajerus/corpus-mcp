import { performance } from "node:perf_hooks";

/**
 * Evidence for the next time the server stops answering (a /health that timed out for a minute, with no
 * restart, after several large read_book calls). Everything here runs on one thread, and SQLite calls are
 * synchronous, so a slow query or a stalled disk holds every request, /health included. Each tool call is
 * timed: a slow one is logged with its arguments. A timer notices when the event loop was held, and logs
 * how long and what was running or had just finished, so the journal names the cause.
 */

const SLOW_CALL_MS = 5_000;
const STALL_MS = 5_000;
const TICK_MS = 1_000;

interface Call { name: string; args: string; started: number; ended?: number }

const running = new Set<Call>();
const finished: Call[] = [];

function describeArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args) ?? "";
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "?";
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function done(call: Call): void {
  call.ended = performance.now();
  running.delete(call);
  finished.push(call);
  if (finished.length > 20) finished.shift();
  const took = call.ended - call.started;
  if (took >= SLOW_CALL_MS) console.error(`slow tool call: ${call.name} took ${seconds(took)} ${call.args}`);
}

/** Runs a tool handler, timing it; works for handlers that return a value or a promise. */
export function timed<T>(name: string, args: unknown, body: () => T): T {
  const call: Call = { name, args: describeArgs(args), started: performance.now() };
  running.add(call);
  let result: T;
  try {
    result = body();
  } catch (error) {
    done(call);
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => done(call)) as T;
  done(call);
  return result;
}

/** Starts the stall timer; returns its stop function. */
export function watchStalls(log: (line: string) => void = (line) => console.error(line)): () => void {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const held = now - last - TICK_MS;
    if (held >= STALL_MS) {
      const from = last;
      const during = [...running, ...finished.filter((c) => (c.ended ?? now) >= from)]
        .map((c) => `${c.name} ${c.ended === undefined ? `running ${seconds(now - c.started)}` : `took ${seconds(c.ended - c.started)}`} ${c.args}`);
      log(`event loop held for ${seconds(held)}; tool calls running or finished in that time: ${during.length ? during.join("; ") : "none (not a tool call: a timer's work, a web page, or a stalled disk)"}`);
    }
    last = now;
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
