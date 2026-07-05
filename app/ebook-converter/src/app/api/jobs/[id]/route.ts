// src/app/api/jobs/[id]/route.ts
// GET   /api/jobs/:id  – job detail
// DELETE /api/jobs/:id  – cancel / delete job (removes from BullMQ + deletes files)
// PATCH  /api/jobs/:id  – update status (e.g. cancelled)
import { NextRequest, NextResponse } from 'next/server';
import { getJob, deleteJob, updateJob } from '@/lib/db/jobs';
import { removeFile } from '@/lib/storage';
import { getQueue } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const job = await getJob(params.id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json(job);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const job = await getJob(params.id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  // Remove from BullMQ first so the worker doesn't pick it up after we delete the DB row
  try {
    const queue = getQueue();
    // BullMQ job IDs are passed in `opts.jobId` — get jobs by that custom key
    const bullJobs = await queue.getJobs(['waiting', 'active', 'delayed', 'paused']);
    for (const bj of bullJobs) {
      if ((bj.data as { jobId?: string })?.jobId === params.id) {
        await bj.remove();
      }
    }
  } catch { /* best-effort */ }

  // Remove files
  if (job.inputPath) removeFile(job.inputPath);
  if (job.outputPath) removeFile(job.outputPath);

  await deleteJob(params.id);
  return NextResponse.json({ deleted: true });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = (await req.json()) as { status?: string };
  if (body.status === 'cancelled') {
    // Also remove from BullMQ so the worker won't pick it up later
    try {
      const queue = getQueue();
      const bullJobs = await queue.getJobs(['waiting', 'active', 'delayed', 'paused']);
      for (const bj of bullJobs) {
        if ((bj.data as { jobId?: string })?.jobId === params.id) await bj.remove();
      }
    } catch { /* best-effort */ }
    await updateJob(params.id, { status: 'cancelled' });
    return NextResponse.json({ cancelled: true });
  }
  return NextResponse.json({ error: 'Unsupported operation' }, { status: 400 });
}
