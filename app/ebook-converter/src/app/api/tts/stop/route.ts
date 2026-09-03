// src/app/api/tts/stop/route.ts
//
// POST /api/tts/stop
//
// Stops the TTS service supervised by `app/tts-service/scripts/start-tts.sh`.
// SIGTERM with a 10s grace period, then SIGKILL. Same localhost check.
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { workerControlAuthorized } from '@/lib/utils/worker-control';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!workerControlAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'TTS control is only allowed from localhost.' },
      { status: 403 },
    );
  }

  const candidates = [
    path.resolve(process.cwd(), 'app', 'tts-service', 'scripts', 'start-tts.sh'),
    path.resolve(process.cwd(), '..', 'app', 'tts-service', 'scripts', 'start-tts.sh'),
    path.resolve(process.cwd(), '..', 'tts-service', 'scripts', 'start-tts.sh'),
    path.resolve(process.cwd(), 'tts-service', 'scripts', 'start-tts.sh'),
    '/Volumes/EXT-SSD/Users/anhl/local-ai-ebook/app/tts-service/scripts/start-tts.sh',
  ];
  const script = candidates.find((p) => fs.existsSync(p));
  if (!script) {
    return NextResponse.json(
      { ok: false, error: 'start-tts.sh not found.' },
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

  return NextResponse.json({ ok: true, message: 'TTS stopped.', stdout, stderr });
}
