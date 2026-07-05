// src/app/api/jobs/[id]/download/route.ts
// GET /api/jobs/:id/download – stream the completed EPUB
import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/db/jobs';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const job = await getJob(params.id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.status !== 'completed' || !job.outputPath) {
    return NextResponse.json({ error: 'File not ready' }, { status: 409 });
  }
  if (!fs.existsSync(job.outputPath)) {
    return NextResponse.json({ error: 'Output file missing' }, { status: 404 });
  }

  const buf = fs.readFileSync(job.outputPath);
  const safeName = path.basename(job.outputPath);

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(buf.length),
    },
  });
}
