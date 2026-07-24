// src/components/library/CharacterMergeSplitPanel.tsx
//
// Phase 4.4 of docs/NEXT_UP_PLAN.md — Character merge / split UI panel.
// Self-contained card surfaced on /library/[id] below <WatermarksPanel>.
//
// Three regions:
//   1. Merge  — pick two characters, see a side-by-side preview, confirm
//               the merge via Dialog → POST /api/library/[id]/characters/merge.
//   2. Split  — pick a character, check the aliases to move, type the
//               new name + role, confirm via Dialog → POST .../split.
//   3. Aliases — read-only view of every character's aliases with a
//               per-alias confidence badge + "Mark as wrong" button →
//               PATCH /api/library/[id]/characters/[characterId]/aliases/[aliasId].
//
// A "needs review" badge in the header sums:
//   - pendingCount from /api/library/[id]/characters/bible (existing diffs queue)
//   - lowConfidenceCount = number of CharacterAlias rows with confidence < 0.6
//
// All three regions share a refresh helper (refetchAll) so a successful
// mutation updates the badge + lists everywhere at once.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2, RefreshCw, AlertCircle, GitMerge, GitBranch, Tag, Users,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogBody, DialogFooter } from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

// ── Wire types ──────────────────────────────────────────────────────────────

interface AliasDetail {
  id: string;
  alias: string;
  confidence: number;
  source: 'user' | 'llm' | 'merge' | 'legacy';
  detectedInChapter: number | null;
}

interface CharacterRow {
  id: string;
  name: string;
  voiceId: string | null;
  voice: { name: string } | null;
  role: 'main' | 'supporting' | 'minor' | 'crowd';
  aliases: string[];
  aliasDetails: AliasDetail[];
}

interface BibleSummary {
  pendingCount: number;
}

interface Props {
  bookId: string;
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

// ── Component ───────────────────────────────────────────────────────────────

export function CharacterMergeSplitPanel({ bookId }: Props) {
  const toast = useToast();

  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [bible, setBible] = useState<BibleSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetchAll = useCallback(async () => {
    setError(null);
    try {
      const [charsResp, bibleResp] = await Promise.all([
        fetch(`/api/library/${bookId}/characters`),
        fetch(`/api/library/${bookId}/characters/bible`).catch(() => null),
      ]);
      if (!charsResp.ok) {
        throw new Error(`Tải nhân vật thất bại (HTTP ${charsResp.status})`);
      }
      const charsBody = await charsResp.json() as { characters?: CharacterRow[] };
      setCharacters(charsBody.characters ?? []);
      if (bibleResp && bibleResp.ok) {
        const bibleBody = await bibleResp.json() as { pendingCount?: number };
        setBible({ pendingCount: bibleBody.pendingCount ?? 0 });
      } else {
        setBible({ pendingCount: 0 });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    refetchAll();
  }, [refetchAll]);

  const lowConfidenceCount = useMemo(
    () => characters.reduce(
      (sum, c) => sum + c.aliasDetails.filter((a) => a.confidence < LOW_CONFIDENCE_THRESHOLD).length,
      0,
    ),
    [characters],
  );
  const reviewCount = (bible?.pendingCount ?? 0) + lowConfidenceCount;

  return (
    <Card className="p-5 space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Nhân vật — Gộp / Tách</h2>
            {reviewCount > 0 && (
              <Badge variant="warning">{reviewCount} cần xem</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Hợp nhất hai nhân vật trùng lặp, tách một nhân vật thành hai, hoặc xem lại các biệt danh có độ tin cậy thấp.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refetchAll}
          disabled={loading}
          aria-label="Tải lại"
        >
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />
          Tải lại
        </Button>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <SkeletonRows />
      ) : characters.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">
          Chưa có nhân vật nào trong roster. Hãy chạy “Gán giọng tự động” trong tab Voice trước.
        </p>
      ) : (
        <Tabs defaultValue="merge">
          <TabsList>
            <TabsTrigger value="merge">
              <GitMerge className="h-3.5 w-3.5 mr-1.5" /> Gộp
            </TabsTrigger>
            <TabsTrigger value="split">
              <GitBranch className="h-3.5 w-3.5 mr-1.5" /> Tách
            </TabsTrigger>
            <TabsTrigger value="aliases">
              <Tag className="h-3.5 w-3.5 mr-1.5" /> Aliases
              {lowConfidenceCount > 0 && (
                <Badge variant="warning" className="ml-2">{lowConfidenceCount}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="merge">
            <MergeTab
              bookId={bookId}
              characters={characters}
              onMerged={refetchAll}
              onToast={(kind, msg) => {
                if (kind === 'success') toast.success(msg);
                else toast.error(msg);
              }}
            />
          </TabsContent>

          <TabsContent value="split">
            <SplitTab
              bookId={bookId}
              characters={characters}
              onSplit={refetchAll}
              onToast={(kind, msg) => {
                if (kind === 'success') toast.success(msg);
                else toast.error(msg);
              }}
            />
          </TabsContent>

          <TabsContent value="aliases">
            <AliasesTab
              bookId={bookId}
              characters={characters}
              onChanged={refetchAll}
              onToast={(kind, msg) => {
                if (kind === 'success') toast.success(msg);
                else toast.error(msg);
              }}
            />
          </TabsContent>
        </Tabs>
      )}
    </Card>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-10 w-full rounded-md bg-muted/40 animate-pulse"
          aria-hidden
        />
      ))}
    </div>
  );
}

// ── Merge tab ───────────────────────────────────────────────────────────────

interface MergeTabProps {
  bookId: string;
  characters: CharacterRow[];
  onMerged: () => Promise<void>;
  onToast: (kind: 'success' | 'error', msg: string) => void;
}

function MergeTab({ bookId, characters, onMerged, onToast }: MergeTabProps) {
  const [survivorId, setSurvivorId] = useState<string>('');
  const [absorbedId, setAbsorbedId] = useState<string>('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, 'survivor' | 'absorbed'>>({});

  const survivor = characters.find((c) => c.id === survivorId) ?? null;
  const absorbed = characters.find((c) => c.id === absorbedId) ?? null;

  const canMerge = !!survivor && !!absorbed && survivor.id !== absorbed.id;

  const submit = async () => {
    if (!canMerge) return;
    setRunning(true);
    try {
      const aliasResolutions = Object.entries(resolutions).map(([alias, keepOn]) => ({ alias, keepOn }));
      const r = await fetch(`/api/library/${bookId}/characters/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          survivorId: survivor!.id,
          absorbedId: absorbed!.id,
          aliasResolutions: aliasResolutions.length > 0 ? aliasResolutions : undefined,
        }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error ?? `HTTP ${r.status}`);
      }
      onToast('success', `Đã hợp nhất "${absorbed!.name}" vào "${survivor!.name}".`);
      setConfirmOpen(false);
      setSurvivorId('');
      setAbsorbedId('');
      setResolutions({});
      await onMerged();
    } catch (e) {
      onToast('error', `Hợp nhất thất bại: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Chọn hai nhân vật. Nhân vật <em>được giữ lại</em> sẽ hấp thụ biệt danh, lượt xuất hiện theo chương, và quan hệ của nhân vật <em>bị hấp thụ</em>. Nhân vật bị hấp thụ sẽ bị xoá.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <CharacterSelect
          label="Giữ lại"
          value={survivorId}
          onChange={setSurvivorId}
          characters={characters}
          excludeId={absorbedId}
        />
        <CharacterSelect
          label="Hấp thụ"
          value={absorbedId}
          onChange={setAbsorbedId}
          characters={characters}
          excludeId={survivorId}
        />
      </div>

      {canMerge && survivor && absorbed && (
        <div className="grid gap-3 sm:grid-cols-2 rounded-md border border-border bg-muted/20 p-3">
          <CharacterSummary c={survivor} label="Giữ lại" />
          <CharacterSummary c={absorbed} label="Bị hấp thụ" />
        </div>
      )}

      {canMerge && survivor && absorbed && absorbed.aliasDetails.length > 0 && (
        <div className="rounded-md border border-border p-3 space-y-2">
          <p className="text-xs font-medium">Quyết định cho biệt danh trùng lặp:</p>
          <div className="space-y-1">
            {absorbed.aliasDetails
              .filter((a) => survivor.aliasDetails.some((sa) => sa.alias === a.alias))
              .map((a) => {
                const survivorRow = survivor.aliasDetails.find((sa) => sa.alias === a.alias)!;
                const defaultKeep: 'survivor' | 'absorbed' =
                  survivorRow.confidence >= a.confidence ? 'survivor' : 'absorbed';
                const value = resolutions[a.alias] ?? defaultKeep;
                return (
                  <div key={a.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{a.alias}</span>
                      <ConfidenceBadge score={a.confidence} />
                      <span className="text-muted-foreground">vs</span>
                      <ConfidenceBadge score={survivorRow.confidence} />
                    </div>
                    <div className="flex items-center gap-1 text-xs">
                      <button
                        type="button"
                        onClick={() => setResolutions((r) => ({ ...r, [a.alias]: 'survivor' }))}
                        className={cn(
                          'rounded-md border px-2 py-0.5',
                          value === 'survivor' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
                        )}
                      >
                        {survivor.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => setResolutions((r) => ({ ...r, [a.alias]: 'absorbed' }))}
                        className={cn(
                          'rounded-md border px-2 py-0.5',
                          value === 'absorbed' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
                        )}
                      >
                        {absorbed.name}
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={!canMerge}
          size="sm"
        >
          <GitMerge className="h-3.5 w-3.5 mr-1.5" />
          Hợp nhất
        </Button>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Hợp nhất "${absorbed?.name ?? ''}" vào "${survivor?.name ?? ''}"?`}
        description="Hành động này không thể hoàn tác. Biệt danh, lượt xuất hiện và quan hệ sẽ được hợp nhất."
        widthClass="max-w-md"
      >
        <DialogBody>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>• {absorbed?.aliasDetails.length ?? 0} biệt danh sẽ được xử lý</li>
            <li>• Lượt xuất hiện theo chương sẽ được cộng dồn</li>
            <li>• Quan hệ sẽ được chuyển sang nhân vật được giữ lại</li>
            <li>• Nhân vật “{absorbed?.name ?? ''}” sẽ bị xoá</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={running}>
            Huỷ
          </Button>
          <Button onClick={submit} size="sm" disabled={running}>
            {running && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Xác nhận hợp nhất
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ── Split tab ───────────────────────────────────────────────────────────────

interface SplitTabProps {
  bookId: string;
  characters: CharacterRow[];
  onSplit: () => Promise<void>;
  onToast: (kind: 'success' | 'error', msg: string) => void;
}

const ROLE_OPTIONS: Array<{ value: CharacterRow['role']; label: string }> = [
  { value: 'main', label: 'Chính' },
  { value: 'supporting', label: 'Phụ' },
  { value: 'minor', label: 'Nhỏ' },
  { value: 'crowd', label: 'Đám đông' },
];

function SplitTab({ bookId, characters, onSplit, onToast }: SplitTabProps) {
  const [characterId, setCharacterId] = useState<string>('');
  const [aliasesToMove, setAliasesToMove] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState<string>('');
  const [newRole, setNewRole] = useState<CharacterRow['role']>('supporting');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const source = characters.find((c) => c.id === characterId) ?? null;
  const canSubmit = !!source && aliasesToMove.size > 0 && newName.trim().length > 0;

  const toggleAlias = (alias: string) => {
    setAliasesToMove((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  };

  const submit = async () => {
    if (!source) return;
    setRunning(true);
    try {
      const r = await fetch(`/api/library/${bookId}/characters/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characterId: source.id,
          aliasesToMove: [...aliasesToMove],
          newName: newName.trim(),
          newRole,
        }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error ?? `HTTP ${r.status}`);
      }
      onToast('success', `Đã tách "${newName.trim()}" ra khỏi "${source.name}".`);
      setConfirmOpen(false);
      setCharacterId('');
      setAliasesToMove(new Set());
      setNewName('');
      setNewRole('supporting');
      await onSplit();
    } catch (e) {
      onToast('error', `Tách thất bại: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Tách một tập con biệt danh ra khỏi một nhân vật hiện có thành một nhân vật mới. Lượt xuất hiện theo chương sẽ KHÔNG được chuyển — chỉ roster thay đổi.
      </p>

      <CharacterSelect
        label="Nhân vật cần tách"
        value={characterId}
        onChange={(v) => {
          setCharacterId(v);
          setAliasesToMove(new Set());
          setNewName('');
        }}
        characters={characters}
      />

      {source && (
        <div className="rounded-md border border-border p-3 space-y-2">
          <p className="text-xs font-medium">Biệt danh của “{source.name}”:</p>
          {source.aliasDetails.length === 0 ? (
            <p className="text-xs text-muted-foreground">Chưa có biệt danh nào.</p>
          ) : (
            <div className="space-y-1">
              {source.aliasDetails.map((a) => {
                const checked = aliasesToMove.has(a.alias);
                return (
                  <label
                    key={a.id}
                    className="flex items-center gap-2 text-xs cursor-pointer rounded-md p-1 hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAlias(a.alias)}
                      className="h-3.5 w-3.5"
                    />
                    <span className="font-mono">{a.alias}</span>
                    <ConfidenceBadge score={a.confidence} />
                    <span className="text-muted-foreground">({a.source})</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {source && aliasesToMove.size > 0 && (
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <div className="space-y-1">
            <label className="text-xs font-medium">Tên nhân vật mới</label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Ví dụ: ông nội (họ nội)"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Vai trò</label>
            <Select value={newRole} onValueChange={(v) => setNewRole(v as CharacterRow['role'])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={!canSubmit}
          size="sm"
        >
          <GitBranch className="h-3.5 w-3.5 mr-1.5" />
          Tách
        </Button>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Tách "${newName.trim() || '...'}" ra khỏi "${source?.name ?? ''}"?`}
        description={`${aliasesToMove.size} biệt danh sẽ được chuyển sang nhân vật mới. Lượt xuất hiện theo chương sẽ không được chuyển.`}
        widthClass="max-w-md"
      >
        <DialogBody>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {[...(aliasesToMove)].map((a) => (
              <li key={a}>• {a}</li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={running}>
            Huỷ
          </Button>
          <Button onClick={submit} size="sm" disabled={running}>
            {running && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Xác nhận tách
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ── Aliases tab ─────────────────────────────────────────────────────────────

interface AliasesTabProps {
  bookId: string;
  characters: CharacterRow[];
  onChanged: () => Promise<void>;
  onToast: (kind: 'success' | 'error', msg: string) => void;
}

function AliasesTab({ bookId, characters, onChanged, onToast }: AliasesTabProps) {
  const [markingId, setMarkingId] = useState<string | null>(null);

  const markAsWrong = async (characterId: string, aliasId: string, alias: string) => {
    setMarkingId(aliasId);
    try {
      const r = await fetch(`/api/library/${bookId}/characters/${characterId}/aliases/${aliasId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confidence: 0, source: 'user' }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error ?? `HTTP ${r.status}`);
      }
      onToast('success', `Đã đánh dấu "${alias}" là sai.`);
      await onChanged();
    } catch (e) {
      onToast('error', `Cập nhật thất bại: ${String(e)}`);
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Xem tất cả biệt danh của từng nhân vật. Đánh dấu sai sẽ đặt độ tin cậy về 0 — dùng để loại bỏ các alias mà detector gộp nhầm.
      </p>
      <div className="space-y-2">
        {characters.map((c) => (
          <details key={c.id} className="rounded-md border border-border bg-muted/10">
            <summary className="flex items-center justify-between cursor-pointer px-3 py-2 text-xs font-medium">
              <span className="flex items-center gap-2">
                <span>{c.name}</span>
                <span className="text-muted-foreground">({c.role})</span>
                {c.aliasDetails.filter((a) => a.confidence < LOW_CONFIDENCE_THRESHOLD).length > 0 && (
                  <Badge variant="warning">
                    {c.aliasDetails.filter((a) => a.confidence < LOW_CONFIDENCE_THRESHOLD).length} thấp
                  </Badge>
                )}
              </span>
              <span className="text-muted-foreground">{c.aliasDetails.length} biệt danh</span>
            </summary>
            <div className="px-3 pb-3 space-y-1">
              {c.aliasDetails.length === 0 ? (
                <p className="text-xs text-muted-foreground">Chưa có biệt danh.</p>
              ) : (
                c.aliasDetails.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{a.alias}</span>
                      <ConfidenceBadge score={a.confidence} />
                      <span className="text-muted-foreground text-[10px]">({a.source})</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => markAsWrong(c.id, a.id, a.alias)}
                      disabled={markingId === a.id}
                      className="h-6 px-2 text-[10px]"
                    >
                      {markingId === a.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        'Đánh dấu sai'
                      )}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

// ── Shared building blocks ──────────────────────────────────────────────────

interface CharacterSelectProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  characters: CharacterRow[];
  excludeId?: string;
}

function CharacterSelect({ label, value, onChange, characters, excludeId }: CharacterSelectProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Chọn nhân vật" />
        </SelectTrigger>
        <SelectContent>
          {characters
            .filter((c) => c.id !== excludeId)
            .map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name} ({c.aliasDetails.length} alias)
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CharacterSummary({ c, label }: { c: CharacterRow; label: string }) {
  return (
    <div className="rounded-md bg-background p-2 text-xs space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{label}: {c.name}</span>
        <span className="text-muted-foreground">{c.role}</span>
      </div>
      <div className="text-muted-foreground">
        Voice: {c.voice?.name ?? '(mặc định)'}
      </div>
      <div className="text-muted-foreground">
        {c.aliasDetails.length} biệt danh
      </div>
    </div>
  );
}

function ConfidenceBadge({ score }: { score: number }) {
  const variant =
    score >= HIGH_CONFIDENCE_THRESHOLD ? 'success' :
    score >= LOW_CONFIDENCE_THRESHOLD ? 'warning' :
    'destructive';
  return (
    <Badge variant={variant} className="text-[10px]">
      {score.toFixed(2)}
    </Badge>
  );
}
