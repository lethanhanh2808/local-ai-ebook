// src/app/api/jobs/route.ts
// GET /api/jobs – list recent jobs
import { NextResponse } from 'next/server';
import { listJobs } from '@/lib/db/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const jobs = await listJobs(100);
    return NextResponse.json(jobs);
  } catch (err) {
    console.error('[api/jobs]', err);
    return NextResponse.json({ error: 'Failed to list jobs' }, { status: 500 });
  }
}
