// src/app/api/worker/stop/route.ts
//
// POST /api/worker/stop
//
// Stops the worker that was started via /api/worker/start (or scripts/start-worker.sh).
// Sends SIGTERM, waits 10s for graceful shutdown, then SIGKILL.
//
// Same localhost check as /start — only callable from the same machine.
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { workerControlAuthorized } from '@/lib/utils/worker-control';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!workerControlAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'Worker control is only allowed from localhost.' },
      { status: 403 },
    );
  }

  const candidates = [
    path.resolve(process.cwd(), 'scripts', 'start-worker.sh'),
    path.resolve(process.cwd(), '..', 'scripts', 'start-worker.sh'),
    path.resolve(process.cwd(), 'app', 'ebook-converter', 'scripts', 'start-worker.sh'),
  ];
  const script = candidates.find((p) => fs.existsSync(p));
  if (!script) {
    return NextResponse.json(
      { ok: false, error: 'start-worker.sh not found.' },
      { status: 500 },
    );
  }

  const { spawn } = await import('child_process');
  const child = spawn('/bin/bash', [script, '--stop'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });
  child.stderr?.on('data', (d) => { stderr += d.toString(); });
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    setTimeout(() => { try { child.kill(); } catch {} ; resolve(); }, 8000);
  });

  return NextResponse.json({ ok: true, message: 'Worker stopped.', stdout, stderr });
}
