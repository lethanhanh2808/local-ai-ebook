// scripts/requeue-d833f45f.ts
//
// One-shot recovery for the d833f45f-96d3-443a-94ec-bb55bff42db0 job that
// got stuck: BullMQ processed it in 3ms with returnvalue=null (handler died
// before updating the DB), so the DB row still says queued/0/upload while
// BullMQ considers it completed. The host worker has since been restarted
// (after a 6.5h BullMQ connection death); this script wipes the stale
// BullMQ state for the job and re-adds it from the original job data.
//
// Run: npx tsx scripts/requeue-d833f45f.ts
import { getQueue } from '../src/lib/queue/index';
import { redisConnection } from '../src/lib/queue/index';

const JOB_ID = 'd833f45f-96d3-443a-94ec-bb55bff42db0';
const QUEUE_NAME = 'ebook-conversion';

async function main() {
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(redisConnection);

  // ── 1. Capture the original job data from the existing job hash ──────────
  const dataRaw = await redis.hget(`bull:${QUEUE_NAME}:${JOB_ID}`, 'data');
  if (!dataRaw) {
    console.error(`[requeue] No job hash found for ${JOB_ID} — already cleared?`);
    process.exit(1);
  }
  const originalData = JSON.parse(dataRaw);
  console.log(`[requeue] Original job data:`);
  console.log(JSON.stringify(originalData, null, 2));

  // ── 2. Remove all stale BullMQ bookkeeping for this jobId ──────────────────
  const removed: string[] = [];
  removed.push(`hash  : ${await redis.del(`bull:${QUEUE_NAME}:${JOB_ID}`)}`);
  removed.push(
    `logs   : ${await redis.del(`bull:${QUEUE_NAME}:${JOB_ID}:logs`)}`,
  );
  removed.push(
    `completed zrem : ${await redis.zrem(
      `bull:${QUEUE_NAME}:completed`,
      JOB_ID,
    )}`,
  );
  removed.push(
    `failed    zrem : ${await redis.zrem(`bull:${QUEUE_NAME}:failed`, JOB_ID)}`,
  );
  removed.push(
    `delayed   zrem : ${await redis.zrem(`bull:${QUEUE_NAME}:delayed`, JOB_ID)}`,
  );
  removed.push(
    `active    zrem : ${await redis.zrem(`bull:${QUEUE_NAME}:active`, JOB_ID)}`,
  );
  removed.push(
    `wait      zrem : ${await redis.zrem(`bull:${QUEUE_NAME}:wait`, JOB_ID)}`,
  );
  console.log('[requeue] Cleared stale state:');
  for (const r of removed) console.log('  ', r);

  // ── 3. Add the job back to the wait list with the same jobId ──────────────
  const queue = getQueue();
  const job = await queue.add('convert', originalData, {
    jobId: JOB_ID,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
  console.log(`[requeue] Re-queued job ${job.id} (state=${await job.getState()})`);

  await redis.quit();
  await queue.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[requeue] FAILED:', err);
  process.exit(1);
});