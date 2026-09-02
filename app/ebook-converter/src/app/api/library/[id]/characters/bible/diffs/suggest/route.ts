// src/app/api/library/[id]/characters/bible/diffs/suggest/route.ts
// POST   /api/library/:id/characters/bible/diffs/suggest
//
// Ask the AI to review one or more pending bible diffs and recommend a
// decision for each: accept the proposed change, reject it (keep current),
// or merge (combine current + proposed into a better value).
//
// Body (one of):
//   { diffId: string }                       – review a single diff
//   { diffIds: string[] }                    – review a batch in ONE LLM call
//
// Response:
//   { ok: true, results: Array<{
//       diffId: string,
//       decision: 'accept' | 'reject' | 'merge',
//       reason: string,
//       merged?: { description?, personality?, speechStyle?, visualDescription? }
//   }> }
//
// The endpoint only READS + reasons — it never mutates the bible. The UI
// shows the recommendation and lets the user apply it (or ignore it).
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { chatJSON } from '@/lib/ai';
import type { BibleDiffPatch } from '@/lib/db/character-bible';

export const dynamic = 'force-dynamic';

type Decision = 'accept' | 'reject' | 'merge';
interface Suggestion {
  diffId: string;
  decision: Decision;
  reason: string;
  merged?: Partial<{ description: string; personality: string; speechStyle: string; visualDescription: string }>;
}

const FIELD_LABELS: Record<string, string> = {
  description: 'Mô tả',
  personality: 'Tính cách',
  speechStyle: 'Cách nói',
  visualDescription: 'Ngoại hình',
};

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let body: { diffId?: string; diffIds?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const ids = body.diffIds && body.diffIds.length > 0
    ? body.diffIds
    : body.diffId
      ? [body.diffId]
      : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Provide diffId or diffIds' }, { status: 400 });
  }

  // Load the requested diffs (pending only) for this book.
  const rows = await prisma.pendingBibleDiff.findMany({
    where: { bookId: params.id, id: { in: ids }, status: 'pending' },
  });
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, results: [] });
  }

  // Gather current profile values for every character referenced by an update diff.
  const charIds = Array.from(
    new Set(
      rows
        .map((r) => {
          try { return (JSON.parse(r.patch) as BibleDiffPatch).characterId; } catch { return null; }
        })
        .filter((c): c is string => !!c),
    ),
  );
  const profiles = await prisma.characterProfile.findMany({
    where: { characterId: { in: charIds } },
    select: { characterId: true, description: true, personality: true, speechStyle: true, visualDescription: true },
  });
  const profileByChar = new Map(profiles.map((p) => [p.characterId, p]));

  const items = rows.map((r) => {
    const patch = JSON.parse(r.patch) as BibleDiffPatch;
    const current = patch.characterId ? profileByChar.get(patch.characterId) : undefined;
    return { diffId: r.id, patch, current };
  });

  const sysPrompt = [
    'Bạn là biên tập viên văn học. Nhiệm vụ: xem xét các ĐỀ XUẤT cập nhật nhân vật',
    'do AI tạo ra, so sánh với thông tin HIỆN TẠI, và quyết định có nên chấp nhận',
    'hay không. Trả về JSON, không giải thích ngoài lề.',
    '',
    'Với mỗi đề xuất, chọn decision:',
    '- "accept": thông tin mới rõ ràng, bổ sung hoặc thay thế tốt hơn hiện tại.',
    '- "reject": thông tin mới sai, trùng lặp với hiện tại, hoặc không có bằng chứng.',
    '- "merge": cả hai đều có giá trị → kết hợp thành giá trị tốt nhất cho từng trường.',
    '',
    'Nếu decision="merge", trả về "merged" chứa giá trị đã gộp cho MỖI trường',
    'trong đề xuất (giữ nguyên giá trị hiện tại nếu đề xuất không cải thiện trường đó).',
    'Luôn kèm "reason" ngắn gọn (1-2 câu, tiếng Việt) giải thích quyết định.',
  ].join('\n');

  const userPrompt = [
    'Danh sách đề xuất (mỗi phần tử có diffId, thông tin HIỆN TẠI và ĐỀ XUẤT):',
    JSON.stringify(
      items.map((it) => ({
        diffId: it.diffId,
        characterId: it.patch.characterId,
        kind: it.patch.kind,
        evidence: it.patch.evidenceQuote,
        current: it.current
          ? {
              description: it.current.description,
              personality: it.current.personality,
              speechStyle: it.current.speechStyle,
              visualDescription: it.current.visualDescription,
            }
          : null,
        proposed: it.patch.updateFields ?? null,
      })),
      null,
      2,
    ),
    '',
    'Trả về JSON array, mỗi phần tử:',
    '{ "diffId": string, "decision": "accept"|"reject"|"merge", "reason": string,',
    '  "merged"?: { "description"?: string, "personality"?: string, "speechStyle"?: string, "visualDescription"?: string } }',
  ].join('\n');

  try {
    const raw = await chatJSON<Array<{ diffId: string; decision: Decision; reason: string; merged?: Suggestion['merged'] }>>({
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      maxRetries: 2,
    });
    // Normalise + validate the model output; fall back to "accept" for any
    // diff the model omitted or returned with an unknown decision.
    const byId = new Map(raw.map((r) => [r.diffId, r]));
    const results: Suggestion[] = items.map((it) => {
      const r = byId.get(it.diffId);
      if (!r || !['accept', 'reject', 'merge'].includes(r.decision)) {
        return { diffId: it.diffId, decision: 'accept', reason: 'Không có đề xuất — mặc định chấp nhận.' };
      }
      return {
        diffId: it.diffId,
        decision: r.decision,
        reason: r.reason ?? '',
        merged: r.decision === 'merge' ? r.merged : undefined,
      };
    });
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `AI suggestion failed: ${msg}` }, { status: 502 });
  }
}