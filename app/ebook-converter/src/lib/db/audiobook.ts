// src/lib/db/audiobook.ts
// CRUD helpers for AudiobookChapter — tracks pre-generated audio per chapter.
import { prisma } from './client';

export interface CreateAudiobookChapterInput {
  bookId: string;
  chapterFile: string;
  chapterTitle?: string;
  configHash?: string;
}

/** Mark every chapter of a book as pending and delete any existing audio paths. */
export async function resetAudiobook(bookId: string) {
  // Get existing paths to clean up files
  const existing = await prisma.audiobookChapter.findMany({
    where: { bookId, audioPath: { not: null } },
    select: { audioPath: true },
  });
  // Status → 'none' (NOT 'generating' — that confused the UI into thinking
  //  the worker was still running). Reset means: cleared, not started.
  await prisma.book.update({
    where: { id: bookId },
    data: { audiobookStatus: 'none', audiobookGeneratedAt: null, audiobookDurationMs: null },
  });
  await prisma.audiobookChapter.deleteMany({ where: { bookId } });
  return existing.map((e) => e.audioPath!).filter(Boolean);
}

export async function ensureChapterRow(input: CreateAudiobookChapterInput) {
  return prisma.audiobookChapter.upsert({
    where: { bookId_chapterFile: { bookId: input.bookId, chapterFile: input.chapterFile } },
    create: {
      bookId: input.bookId,
      chapterFile: input.chapterFile,
      chapterTitle: input.chapterTitle,
      status: 'pending',
      configHash: input.configHash,
    },
    update: {
      ...(input.chapterTitle ? { chapterTitle: input.chapterTitle } : {}),
      ...(input.configHash ? { configHash: input.configHash } : {}),
    },
  });
}

export async function updateChapter(
  id: string,
  data: {
    status?: string;
    progress?: number;
    audioPath?: string | null;
    durationMs?: number | null;
    sizeBytes?: number | null;
    errorMsg?: string | null;
    generatedAt?: Date | null;
    configHash?: string | null;
  },
) {
  return prisma.audiobookChapter.update({ where: { id }, data });
}

export async function getChapter(bookId: string, chapterFile: string) {
  return prisma.audiobookChapter.findUnique({
    where: { bookId_chapterFile: { bookId, chapterFile } },
  });
}

export async function listChapters(bookId: string) {
  return prisma.audiobookChapter.findMany({
    where: { bookId },
    orderBy: { chapterFile: 'asc' },
  });
}

export async function setBookAudiobookStatus(
  bookId: string,
  status: 'none' | 'generating' | 'ready' | 'partial' | 'failed',
  totals?: { durationMs?: number; generatedAt?: Date | null },
) {
  await prisma.book.update({
    where: { id: bookId },
    data: {
      audiobookStatus: status,
      ...(totals?.durationMs !== undefined ? { audiobookDurationMs: totals.durationMs } : {}),
      ...(totals?.generatedAt !== undefined ? { audiobookGeneratedAt: totals.generatedAt } : {}),
    },
  });
}

export async function getAudiobookSummary(bookId: string) {
  const chapters = await prisma.audiobookChapter.findMany({
    where: { bookId },
    select: { status: true, durationMs: true, sizeBytes: true, chapterFile: true },
  });
  const total = chapters.length;
  const ready = chapters.filter((c) => c.status === 'ready').length;
  const failed = chapters.filter((c) => c.status === 'failed').length;
  const pending = chapters.filter((c) => c.status === 'pending' || c.status === 'generating').length;
  const durationMs = chapters.reduce((s, c) => s + (c.durationMs ?? 0), 0);
  const sizeBytes = chapters.reduce((s, c) => s + (c.sizeBytes ?? 0), 0);

  // Voice-plan coverage: how many chapters have a saved Phân giọng plan, and
  // how many sentences the AI flagged as uncertain (need manual review). Used
  // by the Audiobook panel to warn before generation. Computed cheaply from
  // the stored JSON (no LLM calls).
  const plans = await prisma.chapterVoicePlan.findMany({
    where: { bookId },
    select: { sentences: true },
  });
  let plannedChapters = 0;
  let uncertainSentences = 0;
  let assignedSentences = 0;
  for (const p of plans) {
    let arr: Array<{ voiceId?: string | null; uncertain?: boolean }> = [];
    try { arr = JSON.parse(p.sentences) as typeof arr; } catch { continue; }
    if (arr.length > 0) plannedChapters++;
    for (const s of arr) {
      if (s.voiceId != null) assignedSentences++;
      if (s.uncertain) uncertainSentences++;
    }
  }

  return {
    total,
    ready,
    failed,
    pending,
    durationMs,
    sizeBytes,
    pct: total === 0 ? 0 : Math.round((ready / total) * 100),
    coverage: {
      plannedChapters,
      totalChapters: total,
      assignedSentences,
      uncertainSentences,
    },
  };
}
