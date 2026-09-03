// src/app/api/tts/start/route.ts
//
// POST /api/tts/start
//
// Spawns (or starts the supervisor for) the local TTS service
// (`vieneu_server.py` on :5020) via `app/tts-service/scripts/start-tts.sh`.
// Same localhost-only authorization as /api/worker/start — spawning shell
// scripts from a web endpoint is a RCE risk on a non-local network.
//
// Returns: { ok: true, pid: number, message: string } | { ok: false, error: string }
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

  // Locate the launcher in the TTS service directory.
  // Mirrors /api/worker/start which looks in 4 candidate paths.
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
      { ok: false, error: 'start-tts.sh not found. Expected in app/tts-service/scripts/.' },
      { status: 500 },
    );
  }

  const { spawn } = await import('child_process');
  const child = spawn('/bin/bash', [script, '--start'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.unref();

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });
  child.stderr?.on('data', (d) => { stderr += d.toString(); });
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    // Don't wait forever — the launcher spawns its own detached child
    setTimeout(() => { try { child.kill(); } catch {} ; resolve(); }, 4000);
  });

  // Give the launcher a moment to write its PID file
  await new Promise((r) => setTimeout(r, 800));

  // Read the PID file to confirm — comes from <tts-service>/logs/vieneu.pid
  const ttsDir = path.resolve(path.dirname(script), '..');
  const pidFile = path.join(ttsDir, 'logs', 'vieneu.pid');
  let pid: number | null = null;
  try {
    const txt = fs.readFileSync(pidFile, 'utf-8').trim();
    if (/^\d+$/.test(txt)) pid = parseInt(txt, 10);
  } catch { /* noop */ }

  if (!pid) {
    return NextResponse.json(
      { ok: false, error: 'TTS did not start cleanly.', stdout, stderr },
      { status: 500 },
    );
  }

  try {
    process.kill(pid, 0);
  } catch {
    return NextResponse.json(
      { ok: false, error: `TTS pid=${pid} exited immediately. See log.`, stdout, stderr },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    pid,
    message: `TTS started (pid=${pid}). It will auto-restart on crash.`,
    stdout,
  });
}
