import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../../src/store";

const [mode, ...args] = process.argv.slice(2);

// mkdir fails if another process is already inside, which makes this worker exit non-zero
function critical(marker: string, body: () => void): void {
  mkdirSync(marker);
  try {
    body();
  } finally {
    rmdirSync(marker);
  }
}

if (mode === "contend") {
  // Every worker goes for lock i at the same instant, so they all find it stale together
  const [dir, count, startAt, intervalMs] = args;
  const options = { retryMs: 1, timeoutMs: 20_000, staleMs: 10_000 };
  for (let i = 0; i < Number(count); i++) {
    Bun.sleepSync(Math.max(0, Number(startAt) + i * Number(intervalMs) - Date.now()));
    withLock(join(dir, `lock-${i}`), () => critical(join(dir, `inside-${i}`), () => Bun.sleepSync(1)), options);
  }
} else {
  // Holds the outer lock while it waits for the inner one
  const [outer, inner, marker, staleMs] = args;
  const options = { retryMs: 10, timeoutMs: 10_000, staleMs: Number(staleMs) };
  withLock(outer, () => critical(marker, () => withLock(inner, () => {}, options)), options);
}
