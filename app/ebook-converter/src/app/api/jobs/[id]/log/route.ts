// src/app/api/jobs/[id]/log/route.ts
//
// GET  /api/jobs/[id]/log?from=N   – returns log lines from offset N
//                                  (for the "Console" debug panel in JobCard)
//
// The worker writes per-job log files to data/job-logs/<jobId>.jsonl
// (newline-delimited JSON). This endpoint tails the file and returns the
// parsed log entries.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  stage: string;
  message: string;
  meta?: Record<string, unknown>;
}

const LOG_DIR = path.resolve(process.cwd(), 'data/job-logs');

function parseLog(content: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip non-JSON lines (shouldn't happen but be safe)
    }
  }
  return out;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // Look up the log file path from the DB (set by the worker)
  const job = await prisma.job.findUnique({
    where: { id: params.id },
    select: { logPath: true, status: true },
  });
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const fromParam = req.nextUrl.searchParams.get('from');
  const fromLine = fromParam ? Math.max(0, parseInt(fromParam, 10) || 0) : 0;

  // The worker writes to logPath; fall back to LOG_DIR/<jobId>.jsonl
  const logPath = job.logPath ?? path.join(LOG_DIR, `${params.id}.jsonl`);

  if (!fs.existsSync(logPath)) {
    return NextResponse.json({
      ok: true,
      jobId: params.id,
      status: job.status,
      logPath,
      from: fromLine,
      total: 0,
      entries: [],
    });
  }

  // Read the file. We could mmap, but for simplicity just read the whole file.
  // For large files (>10MB) we could chunk, but logs are small (<1MB typically).
  const content = fs.readFileSync(logPath, 'utf8');
  const allLines = content.split('\n');
  const all = parseLog(content);
  const slice = all.slice(fromLine);

  return NextResponse.json({
    ok: true,
    jobId: params.id,
    status: job.status,
    logPath,
    from: fromLine,
    total: all.length,
    totalLines: allLines.filter((l) => l.trim()).length,
    entries: slice,
  });
}