// src/app/api/library/[id]/chapters/[chapterId]/voice-plan/history/[historyId]/route.ts
//
// GET → return the sentences stored in a specific history snapshot so the
//       client can preview / restore it. Restoring is a client-side action:
//       the client snapshots the CURRENT plan to history first (so the restore
//       itself is reversible), then PUTs the snapshot's sentences.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { loadChapterRef } from '@/lib/voice-plan-loader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string; historyId: string }> },
) {
  const params = await props.params;
  const ref = await loadChapterRef(req, params.id, params.chapterId);
  if ('error' in ref) return NextResponse.json({ error: ref.error }, { status: ref.status });

  const row = await prisma.voicePlanHistory.findFirst({
    where: { id: params.historyId, bookId: params.id, chapterIndex: ref.chapterIndex },
  });
  if (!row) return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });

  let sentences: unknown[];
  try {
    sentences = JSON.parse(row.sentences) as unknown[];
  } catch {
    return NextResponse.json({ error: 'Corrupt snapshot' }, { status: 500 });
  }

  return NextResponse.json({ id: row.id, label: row.label, createdAt: row.createdAt.toISOString(), sentences });
}
