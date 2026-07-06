// src/app/settings/page.tsx
// App-wide settings — AI provider, TTS provider, default options.
// Persisted to the Settings DB row; read by every AI endpoint at call time.
//
// Layout (UI Polish §5.5): the 5 stacked <section> cards became a Radix
// <Tabs> layout. State, save/load, and provider-default logic stay in a
// single parent component so the Save button writes every field together.
// Sub-components are stateless wrappers around `settings` + `update()`.
'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Settings as SettingsIcon, Cpu, KeyRound, Sparkles, Volume2,
  Eye, EyeOff, Loader2, Save, Check, AlertCircle, RefreshCw,
  Mic, Languages, Wand2, ShieldOff, ExternalLink,
  Cloud, Server, Wrench, Trash2, Image as ImageIcon, Zap, Activity,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/utils';
import { ServiceHealth } from '@/components/status/ServiceHealth';

interface Settings {
  id: string;
  aiProvider: string;
  aiApiKey: string | null;
  aiBaseUrl: string | null;
  aiModel: string;
  aiMaxTokens: number;
  aiTemperature: number;
  ttsProvider: string;
  defaultAiEnhance: boolean;
  defaultAiWatermarkClean: boolean;
  defaultDeepFormat: boolean;
  defaultLanguage: string;
  theme: string;
  updatedAt: string;
  aiApiKeyMasked: string | null;
  // Image generation
  imageProvider: string;
  imageApiKey: string | null;
  imageBaseUrl: string | null;
  imageModel: string;
  imageStyle: string;
  imageMaxPerBook: number;
  imageApiKeyMasked: string | null;
  // Worker performance tuning
  workerConcurrency: number;
  workerChapterConcurrency: number;
}

const AI_PROVIDERS = [
  { id: 'omlx-local',    label: 'OMLX (local)',     desc: 'Local Qwen/DeepSeek — không cần API key, chạy trên máy. Để nhanh chọn model 4-bit (FastContext-1B hoặc Qwen3.5-9B-4bit).', Icon: Server, needsKey: false, defaultModel: 'FastContext-1.0-4B-SFT-Dynamic-4bit-MLX', defaultUrl: '', defaultMaxTokens: 8192 },
  { id: 'minimax-cloud', label: 'MiniMax Cloud',    desc: 'MiniMax Text-01 / Image-01 — cloud nhanh, cần API key',     Icon: Cloud,   needsKey: true,  defaultModel: 'MiniMax-Text-01', defaultUrl: 'https://api.minimax.io/v1', defaultMaxTokens: 16384 },
  { id: 'openai',        label: 'OpenAI',           desc: 'GPT-4o / GPT-4 / o1 — chất lượng cao, cần OpenAI key',         Icon: Sparkles, needsKey: true,  defaultModel: 'gpt-4o-mini',  defaultUrl: 'https://api.openai.com/v1', defaultMaxTokens: 16384 },
  { id: 'custom',        label: 'Custom (OpenAI-compatible)', desc: 'Together / Anyscale / llama.cpp / bất kỳ endpoint nào', Icon: Wrench,  needsKey: true,  defaultModel: '',             defaultUrl: '',                   defaultMaxTokens: 8192  },
];

// 2026-07-05: only Vietnamese Voice runs locally — Piper + MOSS-Nano removed.
// Kept as a single-entry list so the existing UI / `ttsProvider` setting
// keep working without a schema migration.
const TTS_PROVIDERS = [
  { id: 'vieneu',   label: 'Vietnamese Voice', desc: 'Vietnamese-native, 10 giọng built-in, voice cloning' },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; ms?: number; response?: string; error?: string } | null>(null);
  // Available models fetched from the provider
  const [textModels, setTextModels] = useState<string[]>([]);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState<'text' | 'image' | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const fetchModels = useCallback(async (kind: 'text' | 'image') => {
    setModelsLoading(kind);
    setModelsError(null);
    try {
      const r = await fetch(`/api/settings/models?for=${kind}`);
      const data = await r.json();
      if (!r.ok) {
        setModelsError(data.error ?? `HTTP ${r.status}`);
        if (kind === 'text') setTextModels([]);
        else setImageModels([]);
        return;
      }
      const list: string[] = data.models ?? [];
      if (kind === 'text') setTextModels(list);
      else setImageModels(list);
      if (list.length === 0) setModelsError('Provider trả về danh sách rỗng');
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setModelsLoading(null);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const s = await fetch('/api/settings').then((r) => r.json());
      setSettings(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchSettings(); }, [fetchSettings]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setTestResult(null);
    try {
      // Only send aiApiKey if the user actually typed a new value.
      // Sending the masked display value (bullet chars) would corrupt the key.
      // BUGFIX 2026-07-05: previously the save handler posted `aiApiKey: ''`
      // whenever the input was empty. After the first successful save the
      // input renders empty (because the masked response sets aiApiKey to
      // null), so re-saving any other field — base URL, model, anything —
      // silently WIPED the saved key. Now we only send `''` when there is
      // no previously-saved key to preserve; otherwise we omit the field
      // entirely and the server leaves the existing key untouched.
      const apiKeyInput = settings.aiApiKey ?? '';
      const hasSavedAiKey = !!settings.aiApiKeyMasked;
      const body: Record<string, unknown> = {
        aiProvider: settings.aiProvider,
        aiBaseUrl: settings.aiBaseUrl,
        aiModel: settings.aiModel,
        aiMaxTokens: settings.aiMaxTokens,
        aiTemperature: settings.aiTemperature,
        ttsProvider: settings.ttsProvider,
        defaultAiEnhance: settings.defaultAiEnhance,
        defaultAiWatermarkClean: settings.defaultAiWatermarkClean,
        defaultDeepFormat: settings.defaultDeepFormat,
        defaultLanguage: settings.defaultLanguage,
        theme: settings.theme,
        imageProvider: settings.imageProvider,
        workerConcurrency: settings.workerConcurrency,
        workerChapterConcurrency: settings.workerChapterConcurrency,
        imageBaseUrl: settings.imageBaseUrl,
        imageModel: settings.imageModel,
        imageStyle: settings.imageStyle,
        imageMaxPerBook: settings.imageMaxPerBook,
      };
      // Detect "masked value" pattern (e.g. "••••••••last4") and treat as "no change"
      const isMaskedPattern = apiKeyInput.includes('•');
      if (apiKeyInput && !isMaskedPattern) {
        body.aiApiKey = apiKeyInput;          // user typed a fresh key
      } else if (apiKeyInput === '' && !hasSavedAiKey) {
        body.aiApiKey = '';                   // explicit clear (no key was previously saved)
      }
      // Else: input is empty AND a key is already saved → omit the field
      // entirely so the server's whitelist keeps the existing key.
      // (Same for the masked-pattern edge case — the page should never
      // produce bullet chars via onChange, but if it did, omitting is safe.)

      // Same logic for imageApiKey (separate from text AI key)
      const imgKeyInput = settings.imageApiKey ?? '';
      const hasSavedImgKey = !!settings.imageApiKeyMasked;
      const isImgMasked = imgKeyInput.includes('•');
      if (imgKeyInput && !isImgMasked) {
        body.imageApiKey = imgKeyInput;
      } else if (imgKeyInput === '' && !hasSavedImgKey) {
        body.imageApiKey = '';
      }
      // Else: input empty + saved key present → omit to preserve.

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const updated = await res.json();
      setSettings(updated);
      setSavedAt(new Date());
      // Auto-refresh the available models list with the new API key
      void fetchModels('text');
      if (updated.imageProvider && updated.imageProvider !== 'none') {
        void fetchModels('image');
      }
    } finally {
      setSaving(false);
    }
  };

  const testAI = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/test-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Reply with the single word: pong' }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
    setSavedAt(null);
  };

  const pickProviderDefaults = (providerId: string) => {
    const p = AI_PROVIDERS.find((x) => x.id === providerId);
    if (!p || !settings) return;
    setSettings({
      ...settings,
      aiProvider: providerId,
      aiModel: p.defaultModel,
      aiBaseUrl: settings.aiBaseUrl ?? p.defaultUrl,
      aiMaxTokens: p.defaultMaxTokens,
    });
    // Clear stale model list / error from the previous provider
    setTextModels([]);
    setImageModels([]);
    setModelsError(null);
    setSavedAt(null);
  };

  if (loading || !settings) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <PageHeader eyebrow="Cài đặt" title="Đang tải…" icon={<SettingsIcon className="h-4 w-4" />} />
        <div className="space-y-2">{Array.from({length: 4}).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}</div>
      </div>
    );
  }

  const aiProvider = AI_PROVIDERS.find((p) => p.id === settings.aiProvider) ?? AI_PROVIDERS[0];
  const ttsProvider = TTS_PROVIDERS.find((p) => p.id === settings.ttsProvider) ?? TTS_PROVIDERS[0];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Cài đặt' }]}
        title="Cài đặt"
        description="Chọn AI provider, cấu hình TTS, và tuỳ chỉnh các tuỳ chọn mặc định. Tất cả thay đổi có hiệu lực ngay lập tức."
        icon={<SettingsIcon className="h-4 w-4" />}
        actions={
          <>
            {savedAt && (
              <span className="text-[10px] text-green-600 dark:text-green-400 flex items-center gap-1">
                <Check className="h-3 w-3" /> Đã lưu {savedAt.toLocaleTimeString()}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={fetchSettings} title="Tải lại">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Lưu
            </Button>
          </>
        }
      />

      <Tabs defaultValue="ai">
        <TabsList className="w-full overflow-x-auto flex-nowrap sm:flex-wrap justify-start sm:justify-center">
          <TabsTrigger value="ai" className="gap-1.5">
            <Cpu className="h-3.5 w-3.5" /> AI Provider
          </TabsTrigger>
          <TabsTrigger value="tts" className="gap-1.5">
            <Volume2 className="h-3.5 w-3.5" /> TTS
          </TabsTrigger>
          <TabsTrigger value="conversion" className="gap-1.5">
            <Wand2 className="h-3.5 w-3.5" /> Conversion
          </TabsTrigger>
          <TabsTrigger value="image" className="gap-1.5">
            <ImageIcon className="h-3.5 w-3.5" /> Image generation
          </TabsTrigger>
        </TabsList>

        {/* ── AI Provider tab ─────────────────────────────────────────────── */}
        <TabsContent value="ai" className="space-y-4 outline-none">
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Cpu className="h-4 w-4 text-primary" /> AI Provider
              </h2>
              <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider',
                settings.aiProvider === 'omlx-local' ? 'bg-green-500/15 text-green-700 dark:text-green-400' :
                settings.aiProvider === 'minimax-cloud' ? 'bg-purple-500/15 text-purple-700 dark:text-purple-400' :
                settings.aiProvider === 'openai' ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400' :
                'bg-muted text-muted-foreground',
              )}>
                Đang dùng: {aiProvider.label}
              </span>
            </div>

            {/* Provider cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {AI_PROVIDERS.map((p) => {
                const Icon = p.Icon;
                const selected = settings.aiProvider === p.id;
                return (
                  <button key={p.id} onClick={() => pickProviderDefaults(p.id)}
                    className={cn('text-left rounded-lg border border-border p-3 transition-all',
                      selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/30',
                    )}>
                    <div className="flex items-start gap-2.5">
                      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                        selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                      )}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-semibold">{p.label}</p>
                          {selected && <Check className="h-3 w-3 text-primary" />}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{p.desc}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Provider-specific config */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border">
              <div className="space-y-1.5 sm:col-span-2">
                <label className="text-xs font-medium flex items-center gap-1.5">
                  <KeyRound className="h-3 w-3" />
                  API Key {aiProvider.needsKey && <span className="text-destructive">*</span>}
                </label>
                <div className="flex gap-2">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    value={settings.aiApiKey ?? ''}
                    onChange={(e) => update('aiApiKey', e.target.value)}
                    placeholder={
                      aiProvider.needsKey
                        ? (settings.aiApiKeyMasked
                            ? `Hiện đã lưu: ${settings.aiApiKeyMasked} — nhập key mới để thay`
                            : 'sk-...')
                        : '(không cần cho provider này)'
                    }
                    disabled={!aiProvider.needsKey}
                    className="flex-1 font-mono"
                  />
                  {aiProvider.needsKey && settings.aiApiKeyMasked && (
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() => { update('aiApiKey', ''); }}
                      title="Xoá key hiện tại"
                      className="text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {aiProvider.needsKey && (
                    <Button size="sm" variant="ghost" onClick={() => setShowKey((v) => !v)} title={showKey ? 'Ẩn key' : 'Hiện key'}>
                      {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                </div>
                {settings.aiApiKeyMasked && (
                  <div
                    data-testid="api-key-saved-badge"
                    className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
                  >
                    <Check className="h-3 w-3" />
                    <span>
                      Key đã lưu (<span className="font-mono">{settings.aiApiKeyMasked}</span>) — để trống + Save sẽ giữ nguyên
                    </span>
                  </div>
                )}
              </div>

              <ModelField
                label="Model"
                models={textModels}
                current={settings.aiModel}
                loading={modelsLoading === 'text'}
                omlxHint={settings.aiProvider === 'omlx-local'}
                onChange={(v) => update('aiModel', v)}
                onRefresh={() => fetchModels('text')}
                onPickFast={() => {
                  const fast = textModels.find((m) => m.includes('1B') || m.includes('FastContext'))
                    ?? textModels.find((m) => m.includes('4bit'))
                    ?? textModels[0];
                  if (fast) update('aiModel', fast);
                }}
                placeholder={
                  settings.aiProvider === 'omlx-local'
                    ? (textModels.length ? '' : 'Bấm "Lấy danh sách" để lấy model từ OMLX')
                    : 'vd: gpt-4o-mini, MiniMax-Text-01, qwen2.5-7b'
                }
                helpText={
                  settings.aiProvider === 'omlx-local' ? (
                    <>Model OMLX local lấy từ biến môi trường <span className="font-mono">OMLX_MODEL</span> trên server. Mặc định: <span className="font-mono">default</span>.</>
                  ) : undefined
                }
              />
              {modelsError && textModels.length === 0 && settings.aiProvider !== 'omlx-local' && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 sm:col-span-2">{modelsError}</p>
              )}

              {(settings.aiProvider === 'custom' || settings.aiBaseUrl) && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium flex items-center gap-1.5">
                    Base URL
                    <a href="https://platform.openai.com/docs/api-reference" target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </label>
                  <Input type="text" value={settings.aiBaseUrl ?? ''}
                    onChange={(e) => update('aiBaseUrl', e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="font-mono"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium">Max tokens</label>
                <Input type="number" min={64} max={32000} step={64} value={settings.aiMaxTokens}
                  onChange={(e) => update('aiMaxTokens', parseInt(e.target.value, 10) || 4096)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  Temperature <span className="font-mono text-muted-foreground">{settings.aiTemperature.toFixed(2)}</span>
                </label>
                <input type="range" min={0} max={2} step={0.05} value={settings.aiTemperature}
                  onChange={(e) => update('aiTemperature', parseFloat(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>

            {/* Test button */}
            <div className="flex flex-col gap-2 pt-2 border-t border-border">
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={testAI} disabled={testing}>
                  {testing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
                  Test connection
                </Button>
                {testResult?.ok && (
                  <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                    <Check className="h-3 w-3" /> OK ({testResult.ms}ms): "{testResult.response}"
                  </span>
                )}
              </div>
              {testResult && !testResult.ok && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs space-y-1">
                  <div className="flex items-start gap-1.5 text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold">{testResult.error}</p>
                      {(testResult.error?.includes('401') || testResult.error?.toLowerCase().includes('api key') || testResult.error?.toLowerCase().includes('authorized')) && (
                        <div className="mt-1.5 text-[10px] text-muted-foreground space-y-0.5">
                          <p>→ API key bị MiniMax từ chối. Vui lòng kiểm tra:</p>
                          <ul className="list-disc list-inside pl-2 space-y-0.5">
                            <li>Key đã được tạo trong dashboard MiniMax và copy đầy đủ</li>
                            <li>Key có quyền truy cập model bạn đã chọn</li>
                            <li>Tên model chính xác — MiniMax dùng <span className="font-mono text-foreground">MiniMax-Text-01</span>, không phải &quot;MiniMax-M3&quot;</li>
                            <li>Tài khoản MiniMax còn hạn ngạch / chưa bị suspend</li>
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </TabsContent>

        {/* ── TTS tab ─────────────────────────────────────────────────────── */}
        <TabsContent value="tts" className="space-y-4 outline-none">
          <Card className="p-5 space-y-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-primary" /> TTS Provider
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {TTS_PROVIDERS.map((p) => {
                const selected = settings.ttsProvider === p.id;
                return (
                  <button key={p.id} onClick={() => update('ttsProvider', p.id)}
                    className={cn('text-left rounded-lg border border-border p-3 transition-all',
                      selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/30',
                    )}>
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-semibold">{p.label}</p>
                      {selected && <Check className="h-3 w-3 text-primary" />}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">{p.desc}</p>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Đang dùng: <span className="font-semibold text-primary">{ttsProvider.label}</span>.
              Tất cả audiobook / read-aloud sẽ dùng provider này.
            </p>
            <ServiceHealth variant="panel" />
          </Card>
        </TabsContent>

        {/* ── Conversion tab (worker performance + conversion defaults) ── */}
        <TabsContent value="conversion" className="space-y-4 outline-none">
          <Card className="p-5 space-y-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" /> Worker performance
              <span className="text-[10px] text-muted-foreground font-normal">
                (restart worker to apply)
              </span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">Max parallel jobs</label>
                  <span className="text-xs font-mono text-muted-foreground">{settings.workerConcurrency}</span>
                </div>
                <input type="range" min={1} max={8} step={1}
                  value={settings.workerConcurrency}
                  onChange={(e) => update('workerConcurrency', parseInt(e.target.value, 10) || 2)}
                  className="w-full" />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>1 (chậm)</span><span>4 (cân bằng)</span><span>8 (nhanh)</span>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Số conversion chạy đồng thời. Tăng để tận dụng AI provider nhanh (FastContext, MiniMax), giảm cho máy yếu.
                </p>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">Chapter concurrency (per job)</label>
                  <span className="text-xs font-mono text-muted-foreground">{settings.workerChapterConcurrency}</span>
                </div>
                <input type="range" min={1} max={8} step={1}
                  value={settings.workerChapterConcurrency}
                  onChange={(e) => update('workerChapterConcurrency', parseInt(e.target.value, 10) || 1)}
                  className="w-full" />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>1 (an toàn)</span><span>4</span><span>8 (nhanh)</span>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Trong 1 conversion, deep-format nhiều chương đồng thời. Tăng để giảm thời gian, nhưng tốn nhiều API call hơn.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-primary" /> Conversion defaults
            </h2>
            <div className="space-y-2">
              <ToggleRow
                icon={<Sparkles className="h-4 w-4" />}
                label="AI enhance (auto-repair HTML)"
                description="Bật LLM sửa HTML lỗi khi convert. Tốn thêm ~10-30s nhưng chất lượng cao hơn nhiều."
                checked={settings.defaultAiEnhance}
                onChange={(v) => update('defaultAiEnhance', v)}
              />
              <ToggleRow
                icon={<ShieldOff className="h-4 w-4" />}
                label="AI watermark cleaning"
                description="Tự động phát hiện & loại bỏ quảng cáo / watermark cuối chương."
                checked={settings.defaultAiWatermarkClean}
                onChange={(v) => update('defaultAiWatermarkClean', v)}
              />
            </div>

            <div className="space-y-1.5 pt-2 border-t border-border">
              <label className="text-xs font-medium flex items-center gap-1.5">
                <Languages className="h-3 w-3" />
                Ngôn ngữ mặc định cho EPUB mới
              </label>
              <Select value={settings.defaultLanguage} onValueChange={(v) => update('defaultLanguage', v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vi">Tiếng Việt</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="mixed">Hỗn hợp</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Card>
        </TabsContent>

        {/* ── Image generation tab ────────────────────────────────────────── */}
        <TabsContent value="image" className="space-y-4 outline-none">
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-primary" /> Image generation
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium uppercase tracking-wider">
                  BETA
                </span>
              </h2>
              <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider',
                settings.imageProvider === 'none' ? 'bg-muted text-muted-foreground' :
                settings.imageProvider === 'minimax' ? 'bg-purple-500/15 text-purple-700 dark:text-purple-400' :
                settings.imageProvider === 'openai' ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400' :
                'bg-amber-500/15 text-amber-700 dark:text-amber-400',
              )}>
                {settings.imageProvider === 'none' ? 'Tắt' : settings.imageProvider}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground -mt-2">
              AI generates black-and-white illustrations for "highlight" chapters of novels.
              Output style adapts to the story (e.g. ink-wash for tu tiểu thuyết, manga for modern web novels).
            </p>

            {/* Provider cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['none', 'openai', 'minimax', 'custom'] as const).map((p) => (
                <button key={p} onClick={() => update('imageProvider', p)}
                  className={cn('rounded-lg border border-border p-2.5 text-left transition-all text-xs',
                    settings.imageProvider === p
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'hover:bg-muted/30',
                  )}>
                  <p className="font-semibold capitalize">{p === 'none' ? 'Disabled' : p}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {p === 'none' ? 'Không sinh ảnh' :
                     p === 'openai' ? 'DALL-E 3 (cần key)' :
                     p === 'minimax' ? 'MiniMax image API' :
                     'Custom OpenAI-compatible'}
                  </p>
                </button>
              ))}
            </div>

            {settings.imageProvider !== 'none' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium flex items-center gap-1.5">
                      <KeyRound className="h-3 w-3" />
                      Image API Key
                    </label>
                    <Input
                      type="password"
                      value={settings.imageApiKey ?? ''}
                      onChange={(e) => update('imageApiKey', e.target.value)}
                      placeholder={settings.imageApiKeyMasked ? `Hiện: ${settings.imageApiKeyMasked}` : 'sk-...'}
                      className="font-mono"
                    />
                  </div>

                  <ModelField
                    label="Model"
                    models={imageModels}
                    current={settings.imageModel}
                    loading={modelsLoading === 'image'}
                    omlxHint={false}
                    onChange={(v) => update('imageModel', v)}
                    onRefresh={() => fetchModels('image')}
                    onPickFast={() => {/* image models have no "fastest" heuristic */}}
                    placeholder={
                      settings.imageProvider === 'minimax' ? 'image-01' :
                      settings.imageProvider === 'openai' ? 'dall-e-3' :
                      'image-01, dall-e-3, ...'
                    }
                  />

                  {(settings.imageProvider === 'custom' || settings.imageBaseUrl) && (
                    <div className="space-y-1.5 sm:col-span-2">
                      <label className="text-xs font-medium">Base URL</label>
                      <Input type="text" value={settings.imageBaseUrl ?? ''}
                        onChange={(e) => update('imageBaseUrl', e.target.value)}
                        placeholder="https://api.example.com/v1"
                        className="font-mono"
                      />
                      <p className="text-[10px] text-muted-foreground">
                        Để trống sẽ dùng default của provider:{' '}
                        <span className="font-mono">
                          {settings.imageProvider === 'openai'  ? 'https://api.openai.com/v1' :
                           settings.imageProvider === 'minimax' ? 'https://api.minimax.io/v1' :
                           'bắt buộc cho Custom'}
                        </span>
                      </p>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Art style</label>
                    <Select value={settings.imageStyle} onValueChange={(v) => update('imageStyle', v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ink">Ink wash (水墨画) — epic / tu tiểu thuyết</SelectItem>
                        <SelectItem value="manga">Manga / manhua — web novel</SelectItem>
                        <SelectItem value="sketch">Pencil sketch — literary</SelectItem>
                        <SelectItem value="watercolor">Watercolor — romance / slice-of-life</SelectItem>
                        <SelectItem value="none">Provider default (no style guide)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Max illustrations per book</label>
                    <Input type="number" min={0} max={50} value={settings.imageMaxPerBook}
                      onChange={(e) => update('imageMaxPerBook', parseInt(e.target.value, 10) || 0)}
                    />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  AI sẽ phân tích từng chương, chỉ chọn những chương có cảnh đáng kể (giai đoạn quan trọng, đấu pháp, gặp gỡ nhân vật, v.v.) và tạo ảnh cho tối đa số chương trên.
                </p>
              </>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      <footer className="text-center text-[10px] text-muted-foreground pt-4 border-t border-border">
        Cài đặt lưu trong database. Áp dụng cho tất cả AI requests và conversion jobs.
      </footer>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * ModelField — shared input that switches between <Select> (when the
 * provider returned a list of models) and a free-text <Input> (when the
 * user types their own). Consolidates ~60 lines of duplicated markup.
 * ──────────────────────────────────────────────────────────────────────── */
function ModelField({
  label, models, current, loading, omlxHint,
  onChange, onRefresh, onPickFast,
  placeholder, helpText,
}: {
  label: string;
  models: string[];
  current: string;
  loading: boolean;
  omlxHint: boolean;
  onChange: (v: string) => void;
  onRefresh: () => void;
  onPickFast?: () => void;
  placeholder: string;
  helpText?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium">{label}</label>
        <div className="flex items-center gap-1">
          {omlxHint && models.length > 0 && onPickFast && (
            <button
              type="button"
              onClick={onPickFast}
              className="text-[10px] text-primary hover:underline flex items-center gap-1"
              title="Chọn model nhanh nhất (4-bit)">
              <Zap className="h-3 w-3" />Nhanh nhất
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
            title="Lấy danh sách model từ provider hiện tại (dùng OMLX_API_KEY env nếu OMLX)">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {loading ? 'Đang tải…' : (models.length ? 'Làm mới' : 'Lấy danh sách')}
          </button>
        </div>
      </div>
      {models.length > 0 ? (
        // Radix Select reserves "" for "clear selection / placeholder", so coerce
        // an empty stored model to the same sentinel rather than passing value="".
        <Select value={current || '_placeholder'} onValueChange={(v) => onChange(v === '_placeholder' ? '' : v)}>
          <SelectTrigger className="w-full font-mono">
            <SelectValue placeholder="Chọn model" />
          </SelectTrigger>
          <SelectContent>
            {!models.includes(current) && current && (
              <SelectItem value={current}>{current} (hiện tại)</SelectItem>
            )}
            {models.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input type="text" value={current}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="font-mono"
        />
      )}
      {helpText && <p className="text-[10px] text-muted-foreground">{helpText}</p>}
    </div>
  );
}

function ToggleRow({
  icon, label, description, checked, onChange,
}: { icon: React.ReactNode; label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked); }
      }}
      className={cn('w-full flex items-start gap-3 rounded-lg border border-border p-3 text-left transition-all cursor-pointer',
        checked ? 'bg-primary/5 ring-1 ring-primary/40 border-primary/20' : 'hover:bg-muted/30',
      )}>
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        checked ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        label={label}
        className="mt-0.5"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}