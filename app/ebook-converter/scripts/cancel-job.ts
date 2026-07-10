// scripts/cancel-job.ts
//
// Cancel a stuck or unwanted BullMQ conversion job. Three things must happen:
//   1. Mark the DB row as 'failed' so the UI stops showing it as running.
//   2. Move the BullMQ job to 'failed' so the worker stops polling it.
//   3. Log a clear reason so audit-log reviewers can see why it was killed.
//
// Usage: npx tsx scripts/cancel-job.ts <jobId> ["reason"]
import { prisma } from '../src/lib/db/client';
import { getQueue } from '../src/lib/queue/index';

const jobId = process.argv[2];
if (!jobId) {
  console.error('Usage: npx tsx scripts/cancel-job.ts <jobId> [reason]');
  process.exit(1);
}
const reason = process.argv[3] ?? 'Cancelled by user';

async function main() {
  console.log(`[cancel] jobId=${jobId}  reason="${reason}"`);

  // 1. DB row — set to failed so the UI unsticks from the spinner
  const dbJob = await prisma.job.findUnique({ where: { id: jobId } });
  if (!dbJob) {
    console.error(`[cancel] No DB job with id ${jobId}`);
    process.exit(2);
  }
  console.log(`[cancel] DB before: status=${dbJob.status}  progress=${dbJob.progress}`);

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'failed',
      errorMsg: reason,
      progress: 100,
    },
  });
  console.log(`[cancel] DB after : status=failed  error="${reason}"`);

  // 2. BullMQ — moveToFailed tells the worker the job is over (no retry).
  const queue = getQueue();
  const bullJob = await queue.getJob(jobId);
  if (!bullJob) {
    console.warn(`[cancel] No BullMQ job with id ${jobId} (already cleared?)`);
  } else {
    await bullJob.moveToFailed(new Error(reason), 'cancel-script');
    console.log(`[cancel] BullMQ: moved to failed`);
  }

  // 3. Optional: tail log line so the worker's NDJSON reflects the cancel
  console.log(`[cancel] Done. UI will show this job as failed within a refresh.`);
  console.log(`[cancel] The worker's in-flight LLM call for this job will complete`);
  console.log(`[cancel] naturally (~85s for Ornith-9B), then exit the for-loop.`);
  console.log(`[cancel] To skip the wait, run: docker compose restart worker`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[cancel] Failed:', err);
    process.exit(1);
  });