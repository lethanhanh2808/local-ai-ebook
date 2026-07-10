// src/app/api/jobs/[id]/download/route.ts
// GET /api/jobs/:id/download – stream the completed EPUB
import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/db/jobs';
import fs from 'fs';
import path from 'path';
import { assertWithinRoots, pathRoots, SafePathError } from '@/lib/storage/safe-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const job = await getJob(params.id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.status !== 'completed' || !job.outputPath) {
    return NextResponse.json({ error: 'File not ready' }, { status: 409 });
  }
  let outputPath: string;
  try {
    outputPath = assertWithinRoots(job.outputPath, [pathRoots().output]);
  } catch (error) {
    if (error instanceof SafePathError) {
      return NextResponse.json({ error: 'Output file path is invalid' }, { status: 404 });
    }
    throw error;
  }
  if (!fs.existsSync(outputPath)) {
    return NextResponse.json({ error: 'Output file missing' }, { status: 404 });
  }

  const stat = fs.statSync(outputPath);
  const stream = fs.createReadStream(outputPath);
  const safeName = path.basename(outputPath);

  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'private, no-store',
    },
  });
}
