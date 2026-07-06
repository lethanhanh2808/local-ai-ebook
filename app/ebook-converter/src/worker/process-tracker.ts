// src/worker/process-tracker.ts
//
// Tracks in-flight child processes (Python generators) so we can
// hard-kill them on:
//   • BullMQ worker SIGTERM / SIGINT / 'failed' events
//   • Job cancellation triggered by the user (book.audiobookStatus = 'none')
//   • Worker shutdown (closest hook runs after in-flight children finish,
//     but we still want a kill switch for orphaned processes)
//
// Without this tracker (Production Hardening 2026-07-06 — issue C4),
// SIGTERM'ing the worker during a 30-second `audiobook_generator.py` call
// leaves the Python process alive, eating CPU and possibly still
// mutating on-disk state for a job that's already been marked failed.
//
// Implementation notes:
//   • Keys are user-supplied strings (jobId, bookId, chapterFile). We
//     allocate one Map entry per in-flight subprocess; entries are
//     deleted in `release()` (called from the process 'close' / 'error'
//     event handlers) so the tracker is self-cleaning.
//   • `killAll()` is idempotent — processes that have already exited
//     simply get `kill` called against a stale PID, which `ESRCH`s.
//   • SIGTERM (signal 15) lets the child flush logs / close files
//     cleanly; we follow up with SIGKILL (signal 9) after 2 seconds
//     if the child is still alive. This matches the user's Stop-button
//     semantics and avoids leaving zombie Python interpreters.

import { ChildProcess } from 'child_process';

const inflight = new Map<string, ChildProcess>();

const KILL_GRACE_MS = 2_000;

/** Register a child process under `key`. Returns a `release()`
 *  function that the caller MUST invoke from the child's 'close' or
 *  'error' handler so the tracker doesn't grow unbounded. */
export function track(key: string, child: ChildProcess): () => void {
  inflight.set(key, child);
  return () => {
    const cur = inflight.get(key);
    if (cur === child) {
      inflight.delete(key);
    }
  };
}

/** Hard-kill a single tracked process by key (if still inflight). */
export function kill(key: string, reason: string): boolean {
  const child = inflight.get(key);
  if (!child) return false;
  console.warn(`[process-tracker] killing ${key} (pid=${child.pid ?? '?'}) — ${reason}`);
  try {
    child.kill('SIGTERM');
  } catch { /* already dead */ }
  // Hard backstop in case the child ignores SIGTERM (e.g. blocked
  // in a synchronous write).
  setTimeout(() => {
    const cur = inflight.get(key);
    if (cur && cur === child && cur.exitCode === null && !cur.signalCode) {
      try { cur.kill('SIGKILL'); } catch { /* gone */ }
    }
  }, KILL_GRACE_MS).unref();
  inflight.delete(key);
  return true;
}

/** SIGTERM every tracked process. Used by worker SIGTERM handlers. */
export function killAll(reason: string): number {
  let count = 0;
  for (const [key, child] of inflight.entries()) {
    count++;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, KILL_GRACE_MS).unref();
  }
  console.warn(`[process-tracker] killAll(${reason}) — sent SIGTERM to ${count} process(es)`);
  inflight.clear();
  return count;
}

/** Number of currently-tracked processes. Mainly for diagnostics + tests. */
export function inflightCount(): number {
  return inflight.size;
}
