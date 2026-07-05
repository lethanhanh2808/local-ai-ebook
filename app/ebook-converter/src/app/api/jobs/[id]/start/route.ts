// POST /api/jobs/[id]/start
// Moves a pending job into the BullMQ queue. Idempotent — re-calling on
// an already-queued/processing job is a no-op (returns the current state).
import { NextRequest, NextResponse } from 'next/server';
import { getJob, updateJob } from '@/lib/db/jobs';
import { getQueue } from '@/lib/queue';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const job = await getJob(params.id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  // Already running — no-op
  if (job.status === 'queued' || job.status === 'processing') {
    return NextResponse.json({ ok: true, status: job.status, alreadyRunning: true });
  }
  // Cannot start terminal states
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return NextResponse.json({
      error: `Job is in terminal state "${job.status}". Delete and re-upload to retry.`,
    }, { status: 400 });
  }

  // Verify input file still exists
  if (!fs.existsSync(job.inputPath)) {
    return NextResponse.json({
      error: `Input file no longer exists at ${job.inputPath}. Re-upload required.`,
    }, { status: 410 });
  }

  // Move to queued + push to BullMQ
  await updateJob(job.id, { status: 'queued', progress: 0, stage: 'upload' });
  const queue = getQueue();
  await queue.add(
    'convert',
    {
      jobId: job.id,
      inputPath: job.inputPath,
      originalExt: job.originalExt,
      filename: job.filename,
      // (aiEnhance / aiWatermarkClean / deepFormat / aiPrompt are NOT carried over —
      //  they're only known at upload time. To preserve them across manual-start,
      //  we'd need to persist them on the Job row. For now, defaults apply.)
    },
    { jobId: job.id },
  );

  return NextResponse.json({ ok: true, status: 'queued' });
}