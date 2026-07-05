// src/app/api/worker/status/route.ts
// GET /api/worker/status
// Lightweight health check — returns whether the conversion worker is reachable
// and how many jobs are queued. The worker itself pings a Redis key every
// few seconds when it's alive.
//
// Why this matters: if the worker process dies, jobs sit in the BullMQ queue
// forever with no visible error. This endpoint lets the UI show a "Worker
// offline" banner so the user knows to restart it.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { getQueue } from '@/lib/queue';
import { listJobs } from '@/lib/db/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKER_ALIVE_KEY = 'ebook:worker:alive';
const WORKER_ALIVE_TTL_SEC = 30; // worker must ping at least every 30s

interface WorkerStatus {
  online: boolean;
  lastSeenAt: string | null; // ISO timestamp
  redis: boolean;
  counts: { pending: number; queued: number; processing: number; completed: number; failed: number };
  recommendation: string | null;
}

export async function GET(_req: NextRequest) {
  let online = false;
  let lastSeenAt: string | null = null;
  let redisOk = false;

  try {
    const { default: IORedis } = await import('ioredis');
    const { redisConnection } = await import('@/lib/queue');
    const r = new IORedis(redisConnection);
    redisOk = (r.status === 'ready' || r.status === 'connecting');
    const last = await r.get(WORKER_ALIVE_KEY);
    if (last) {
      lastSeenAt = new Date(parseInt(last, 10)).toISOString();
      // Within TTL?
      online = Date.now() - parseInt(last, 10) < WORKER_ALIVE_TTL_SEC * 1000;
    }
    await r.quit().catch(() => {});
  } catch (err) {
    redisOk = false;
  }

  // Job counts (DB-backed, doesn't require the worker)
  const allJobs = await listJobs(500).catch(() => []);
  const counts = {
    pending:   allJobs.filter((j) => j.status === 'pending').length,
    queued:    allJobs.filter((j) => j.status === 'queued').length,
    processing:allJobs.filter((j) => j.status === 'processing').length,
    completed: allJobs.filter((j) => j.status === 'completed').length,
    failed:    allJobs.filter((j) => j.status === 'failed').length,
  };

  let recommendation: string | null = null;
  if (!redisOk) {
    recommendation = 'Redis không khả dụng — worker cần Redis để nhận job. Kiểm tra `redis-server` đang chạy.';
  } else if (!online) {
    recommendation = 'Worker process không chạy. Chạy `./scripts/start-worker.sh --start` để xử lý conversion và audiobook jobs.';
  } else if (counts.queued > 0 || counts.pending > 0) {
    recommendation = null; // all good, jobs are being processed
  }

  const status: WorkerStatus = { online, lastSeenAt, redis: redisOk, counts, recommendation };
  return NextResponse.json(status);
}
