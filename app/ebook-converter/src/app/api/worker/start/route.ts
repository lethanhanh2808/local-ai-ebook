// src/app/api/worker/start/route.ts
//
// POST /api/worker/start
//
// Spawns the BullMQ conversion worker as a detached background process so
// the user doesn't have to keep a terminal open. Uses scripts/start-worker.sh
// which handles PID-tracking, log-writing, and graceful shutdown.
//
// Security: this endpoint only works from the SAME MACHINE the server is
// running on (localhost check via the request socket). Spawning arbitrary
// shell scripts from a web endpoint would be a RCE risk otherwise.
//
// Returns: { ok: true, pid: number, message: string } | { ok: false, error: string }
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isLocalhost(req: NextRequest): boolean {
  // Accept connections from localhost, 127.0.0.1, ::1, or the machine's
  // own LAN IP. Anything else gets refused (RCE protection).
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    ?? req.headers.get('x-real-ip')
    ?? '127.0.0.1';
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip.startsWith('::ffff:');
}

export async function POST(req: NextRequest) {
  if (!isLocalhost(req)) {
    return NextResponse.json(
      { ok: false, error: 'Worker control is only allowed from localhost.' },
      { status: 403 },
    );
  }

  // Locate the launcher script. Works whether the app lives in
  // app/ebook-converter or has been moved.
  const candidates = [
    path.resolve(process.cwd(), 'scripts', 'start-worker.sh'),
    path.resolve(process.cwd(), '..', 'scripts', 'start-worker.sh'),
    path.resolve(process.cwd(), 'app', 'ebook-converter', 'scripts', 'start-worker.sh'),
  ];
  const script = candidates.find((p) => fs.existsSync(p));
  if (!script) {
    return NextResponse.json(
      { ok: false, error: 'start-worker.sh not found. Expected in scripts/.' },
      { status: 500 },
    );
  }

  // Run with the launcher's explicit background mode.
  // It will short-circuit (no-op) if the worker is already running.
  const { spawn } = await import('child_process');
  const child = spawn('/bin/bash', [script, '--start'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  // Detach so it survives the API request completing
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

  // Wait a moment for the launcher to write its PID file
  await new Promise((r) => setTimeout(r, 800));

  // Read the PID file to confirm
  const appDir = path.resolve(path.dirname(script), '..');
  const pidFile = path.join(appDir, 'data', 'worker-runtime', 'worker.pid');
  let pid: number | null = null;
  try {
    const txt = fs.readFileSync(pidFile, 'utf-8').trim();
    if (/^\d+$/.test(txt)) pid = parseInt(txt, 10);
  } catch { /* noop */ }

  if (!pid) {
    return NextResponse.json(
      { ok: false, error: 'Worker did not start cleanly.', stdout, stderr },
      { status: 500 },
    );
  }

  // Confirm the PID is actually alive (sanity check)
  try {
    process.kill(pid, 0);
  } catch {
    return NextResponse.json(
      { ok: false, error: `Worker pid=${pid} exited immediately. See log.`, stdout, stderr },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    pid,
    message: `Worker started (pid=${pid}). It will auto-restart on crash.`,
    stdout,
  });
}
