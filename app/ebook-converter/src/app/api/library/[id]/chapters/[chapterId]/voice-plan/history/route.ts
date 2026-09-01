// src/app/api/library/[id]/chapters/[chapterId]/voice-plan/history/route.ts
//
// GET  → list the rolling history of voice-plan snapshots for a chapter
//        (newest first, capped at 30).
// POST → push the CURRENT plan as a new snapshot. Enforces the 30-entry cap per
//        (bookId, chapterIndex) by dropping the oldest entry when exceeded. This
//        is the "snapshot before apply" safety net: call it right before an
//        apply / restore / manual save so the previous state is always
//        recoverable.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { loadChapterRef } from '@/lib/voice-plan-loader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const HISTORY_CAP = 30;

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> },
) {
  const params = await props.params;
  const ref = await loadChapterRef(req, params.id, params.chapterId);
  if ('error' in ref) return NextResponse.json({ error: ref.error }, { status: ref.status });

  const rows = await prisma.voicePlanHistory.findMany({
    where: { bookId: params.id, chapterIndex: ref.chapterIndex },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_CAP,
  });

  return NextResponse.json({
    history: rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.createdAt.toISOString(),
      count: (() => {
        try {
          return (JSON.parse(r.sentences) as unknown[]).length;
        } catch {
          return 0;
        }
      })(),
    })),
  });
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> },
) {
  const params = await props.params;
  const ref = await loadChapterRef(req, params.id, params.chapterId);
  if ('error' in ref) return NextResponse.json({ error: ref.error }, { status: ref.status });

  let body: { sentences?: unknown; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Array.isArray(body.sentences)) {
    return NextResponse.json({ error: '`sentences` array required' }, { status: 400 });
  }
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Phiên bản';

  // Enforce the cap: if we're at the limit, drop the oldest snapshot first.
  const existing = await prisma.voicePlanHistory.findMany({
    where: { bookId: params.id, chapterIndex: ref.chapterIndex },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (existing.length >= HISTORY_CAP) {
    const overflow = existing.length - HISTORY_CAP + 1;
    const idsToDrop = existing.slice(0, overflow).map((r) => r.id);
    await prisma.voicePlanHistory.deleteMany({
      where: { id: { in: idsToDrop } },
    });
  }

  const created = await prisma.voicePlanHistory.create({
    data: {
      bookId: params.id,
      chapterIndex: ref.chapterIndex,
      sentences: JSON.stringify(body.sentences),
      label,
    },
  });

  return NextResponse.json({ ok: true, id: created.id });
}
