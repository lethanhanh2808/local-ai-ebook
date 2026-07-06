// src/components/library/CharacterBible.tsx
//
// "Character Bible" section inside the Voices tab.
//
// Fetches /api/library/:bookId/characters/bible and renders:
//   - Pending-diffs conflict banner (when worker queued manual-review changes)
//   - Per-character accordion with description / personality / speech style /
//     relationships / chapter appearances
//   - Edit modal (3 textareas; sets source='user' server-side)
//   - Refresh modal that streams SSE progress from the Bible refresh route
//   - Per-diff Approve / Reject (and Apply All for non-conflicts)
//
// The component is self-contained — no props apart from bookId. Mounted
// from VoicePanel.tsx above the AI Character Detection card.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Edit3,
  Loader2,
  RefreshCw,
  Check,
  X,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/layout/ErrorState';

// ── Types (mirrors src/lib/db/character-bible.ts + the GET /bible route) ─

interface BibleResponse {
  bookId: string;
  characters: Array<{
    id: string;
    name: string;
    gender: string | null;
    role: string;
    voiceId: string | null;
  }>;
  profiles: Record<string, {
    description: string | null;
    personality: string | null;
    speechStyle: string | null;
    source: 'llm' | 'user' | 'mixed';
    version: number;
    updatedAt: string;
  }>;
  relationships: Array<{
    id: string;
    fromCharId: string;
    fromCharName: string;
    toCharId: string;
    toCharName: string;
    relationship: string;
    asOfChapterIdx: number | null;
    notes: string | null;
    source: string;
    updatedAt: string;
  }>;
  appearances: Record<string, Record<string, { mentions: number; analyzedAt: string }>>;
  pendingDiffs: Array<{
    id: string;
    bookId: string;
    patch: {
      kind: 'new' | 'update' | 'relationship' | 'appearance';
      characterId?: string | null;
      newCharacter?: { name: string; aliases?: string[]; gender?: string | null; role?: string };
      updateFields?: { description?: string; personality?: string; speechStyle?: string };
      relationship?: { fromCharName?: string; toCharName?: string; relationship: string; notes?: string };
      evidenceQuote?: string;
      autoReason: string;
      conflictWith?: string;
    };
    status: string;
    createdAt: string;
  }>;
  pendingCount: number;
  lastUpdatedAt: string | null;
}

interface CharacterBibleProps {
  bookId: string;
}

/** Subset of /api/library/:id/chapters — used to populate the refresh
 *  picker dropdown. We fetch this separately rather than baking it into
 *  GET /bible because chapter parsing requires reading the EPUB from disk
 *  while the bible view is just a few Prisma queries. */
interface ChapterListEntry {
  id: string;
  title: string;
  order: number;
  file: string;
}

const ROLE_LABEL_VI: Record<string, string> = {
  main: 'Chính',
  supporting: 'Phụ',
  minor: 'Nhỏ',
  crowd: 'Đám đông',
};

// ── Main component ────────────────────────────────────────────────────────

export function CharacterBible({ bookId }: CharacterBibleProps) {
  const [data, setData] = useState<BibleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [expandedCharId, setExpandedCharId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [chapters, setChapters] = useState<ChapterListEntry[]>([]);
  // Chapter-list loading / error are surfaced INSIDE the RefreshModal so the
  // user sees why the Process button is stuck disabled instead of wondering
  // where it went (previously these were silently swallowed and the button
  // rendered at 50% opacity with no diagnostic).
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [chaptersError, setChaptersError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/library/${bookId}/characters/bible`);
      if (!res.ok) throw new Error(`Failed to fetch bible (${res.status})`);
      const json = (await res.json()) as BibleResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  // Fetch chapter list separately — used to populate the refresh picker.
  // Errors are now surfaced (status + message) so the modal can show a
  // retry button instead of looking like a missing Process button.
  const loadChapters = useCallback(async () => {
    try {
      setChaptersLoading(true);
      setChaptersError(null);
      const res = await fetch(`/api/library/${bookId}/chapters`);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ''}`);
      }
      const j = (await res.json()) as ChapterListEntry[];
      setChapters(Array.isArray(j) ? j : []);
    } catch (e) {
      setChaptersError(e instanceof Error ? e.message : String(e));
      setChapters([]);
    } finally {
      setChaptersLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    void reload();
    void loadChapters();
  }, [reload, loadChapters]);

  // Refetch the chapter list every time the user opens the modal — a stale
  // list (e.g. book re-converted since last open) was previously the common
  // "stuck at chapter X even though I added Chapter Y" footgun.
  useEffect(() => {
    if (refreshOpen) void loadChapters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshOpen]);

  const hasPending = (data?.pendingCount ?? 0) > 0;

  return (
    <Card className="rounded-xl border border-border p-4 space-y-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <BookOpen className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">📖 Character Bible</span>
          {hasPending && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-bible-pending-bg text-bible-pending-fg border border-border border-bible-pending-border">
              {data?.pendingCount} chờ duyệt
            </span>
          )}
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRefreshOpen(true)}
            className="h-7 px-2 text-xs"
            title="Yêu cầu LLM đọc lại các chương đã có và đề xuất cập nhật"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
        </div>
      </button>

      {open && (
        <>
          {loading && !data && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải bible…
            </div>
          )}
          {error && (
            <ErrorState
              onRetry={() => void reload()}
              message={error}
              details={String(error)}
              retrying={loading}
              className="my-2"
            />
          )}
          {hasPending && data && (
            <PendingDiffsBanner data={data} onChanged={reload} onApplyAll={async () => {
              await fetch(`/api/library/${bookId}/characters/bible/diffs/apply-all`, { method: 'POST' });
              await reload();
            }} />
          )}
          {data && data.characters.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Chưa có nhân vật nào. Hãy chạy AI Character Detection trước.
            </p>
          )}
          {data && data.characters.length > 0 && (
            <div className="space-y-1.5">
              {data.characters.map((c) => (
                <CharacterRow
                  key={c.id}
                  character={c}
                  profile={data.profiles[c.id]}
                  outEdges={data.relationships.filter((r) => r.fromCharId === c.id)}
                  inEdges={data.relationships.filter((r) => r.toCharId === c.id)}
                  appearances={data.appearances[c.id]}
                  expanded={expandedCharId === c.id}
                  onToggleExpand={() => setExpandedCharId((id) => (id === c.id ? null : c.id))}
                  onEdit={() => setEditTarget(c.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {editTarget && data && (
        <EditProfileModal
          characterName={data.characters.find((c) => c.id === editTarget)?.name ?? '?'}
          profile={data.profiles[editTarget]}
          onClose={() => setEditTarget(null)}
          onSaved={async (fields) => {
            const res = await fetch(`/api/library/${bookId}/characters/${editTarget}/profile`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fields),
            });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              throw new Error(j.error || `HTTP ${res.status}`);
            }
            setEditTarget(null);
            await reload();
          }}
        />
      )}

      {refreshOpen && (
        <RefreshModal
          bookId={bookId}
          chapters={chapters}
          chaptersLoading={chaptersLoading}
          chaptersError={chaptersError}
          onRetryChapters={loadChapters}
          onClose={() => setRefreshOpen(false)}
          onFinished={async () => {
            setRefreshOpen(false);
            await reload();
          }}
        />
      )}
    </Card>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function CharacterRow({
  character,
  profile,
  outEdges,
  inEdges,
  appearances,
  expanded,
  onToggleExpand,
  onEdit,
}: {
  character: { id: string; name: string; gender: string | null; role: string };
  profile?: { description: string | null; personality: string | null; speechStyle: string | null; source: string };
  outEdges: BibleResponse['relationships'];
  inEdges: BibleResponse['relationships'];
  appearances?: Record<string, { mentions: number; analyzedAt: string }>;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
}) {
  const desc = profile?.description ?? null;
  const hasContent = !!desc || outEdges.length > 0 || inEdges.length > 0;
  const chapterEntries = Object.entries(appearances ?? {}).map(([k, v]) => ({
    chapter: Number(k),
    mentions: v.mentions,
  })).sort((a, b) => a.chapter - b.chapter);
  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-2 flex-1 text-left"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="text-sm font-medium">{character.name}</span>
          {profile && (
            <span className={cn(
              'text-[10px] px-1.5 py-0.5 rounded border border-border',
              profile.source === 'user'  ? 'border-bible-source-user-border   bg-bible-source-user-bg   text-bible-source-user-fg' :
              profile.source === 'mixed' ? 'border-bible-source-mixed-border bg-bible-source-mixed-bg text-bible-source-mixed-fg' :
                                            'border-bible-source-llm-border   bg-bible-source-llm-bg   text-bible-source-llm-fg',
            )}>
              {profile.source === 'user' ? '✋ user' :
               profile.source === 'mixed' ? '🔀 mixed' :
               '🤖 llm'}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{ROLE_LABEL_VI[character.role] ?? character.role}</span>
        </button>
        {expanded && (
          <Button size="sm" variant="ghost" onClick={onEdit} className="h-7 px-2 text-xs">
            <Edit3 className="h-3 w-3 mr-1" />
            Edit
          </Button>
        )}
      </div>
      {/* Inline preview when collapsed */}
      {!expanded && desc && (
        <p className="text-xs text-muted-foreground px-7 pb-2 truncate">{desc}</p>
      )}
      {!expanded && !desc && hasContent && (
        <p className="text-xs text-muted-foreground px-7 pb-2 italic">
          ({outEdges.length + inEdges.length} quan hệ)
        </p>
      )}
      {expanded && (
        <div className="px-4 pb-3 pt-1 space-y-2 border-t border-border">
          {profile?.description && (
            <Field label="Mô tả" value={profile.description} />
          )}
          {profile?.personality && (
            <Field label="Tính cách" value={profile.personality} />
          )}
          {profile?.speechStyle && (
            <Field label="Cách nói" value={profile.speechStyle} />
          )}
          {outEdges.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Quan hệ (ra)</p>
              <ul className="text-xs space-y-0.5">
                {outEdges.map((e) => (
                  <li key={e.id}>→ <strong>{e.relationship}</strong> {e.toCharName}{e.notes ? ` — ${e.notes}` : ''}</li>
                ))}
              </ul>
            </div>
          )}
          {inEdges.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Quan hệ (vào)</p>
              <ul className="text-xs space-y-0.5">
                {inEdges.map((e) => (
                  <li key={e.id}>{e.fromCharName} <strong>{e.relationship}</strong> →{e.notes ? ` — ${e.notes}` : ''}</li>
                ))}
              </ul>
            </div>
          )}
          {chapterEntries.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Xuất hiện</p>
              <p className="text-xs">
                {chapterEntries.map((c) => `ch.${c.chapter}${c.mentions > 1 ? `×${c.mentions}` : ''}`).join(', ')}
              </p>
            </div>
          )}
          {!profile?.description && !profile?.personality && !profile?.speechStyle &&
           outEdges.length === 0 && inEdges.length === 0 && chapterEntries.length === 0 && (
            <p className="text-xs italic text-muted-foreground">
              Chưa có dữ liệu. Nhấn "Refresh" để LLM đề xuất, hoặc "Edit" để tự điền.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-0.5">{label}</p>
      <p className="text-xs whitespace-pre-wrap">{value}</p>
    </div>
  );
}

function PendingDiffsBanner({
  data, onChanged, onApplyAll,
}: {
  data: BibleResponse;
  onChanged: () => void | Promise<void>;
  onApplyAll: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const conflicts = data.pendingDiffs.filter((d) => d.patch.autoReason.startsWith('conflict-'));
  const safe = data.pendingDiffs.filter((d) => !d.patch.autoReason.startsWith('conflict-'));
  return (
    <div className="rounded-lg border border-border border-bible-pending-border bg-bible-pending-bg p-3 space-y-2">
      <div className="flex items-center gap-2 text-bible-pending-fg">
        <AlertTriangle className="h-4 w-4" />
        <strong className="text-sm">{data.pendingCount} thay đổi chờ duyệt</strong>
        {safe.length > 0 && (
          <Button
            size="sm" variant="outline"
            className="ml-auto h-7 px-2 text-xs"
            disabled={busy}
            onClick={async () => { setBusy(true); try { await onApplyAll(); } finally { setBusy(false); } }}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
            Áp dụng không xung đột ({safe.length})
          </Button>
        )}
      </div>
      <ul className="space-y-1">
        {data.pendingDiffs.map((d) => (
          <li key={d.id} className="text-xs flex items-start gap-2">
            <span className="font-mono text-muted-foreground">[{d.patch.kind}]</span>
            <span className="flex-1">
              {summaryForDiff(d)}{' '}
              {d.patch.evidenceQuote && (
                <em className="text-muted-foreground">"{d.patch.evidenceQuote.slice(0, 100)}…"</em>
              )}
              {d.patch.autoReason.startsWith('conflict-') && (
                <span className="ml-2 text-bible-pending-fg font-medium">
                  {d.patch.conflictWith ? `(xung đột: ${d.patch.conflictWith})` : '(cần bạn duyệt)'}
                </span>
              )}
            </span>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-emerald-700"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await fetch(`/api/library/${data.bookId}/characters/bible/diffs/${d.id}/apply`, { method: 'POST' });
                  await onChanged();
                } finally { setBusy(false); }
              }}
              title="Áp dụng"
            ><Check className="h-3 w-3" /></Button>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await fetch(`/api/library/${data.bookId}/characters/bible/diffs/${d.id}/reject`, { method: 'POST' });
                  await onChanged();
                } finally { setBusy(false); }
              }}
              title="Bỏ qua"
            ><X className="h-3 w-3" /></Button>
          </li>
        ))}
      </ul>
      {conflicts.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {conflicts.length} thay đổi xung đột với những gì bạn đã sửa — mỗi thay đổi cần được duyệt riêng.
        </p>
      )}
    </div>
  );
}

function summaryForDiff(d: BibleResponse['pendingDiffs'][number]): string {
  const p = d.patch;
  if (p.kind === 'new' && p.newCharacter) {
    return `Thêm nhân vật mới: ${p.newCharacter.name}`;
  }
  if (p.kind === 'update' && p.updateFields) {
    const fields = Object.keys(p.updateFields).join(', ');
    return `Cập nhật [${fields}]`;
  }
  if (p.kind === 'relationship' && p.relationship) {
    const r = p.relationship;
    return `Quan hệ: ${r.fromCharName ?? '?'} → ${r.toCharName ?? '?'} (${r.relationship})`;
  }
  return p.kind;
}

function EditProfileModal({
  characterName, profile, onClose, onSaved,
}: {
  characterName: string;
  profile?: { description: string | null; personality: string | null; speechStyle: string | null };
  onClose: () => void;
  onSaved: (fields: { description?: string | null; personality?: string | null; speechStyle?: string | null }) => Promise<void>;
}) {
  const [desc, setDesc] = useState(profile?.description ?? '');
  const [pers, setPers] = useState(profile?.personality ?? '');
  const [style, setStyle] = useState(profile?.speechStyle ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} widthClass="max-w-xl" title={`Sửa profile — ${characterName}`}>
      <DialogBody>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Lưu ý: những thay đổi này sẽ được đánh dấu <strong>✋ user</strong>. LLM refresh sẽ không tự ý ghi đè.
          </p>
          <Labeled label="Mô tả">
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3}
              className="w-full rounded-md border border-border bg-background p-2 text-xs" />
          </Labeled>
          <Labeled label="Tính cách">
            <textarea value={pers} onChange={(e) => setPers(e.target.value)} rows={3}
              className="w-full rounded-md border border-border bg-background p-2 text-xs" />
          </Labeled>
          <Labeled label="Cách nói">
            <textarea value={style} onChange={(e) => setStyle(e.target.value)} rows={2}
              className="w-full rounded-md border border-border bg-background p-2 text-xs" />
          </Labeled>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="sm" variant="outline" onClick={onClose}>Huỷ</Button>
        <Button size="sm" disabled={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try {
            await onSaved({
              description: desc || null,
              personality: pers || null,
              speechStyle: style || null,
            });
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally { setBusy(false); }
        }}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          Lưu
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  );
}

interface RefreshProgressEvent {
  kind: string;
  [k: string]: unknown;
}

/** Streaming refresh modal. Sends a POST to the SSE refresh endpoint and
 *  appends human-readable lines to an in-modal log so the user can watch
 *  the LLM work without having to open devtools.
 *
 *  Whole-book scans are intentionally not supported (a single 40k-char
 *  chapter already pushed us into "Unexpected end of JSON input" and a
 *  full novel blows the prompt budget). The user MUST pick a single
 *  chapter from the dropdown — auto-on-close hooks handle the steady
 *  state, manual refresh is for backfilling a chapter that missed it. */

/** Mid-string truncation (e.g. "abcdefghijklmno" with max=10 → "abcde…lmno").
 *  Used for chapter titles in the refresh picker — end-truncation hides the
 *  meaningful suffix (usually the chapter number), so we cut from the middle. */
function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

function RefreshModal({
  bookId, chapters, chaptersLoading, chaptersError, onRetryChapters, onClose, onFinished,
}: {
  bookId: string;
  chapters: ChapterListEntry[];
  chaptersLoading: boolean;
  chaptersError: string | null;
  onRetryChapters: () => void | Promise<void>;
  onClose: () => void;
  onFinished: () => void | Promise<void>;
}) {
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [pickedIdx, setPickedIdx] = useState<number | ''>('');
  const [result, setResult] = useState<{ autoApplied: number; queued: number; conflicts: number; durationMs: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const picked = typeof pickedIdx === 'number' ? chapters[pickedIdx] : undefined;
  const canStart = !!picked && !busy;

  const start = () => {
    if (!picked) return;
    setBusy(true);
    setStarted(true);
    setLogs([]);
    setErr(null);
    setResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const append = (line: string) => setLogs((prev) => [...prev, line]);
    (async () => {
      try {
        const res = await fetch(`/api/library/${bookId}/characters/bible/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chapterIndex: pickedIdx,
            chapterFile: picked.file,
            autoMerge: false,
          }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const txt = await res.text().catch(() => '');
          setErr(`Refresh HTTP ${res.status}${txt ? ` — ${txt.slice(0, 200)}` : ''}`);
          setBusy(false);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE messages are separated by blank lines.
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const msg = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = msg.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const ev = JSON.parse(data) as RefreshProgressEvent;
              append(formatProgress(ev));
              if (ev.kind === 'done') {
                setResult({
                  autoApplied: Number(ev.autoApplied ?? 0),
                  queued: Number(ev.queued ?? 0),
                  conflicts: Number(ev.conflicts ?? 0),
                  durationMs: Number(ev.durationMs ?? 0),
                });
              }
              if (ev.kind === 'error') {
                setErr(String(ev.message ?? 'unknown error'));
              }
            } catch { /* ignore malformed chunk */ }
          }
        }
      } catch (e) {
        if ((e as { name?: string }).name !== 'AbortError') {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  // Cancel an in-flight stream on unmount.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  return (
    <Dialog open onOpenChange={async (v) => {
      if (!v) {
        abortRef.current?.abort();
        await onFinished();
      }
    }} widthClass="max-w-2xl" title={
      <span className="flex items-center gap-2">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-primary" />}
        Làm mới bible cho một chương
      </span>
    }>
      <DialogBody>
        <div className="space-y-3">
          {!started && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                Chọn một chương để LLM phân tích. Mỗi lần chỉ một chương — bible sẽ tích lũy dần qua các lần refresh.
                (Auto-on-close đã lo phần lớn; bạn chỉ cần thao tác thủ công khi muốn backfill.)
              </p>

              {/* LOADING state — distinguishes cold-start from a true empty list */}
              {chaptersLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Đang tải danh sách chương…
                </div>
              )}

              {/* ERROR state — was previously swallowed; now surfaced with a
                  retry button so the user isn't stuck staring at an inert Process button. */}
              {!chaptersLoading && chaptersError && (
                <div className="space-y-2 rounded border border-border border-destructive/30 bg-destructive/5 p-2">
                  <p className="text-xs text-destructive">
                    Không tải được danh sách chương: {chaptersError}
                  </p>
                  <Button size="sm" variant="outline" onClick={() => void onRetryChapters()}>
                    <RefreshCw className="h-3 w-3 mr-1" /> Thử lại
                  </Button>
                </div>
              )}

              {/* READY state — show just the chapter picker. The Process
                  button now lives in the footer next to "Đóng" (per user
                  request — was previously crammed inline next to the select). */}
              {!chaptersLoading && !chaptersError && (
                <select
                  value={pickedIdx === '' ? '' : String(pickedIdx)}
                  onChange={(e) => setPickedIdx(e.target.value === '' ? '' : Number(e.target.value))}
                  disabled={chapters.length === 0}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm truncate"
                >
                  <option value="">
                    {chapters.length === 0
                      ? 'Sách chưa có chương nào'
                      : `-- Chọn chương (${chapters.length}) --`}
                  </option>
                  {chapters.map((c, i) => (
                    // Chapter titles can be very long ("Chương 123: …"). Native
                    // <option> elements can't be reliably truncated via CSS
                    // across browsers, so we clamp the visible text JS-side
                    // and put the full text in the `title` attribute for the
                    // hover tooltip. ~50 chars is enough for the dropdown
                    // width of ~30rem without overflowing.
                    <option key={c.id} value={i} title={c.title || c.id}>
                      {c.order}. {truncateMid(c.title || c.id, 50)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {started && (
            <div className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] leading-tight">
              {logs.length === 0 && busy && <p className="text-muted-foreground italic">Đang khởi động worker…</p>}
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
          {result && (
            <p className="text-xs">
              ✓ Xong sau {(result.durationMs / 1000).toFixed(1)}s — áp dụng {result.autoApplied}, chờ duyệt {result.queued}, xung đột {result.conflicts}.
            </p>
          )}
          {err && (
            <pre className="text-xs text-destructive whitespace-pre-wrap font-mono max-h-40 overflow-auto rounded border border-border border-destructive/30 bg-destructive/5 p-2">
              Lỗi: {err}
            </pre>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button
          size="sm"
          disabled={!canStart}
          onClick={start}
          className={cn(
            'font-semibold',
            !canStart && 'opacity-60',   // keep visible (less ghosted) so the user knows it's there
          )}
          title={
            !picked
              ? 'Chọn một chương trước'
              : 'Chạy LLM phân tích chương đã chọn'
          }
        >
          <RefreshCw className="h-3 w-3 mr-1" /> Process · Bắt đầu
        </Button>
        <Button size="sm" variant="outline" onClick={async () => {
          abortRef.current?.abort();
          await onFinished();
        }}
          disabled={busy && !result}>
          Đóng
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function formatProgress(ev: RefreshProgressEvent): string {
  switch (ev.kind) {
    case 'reading-bible': return '→ Đọc bible hiện tại…';
    case 'fetching-chapter': return `→ Đang lấy chương ${ev.chapterIndex}${ev.chapterFile ? ` (${ev.chapterFile})` : ''}…`;
    case 'reading-chapter': return `→ Đã đọc ${ev.chars} ký tự từ chương`;
    case 'calling-llm': return '🤖 Đang gọi LLM…';
    case 'llm-done': return `🤖 LLM trả lời sau ${ev.durationMs}ms`;
    case 'applying': return '→ Áp dụng patches…';
    case 'done': return `✓ Hoàn tất (applied=${ev.autoApplied}, queued=${ev.queued}, conflicts=${ev.conflicts}, ${ev.durationMs}ms)`;
    case 'error': return `✗ Lỗi: ${ev.message}`;
    default: return `[${ev.kind}]`;
  }
}
