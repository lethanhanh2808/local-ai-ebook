// src/worker/character-bible.ts
// BullMQ consumer for the Character Bible queue.
//
// One job per (bookId, chapterIndex) — see CHARACTER_BIBLE_QUEUE_NAME in
// src/lib/queue/index.ts. The job ID is `bible:${bookId}:${chapterIndex}`
// so multiple enqueues for the same chapter collapse into a single worker
// invocation.
//
// What this worker does:
//   1. Loads the current Character Bible for the book.
//   2. Calls refreshBible() which fetches the chapter text, asks the LLM
//      for a delta, and applies-or-queues the patches based on `autoMerge`.
//   3. Logs a one-line summary to stderr — the docker-compose app service
//      routes worker stderr through stdout where it shows up in
//      `docker compose logs app`.
//
// Whole-book scans are intentionally not supported — see
// RefreshBibleOptions.chapterIndex in src/lib/ai/character-bible.ts. The
// enqueue route rejects null/missing chapterIndex with HTTP 400 so we never
// even queue such a job, but the worker also defends in depth.
//
// Standalone usage: `tsx src/worker/character-bible.ts`
// In the unified worker entry, register via startCharacterBibleWorker().
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { redisConnection, type CharacterBibleJobData } from '../lib/queue';
import { refreshBible } from '../lib/ai/character-bible';

export async function startCharacterBibleWorker(): Promise<{ worker: Worker }> {
  const conn = new IORedis(redisConnection);

  const worker = new Worker<CharacterBibleJobData>(
    'ebook-character-bible',
    async (job: Job<CharacterBibleJobData>) => {
      const { bookId, chapterIndex, chapterFile, autoMerge, reason } = job.data;
      if (!Number.isFinite(chapterIndex) || chapterIndex < 0) {
        throw new Error(`character-bible-worker: invalid chapterIndex=${chapterIndex} on job ${job.id} — whole-book scans are not supported`);
      }
      const t0 = Date.now();
      const result = await refreshBible(bookId, {
        chapterIndex,
        chapterFile: chapterFile ?? null,
        autoMerge,
      });
      const ms = Date.now() - t0;
      console.log(
        `[character-bible-worker] book=${bookId.slice(0, 8)} ` +
        `ch=${chapterIndex} ` +
        `reason=${reason} auto=${autoMerge ? 'merge' : 'preview'} ` +
        `applied=${result.autoApplied} queued=${result.queued} ` +
        `conflicts=${result.conflicts} ${ms}ms`,
      );
      return result;
    },
    {
      connection: conn,
      concurrency: 1,
      // Same bounds as the audiobook worker — local LLM calls are slow
      // and we'd rather throttle than run two on top of each other.
      limiter: { max: 2, duration: 60_000 },
    },
  );

  worker.on('completed', (job) => {
    console.log(`[character-bible-worker] ✓ ${job.id}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[character-bible-worker] ✗ ${job?.id}: ${err.message}`);
  });

  process.on('SIGTERM', async () => { await worker.close(); });
  process.on('SIGINT',  async () => { await worker.close(); });

  console.log('[character-bible-worker] Listening on queue ebook-character-bible (concurrency=1)');
  return { worker };
}

if (require.main === module) {
  startCharacterBibleWorker().catch((e) => {
    console.error('[character-bible-worker] failed to start:', e);
    process.exit(1);
  });
}
