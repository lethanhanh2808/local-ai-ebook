// src/app/settings/page.tsx
// App-wide settings — AI provider, TTS provider, default options.
// Persisted to the Settings DB row; read by every AI endpoint at call time.
//
// Layout (UI Polish §5.5): the 5 stacked <section> cards became a Radix
// <Tabs> layout. State, save/load, and provider-default logic stay in a
// single parent component so the Save button writes every field together.
// Sub-components are stateless wrappers around `settings` + `update()`.
'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import {
  Settings as SettingsIcon, Cpu, KeyRound, Sparkles, Volume2,
  Eye, EyeOff, Loader2, Save, Check, AlertCircle, RefreshCw,
  Mic, Languages, Wand2, ShieldOff, ExternalLink,
  Cloud, Server, Wrench, Trash2, Image as ImageIcon, Zap, Activity, Smartphone,
  Plus, Database, Bookmark, Palette, Monitor, Sun, Moon, BookOpen,
  Brain, Download, Users, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/utils';
import { ServiceHealth } from '@/components/status/ServiceHealth';
import { CalibrePanel } from '@/components/status/CalibrePanel';
import { ErrorState } from '@/components/layout/ErrorState';
import { useToast } from '@/components/ui/toast';
import { useTheme, type ThemeMode } from '@/components/theme/ThemeProvider';
import { TTS_PROVIDERS } from '@/lib/settings/tts-providers';
import Link from 'next/link';

interface Settings {
  id: string;
  aiProvider: string;
  aiApiKey: string | null;
  aiBaseUrl: string | null;
  aiAllowInsecureTls: boolean;
  aiModel: string;
  aiMaxTokens: number;
  aiTemperature: number;
  // Per-mode enable_thinking override for the chapter-attribution analyzer
  // (2026-07-12). Surface as two toggles in the AI section.
  aiThinkingCombine: boolean;
  aiThinkingFullLLM: boolean;
  ttsProvider: string;
  defaultAiEnhance: boolean;
  defaultAiWatermarkClean: boolean;
  defaultDeepFormat: boolean;
  defaultReaderFriendly: boolean;
  defaultLanguage: string;
  theme: string;
  updatedAt: string;
  aiApiKeyMasked: string | null;
  scope?: 'app' | 'session' | 'user';
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
  // Live AI-enhancement chapter concurrency (no restart needed)
  aiEnhanceConcurrency: number;
}

interface WatermarkRow {
  id: string;
  phrase: string;
  source: 'auto' | 'user' | 'imported';
  hitCount: number;
  lastSeenAt: string;
  firstSeenAt: string;
}

const AI_PROVIDERS = [
  { id: 'omlx-local',    label: 'OMLX (local)',     desc: 'Local Qwen/DeepSeek — không cần API key, chạy trên máy. Để nhanh chọn model 4-bit (Ornith-9B-4bit hoặc Qwen3.5-9B-4bit).', Icon: Server, needsKey: false, defaultModel: 'Ornith-1.0-9B-mlx-4Bit', defaultUrl: '', defaultMaxTokens: 16384 },
  { id: 'minimax-cloud', label: 'MiniMax Cloud',    desc: 'MiniMax Text-01 / Image-01 — cloud nhanh, cần API key',     Icon: Cloud,   needsKey: true,  defaultModel: 'MiniMax-Text-01', defaultUrl: 'https://api.minimax.io/v1', defaultMaxTokens: 16384 },
  { id: 'openai',        label: 'OpenAI',           desc: 'GPT-4o / GPT-4 / o1 — chất lượng cao, cần OpenAI key',         Icon: Sparkles, needsKey: true,  defaultModel: 'gpt-4o-mini',  defaultUrl: 'https://api.openai.com/v1', defaultMaxTokens: 16384 },
  { id: 'custom',        label: 'Custom (OpenAI-compatible)', desc: 'Together / Anyscale / llama.cpp / bất kỳ endpoint nào', Icon: Wrench,  needsKey: true,  defaultModel: 'default',       defaultUrl: 'https://api.example.com/v1', defaultMaxTokens: 8192  },
];

// Keep the GUI and DB registry aligned with the canonical provider defaults.
// These values are intentionally mirrored from the backend default registry so
// the Settings page stays consistent with the single source of truth in
// src/lib/db/settings.ts without hard-coded drift.
//
// TTS_PROVIDERS is imported from src/lib/settings/tts-providers.ts (single
// source of truth) so adding an engine only requires editing the registry
// there — this page renders whatever that array contains.
// 2026-08-30: split out of src/lib/db/settings.ts because that file transitively
// pulls in Prisma + node-fetch + node: scheme builtins, which broke the
// client build (this page is `'use client'`).

export default function SettingsPage() {
  const toast = useToast();
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState('ai');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [settingsScope, setSettingsScope] = useState<'app' | 'session' | 'user'>('app');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; ms?: number; response?: string; error?: string } | null>(null);
  // Available models fetched from the provider
  const [textModels, setTextModels] = useState<string[]>([]);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState<'text' | 'image' | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{ username: string; name: string; role: string } | null>(null);
  const [profileForm, setProfileForm] = useState({ name: '', email: '', password: '' });
  const [profileSaving, setProfileSaving] = useState(false);
  const [auditLogs, setAuditLogs] = useState<Array<{ id: string; action: string; actor?: { username: string; name: string | null; role: string } | null; targetUser?: { username: string; name: string | null; role: string } | null; details: string | null; createdAt: string }>>([]);
  const [userRows, setUserRows] = useState<Array<{ id: string; username: string; name: string; email: string | null; role: string; createdAt: string }>>([]);
  const [userForm, setUserForm] = useState({ username: '', email: '', password: '', role: 'USER' as 'USER' | 'ADMIN' });
  const [userSubmitting, setUserSubmitting] = useState(false);

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

  const fetchCurrentUser = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!res.ok) {
        setCurrentUser(null);
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.ok && data.user) setCurrentUser(data.user);
    } catch {
      setCurrentUser(null);
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/users', { cache: 'no-store' });
      if (!res.ok) {
        setUserRows([]);
        return;
      }
      const data = await res.json().catch(() => ({ users: [] }));
      setUserRows(Array.isArray(data.users) ? data.users : []);
    } catch {
      setUserRows([]);
    }
  }, []);

  const fetchAuditLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/audit-logs', { cache: 'no-store' });
      if (!res.ok) {
        setAuditLogs([]);
        return;
      }
      const data = await res.json().catch(() => ({ logs: [] }));
      setAuditLogs(Array.isArray(data.logs) ? data.logs : []);
    } catch {
      setAuditLogs([]);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/settings');
      const s = await res.json().catch(() => ({})) as Settings & { error?: string };
      if (!res.ok) throw new Error(s.error ?? `HTTP ${res.status}`);
      setSettings({ ...s, scope: (s.scope as 'app' | 'session' | 'user') ?? 'app' });
      setSettingsScope((s.scope as 'app' | 'session' | 'user') ?? 'app');
      // BUGFIX 2026-07-11: loading /settings was silently overriding the
      // user's live theme choice. The provider paints the chrome based on
      // localStorage; the server field was being applied UNCONDITIONALLY on
      // mount, so navigating to /settings always re-resolved the stored
      // theme on top of whatever the user had currently selected — often
      // flipping dark→white (e.g. server says 'system' + OS prefers light).
      //
      // New rule: only adopt the server theme if
      //   (a) this device has never set a localStorage theme — use the
      //       server row as the seed, OR
      //   (b) the server row matches the user's current local theme —
      //       already-applied state, no-op at worst.
      // We must NOT overwrite a live theme on every visit to /settings.
      // The <input> onChange on the Appearance tab already calls
      // `setAppTheme(next)` which stages for save AND applies immediately,
      // so saves don't go through this path.
      if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'system') {
        let stored: string | null = null;
        try { stored = window.localStorage.getItem('theme'); } catch { /* private mode */ }
        const hasUserPick = stored === 'light' || stored === 'dark' || stored === 'system';
        if (!hasUserPick) {
          // First run on this device — seed localStorage with the server value.
          setTheme(s.theme);
        } else if (stored !== s.theme) {
          // User has a live local pick that disagrees with the server row
          // (e.g. they explicitly chose 'dark' on this device even though
          // the server is still 'system'). Update the SERVER to match the
          // live client pick so future devices / sessions converge — but
          // do NOT touch <html>; the client pick is already painted.
          fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme: stored }),
          }).catch(() => { /* best-effort reconcile; ignore failures */ });
        }
      }
      setDirty(false);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setTheme]);

  useEffect(() => { void fetchSettings(); void fetchCurrentUser(); void fetchUsers(); void fetchAuditLogs(); }, [fetchSettings, fetchCurrentUser, fetchUsers, fetchAuditLogs]);

  useEffect(() => {
    const syncHash = () => {
      const next = window.location.hash.slice(1);
      if (['ai', 'tts', 'conversion', 'watermarks', 'image', 'appearance', 'importers', 'users'].includes(next)) setActiveTab(next);
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

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
        scope: settingsScope,
        aiProvider: settings.aiProvider,
        aiBaseUrl: settings.aiBaseUrl,
        aiAllowInsecureTls: settings.aiAllowInsecureTls,
        aiModel: settings.aiModel,
        aiMaxTokens: settings.aiMaxTokens,
        aiTemperature: settings.aiTemperature,
        ttsProvider: settings.ttsProvider,
        defaultAiEnhance: settings.defaultAiEnhance,
        defaultAiWatermarkClean: settings.defaultAiWatermarkClean,
        defaultDeepFormat: settings.defaultDeepFormat,
        defaultReaderFriendly: settings.defaultReaderFriendly,
        defaultLanguage: settings.defaultLanguage,
        theme: settings.theme,
        imageProvider: settings.imageProvider,
        workerConcurrency: settings.workerConcurrency,
        workerChapterConcurrency: settings.workerChapterConcurrency,
        aiEnhanceConcurrency: settings.aiEnhanceConcurrency ?? 3,
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
      const updated = await res.json().catch(() => ({})) as Settings & { error?: string };
      if (!res.ok) throw new Error(updated.error ?? `Không thể lưu (HTTP ${res.status})`);
      setSettings({ ...updated, scope: settingsScope });
      setSavedAt(new Date());
      setDirty(false);
      toast.success('Đã lưu cài đặt');
      // Auto-refresh the available models list with the new API key
      void fetchModels('text');
      if (updated.imageProvider && updated.imageProvider !== 'none') {
        void fetchModels('image');
      }
    } catch (e) {
      toast.error('Không thể lưu cài đặt', { description: e instanceof Error ? e.message : String(e) });
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
    setDirty(true);
  };

  const clearSavedKey = (kind: 'ai' | 'image') => {
    if (!settings) return;
    setSettings(kind === 'ai'
      ? { ...settings, aiApiKey: '', aiApiKeyMasked: null }
      : { ...settings, imageApiKey: '', imageApiKeyMasked: null });
    setSavedAt(null);
    setDirty(true);
  };

  const pickProviderDefaults = (providerId: string) => {
    const p = AI_PROVIDERS.find((x) => x.id === providerId);
    if (!p || !settings) return;
    setSettings({
      ...settings,
      aiProvider: providerId,
      aiModel: p.defaultModel,
      aiBaseUrl: p.defaultUrl,
      aiMaxTokens: p.defaultMaxTokens,
    });
    // Clear stale model list / error from the previous provider
    setTextModels([]);
    setImageModels([]);
    setModelsError(null);
    setSavedAt(null);
    setDirty(true);
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const setAppTheme = (next: ThemeMode) => {
    update('theme', next);
    setTheme(next);
  };

  const createUser = async () => {
    if (!userForm.username.trim()) {
      toast.error('Username is required');
      return;
    }
    setUserSubmitting(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: userForm.username.trim(),
          email: userForm.email.trim(),
          password: userForm.password || 'changeme123',
          role: userForm.role,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: 'Failed to create user.' }));
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Failed to create user.');
      setUserForm({ username: '', email: '', password: '', role: 'USER' });
      await fetchUsers();
      await fetchAuditLogs();
      toast.success('User created');
    } catch (e) {
      toast.error('Could not create user', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUserSubmitting(false);
    }
  };

  const saveProfile = async () => {
    setProfileSaving(true);
    try {
      const payload: Record<string, string> = {};
      if (profileForm.name.trim()) payload.name = profileForm.name.trim();
      if (profileForm.email.trim()) payload.email = profileForm.email.trim();
      if (profileForm.password.trim()) payload.password = profileForm.password.trim();
      if (Object.keys(payload).length === 0) {
        toast.error('Enter at least one profile change');
        return;
      }

      const res = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({ ok: false, error: 'Profile update failed.' }));
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Profile update failed.');
      setProfileForm({ name: '', email: '', password: '' });
      await fetchCurrentUser();
      await fetchAuditLogs();
      toast.success('Profile updated');
    } catch (e) {
      toast.error('Could not update profile', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setProfileSaving(false);
    }
  };

  if (loading && !settings) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <PageHeader eyebrow="Cài đặt" title="Đang tải…" icon={<SettingsIcon className="h-4 w-4" />} />
        <div className="space-y-2">{Array.from({length: 4}).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}</div>
      </div>
    );
  }

  if (loadError && !settings) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <PageHeader eyebrow="Cài đặt" title="Cài đặt" icon={<SettingsIcon className="h-4 w-4" />} />
        <ErrorState title="Không thể tải cài đặt" message={loadError} details={loadError} onRetry={() => void fetchSettings()} retrying={loading} />
      </div>
    );
  }

  if (!settings) return null;

  const aiProvider = AI_PROVIDERS.find((p) => p.id === settings.aiProvider) ?? AI_PROVIDERS[0];
  const ttsProvider = TTS_PROVIDERS.find((p) => p.id === settings.ttsProvider) ?? TTS_PROVIDERS[0];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Cài đặt' }]}
        title="Cài đặt"
        description="Chọn AI provider, cấu hình TTS, giao diện và các tuỳ chọn mặc định. Thay đổi có hiệu lực sau khi lưu."
        icon={<SettingsIcon className="h-4 w-4" />}
        actions={
          <>
            {savedAt && (
              <span className="text-[10px] text-green-600 dark:text-green-400 flex items-center gap-1">
                <Check className="h-3 w-3" /> Đã lưu {savedAt.toLocaleTimeString()}
              </span>
            )}
            {dirty && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Chưa lưu</span>}
            <Button variant="outline" size="sm" onClick={() => void fetchSettings()} title="Tải lại" aria-label="Tải lại cài đặt">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <div className="flex items-center gap-2">
              <Select value={settingsScope} onValueChange={(v) => setSettingsScope(v as 'app' | 'session' | 'user')}>
                <SelectTrigger className="h-9 w-[180px] text-xs">
                  <SelectValue placeholder="Scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="app">App default</SelectItem>
                  <SelectItem value="session">This session</SelectItem>
                  <SelectItem value="user">This user profile</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={save} disabled={saving || !dirty} size="sm">
                {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                Lưu
              </Button>
            </div>
          </>
        }
      />

      {loadError && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Không thể tải lại cài đặt: {loadError}
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(next) => {
          setActiveTab(next);
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${next}`);
        }}
      >
        <TabsList className="h-auto min-h-9 w-full justify-start overflow-x-auto flex-nowrap lg:justify-center" aria-label="Nhóm cài đặt">
          <TabsTrigger value="ai" className="gap-1.5">
            <Cpu className="h-3.5 w-3.5" /> AI Provider
          </TabsTrigger>
          <TabsTrigger value="tts" className="gap-1.5">
            <Volume2 className="h-3.5 w-3.5" /> TTS
          </TabsTrigger>
          <TabsTrigger value="conversion" className="gap-1.5">
            <Wand2 className="h-3.5 w-3.5" /> Conversion
          </TabsTrigger>
          <TabsTrigger value="watermarks" className="gap-1.5">
            <ShieldOff className="h-3.5 w-3.5" /> Watermarks
          </TabsTrigger>
          <TabsTrigger value="image" className="gap-1.5">
            <ImageIcon className="h-3.5 w-3.5" /> Image generation
          </TabsTrigger>
          <TabsTrigger value="appearance" className="gap-1.5">
            <Palette className="h-3.5 w-3.5" /> Giao diện
          </TabsTrigger>
          <TabsTrigger value="importers" className="gap-1.5">
            <Download className="h-3.5 w-3.5" /> Importers
          </TabsTrigger>
          <TabsTrigger value="users" className="gap-1.5">
            <Users className="h-3.5 w-3.5" /> User &amp; access
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
                  <button key={p.id} type="button" onClick={() => pickProviderDefaults(p.id)} aria-pressed={selected}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4 pt-4 border-t border-border">
              <ApiKeyField
                id="settings-ai-key"
                label={`API Key${aiProvider.needsKey ? ' *' : ''}`}
                value={settings.aiApiKey}
                masked={settings.aiApiKeyMasked}
                required={aiProvider.needsKey}
                showKey={showKey}
                onToggleShow={() => setShowKey((v) => !v)}
                onChange={(v) => update('aiApiKey', v)}
                onClear={() => clearSavedKey('ai')}
              />

              <ModelField
                label="Model"
                models={textModels}
                current={settings.aiModel}
                loading={modelsLoading === 'text'}
                omlxHint={settings.aiProvider === 'omlx-local'}
                onChange={(v) => update('aiModel', v)}
                onRefresh={() => fetchModels('text')}
                onPickFast={() => {
                  // Prefer smaller / 4-bit variants when available — fits the
                  // 17.76 GB unified-memory ceiling with headroom for KV cache.
                  const fast = textModels.find((m) => m.includes('4B') || m.includes('Ornith'))
                    ?? textModels.find((m) => m.includes('4bit'))
                    ?? textModels[0];
                  if (fast) update('aiModel', fast);
                }}
                placeholder={
                  settings.aiProvider === 'omlx-local'
                    ? (textModels.length ? '' : 'Bấm "Lấy danh sách" để lấy model từ OMLX')
                    : 'vd: gpt-4o-mini, MiniMax-Text-01, qwen2.5-7b'
                }
                tooltip={
                  settings.aiProvider === 'omlx-local' ? (
                    <>Model OMLX local lấy từ biến môi trường <span className="font-mono">OMLX_MODEL</span> trên server. Mặc định: <span className="font-mono">default</span>.</>
                  ) : undefined
                }
              />
              {modelsError && textModels.length === 0 && settings.aiProvider !== 'omlx-local' && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 sm:col-span-2 -mt-2">{modelsError}</p>
              )}

              {(settings.aiProvider === 'custom' || settings.aiBaseUrl) && (
                <Field
                  label="Base URL"
                  icon={<a href="https://platform.openai.com/docs/api-reference" target="_blank" rel="noreferrer" aria-label="Open AI API documentation in a new tab" className="text-muted-foreground hover:text-foreground"><ExternalLink className="h-3 w-3" /></a>}
                  htmlFor="settings-ai-url"
                >
                  <Input id="settings-ai-url" type="url" value={settings.aiBaseUrl ?? ''}
                    onChange={(e) => update('aiBaseUrl', e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="font-mono"
                  />
                  {settings.aiProvider === 'custom' && (
                    <div className="mt-2 rounded-md border border-border bg-muted/20 p-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <Tooltip content="Use for self-signed or private CA endpoints like gateway/bridge services." side="top">
                            <span tabIndex={0} className="inline-flex items-center gap-1.5 text-[11px] font-medium cursor-help">
                              Disable TLS certificate verification
                              <Info className="h-3 w-3 text-muted-foreground/70" />
                            </span>
                          </Tooltip>
                        </div>
                        <Switch
                          checked={!!settings.aiAllowInsecureTls}
                          onCheckedChange={(v) => update('aiAllowInsecureTls', v)}
                          aria-label="Disable TLS certificate verification for AI provider"
                        />
                      </div>
                    </div>
                  )}
                </Field>
              )}

              <Field label="Max tokens" htmlFor="settings-ai-max-tokens">
                <Input id="settings-ai-max-tokens" type="number" min={64} max={32000} step={64} value={settings.aiMaxTokens}
                  onChange={(e) => update('aiMaxTokens', parseInt(e.target.value, 10) || 4096)}
                />
              </Field>

              <Field
                label="Temperature"
                htmlFor="settings-ai-temperature"
                tooltip="0 = deterministic (repeatable output) · 2 = most creative. Lower values keep the model on-topic; higher values add variety."
                help={
                  <span className="flex items-center justify-between">
                    <span>0 → 2</span>
                    <span className="font-mono font-semibold text-foreground">{settings.aiTemperature.toFixed(2)}</span>
                  </span>
                }
              >
                <input id="settings-ai-temperature" type="range" min={0} max={2} step={0.05} value={settings.aiTemperature}
                  aria-valuetext={settings.aiTemperature.toFixed(2)}
                  onChange={(e) => update('aiTemperature', parseFloat(e.target.value))}
                  className="w-full accent-primary"
                />
              </Field>

              {/* Per-mode `enable_thinking` toggles (2026-07-12).
                  Combine (chunked, default ON) — small batches where the
                  reasoning trace fits in the output budget AND accuracy
                  > speed. Full-LLM (whole-chapter, default OFF) — large
                  prompt, chain-of-thought would consume the JSON output
                  cap before rows land. Users can flip either based on
                  their model's behavior. */}
              <div className="space-y-1.5 sm:col-span-2 rounded-md border border-border/40 bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <label htmlFor="settings-ai-thinking-combine" className="text-xs font-medium flex items-center gap-1.5">
                      <Brain className="h-3.5 w-3.5 text-muted-foreground" />
                      Thinking — Combine mode
                      <Tooltip content="Bật enable_thinking cho các batch nhỏ (4 đoạn/batch). Khuyến nghị ON cho model thinking (Qwen3, DeepSeek-R1)." side="top">
                        <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                          <Info className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    </label>
                  </div>
                  <Switch
                    id="settings-ai-thinking-combine"
                    checked={settings.aiThinkingCombine ?? true}
                    onCheckedChange={(v) => update('aiThinkingCombine', v)}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/40">
                  <div className="flex-1 min-w-0">
                    <label htmlFor="settings-ai-thinking-full-llm" className="text-xs font-medium flex items-center gap-1.5">
                      <Brain className="h-3.5 w-3.5 text-muted-foreground" />
                      Thinking — Full LLM mode
                      <Tooltip content="Bật enable_thinking cho whole-chapter LLM call. Mặc định OFF vì prompt lớn chiếm hết output budget trước khi kịp xuất rows." side="top">
                        <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                          <Info className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    </label>
                  </div>
                  <Switch
                    id="settings-ai-thinking-full-llm"
                    checked={settings.aiThinkingFullLLM ?? false}
                    onCheckedChange={(v) => update('aiThinkingFullLLM', v)}
                  />
                </div>
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
                    <Check className="h-3 w-3" /> OK ({testResult.ms}ms): &ldquo;{testResult.response}&rdquo;
                  </span>
                )}
              </div>
              {testResult && !testResult.ok && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs space-y-1">
                  <div className="flex items-start gap-1.5 text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold">{testResult.error}</p>
                      {(testResult.error?.includes('401') || testResult.error?.toLowerCase().includes('api key') || testResult.error?.toLowerCase().includes('authorized')) && settings.aiProvider === 'minimax-cloud' && (
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
                  <button key={p.id} type="button" onClick={() => update('ttsProvider', p.id)} aria-pressed={selected}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
              <Field
                label="Max parallel jobs"
                htmlFor="settings-worker-concurrency"
                tooltip="Số conversion chạy đồng thời. Tăng để tận dụng AI provider nhanh (local 4B/9B, MiniMax), giảm cho máy yếu. Cần restart worker để áp dụng."
                help={
                  <span className="flex items-center justify-between">
                    <span>1 → 8</span>
                    <span className="font-mono font-semibold text-foreground">{settings.workerConcurrency}</span>
                  </span>
                }
              >
                <input id="settings-worker-concurrency" type="range" min={1} max={8} step={1} aria-label="Max parallel jobs"
                  value={settings.workerConcurrency}
                  onChange={(e) => update('workerConcurrency', parseInt(e.target.value, 10) || 2)}
                  className="w-full accent-primary" />
              </Field>
              <Field
                label="Chapter concurrency (per job)"
                htmlFor="settings-worker-chapter-concurrency"
                tooltip="Trong 1 conversion, deep-format nhiều chương đồng thời. Tăng để giảm thời gian, nhưng tốn nhiều API call hơn. Cần restart worker để áp dụng."
                help={
                  <span className="flex items-center justify-between">
                    <span>1 → 8</span>
                    <span className="font-mono font-semibold text-foreground">{settings.workerChapterConcurrency}</span>
                  </span>
                }
              >
                <input id="settings-worker-chapter-concurrency" type="range" min={1} max={8} step={1} aria-label="Chapter concurrency per job"
                  value={settings.workerChapterConcurrency}
                  onChange={(e) => update('workerChapterConcurrency', parseInt(e.target.value, 10) || 1)}
                  className="w-full accent-primary" />
              </Field>
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" /> AI enhancement
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-normal">
                (live — no restart)
              </span>
            </h2>
            <Field
              label="Parallel chapter LLM calls"
              htmlFor="settings-ai-enhance-concurrency"
              tooltip="Số chapter AI-enhance chạy đồng thời. Thay đổi có hiệu lực NGAY trên batch kế tiếp của job đang chạy (không cần restart worker). Tăng nếu API cloud nhanh; giảm nếu model local (Apple Silicon KV cache bão hoà)."
              help={
                <span className="flex items-center justify-between">
                  <span>1 → 16</span>
                  <span className="font-mono font-semibold text-foreground">{settings.aiEnhanceConcurrency}</span>
                </span>
              }
            >
              <input id="settings-ai-enhance-concurrency" type="range" min={1} max={16} step={1} aria-label="Parallel chapter LLM calls"
                value={settings.aiEnhanceConcurrency}
                onChange={(e) => update('aiEnhanceConcurrency', parseInt(e.target.value, 10) || 3)}
                className="w-full accent-primary" />
            </Field>
          </Card>

          <Card className="p-5 space-y-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-primary" /> Conversion defaults
            </h2>
            <div className="space-y-2">
              <ToggleRow
                icon={<Sparkles className="h-4 w-4" />}
                label="AI enhance (auto-repair HTML)"
                tooltip="Bật LLM sửa HTML lỗi khi convert. Tốn thêm ~10-30s nhưng chất lượng cao hơn nhiều."
                checked={settings.defaultAiEnhance}
                onChange={(v) => update('defaultAiEnhance', v)}
              />
              <ToggleRow
                icon={<Wand2 className="h-4 w-4 text-amber-600 dark:text-amber-400" />}
                label="Deep format (Vietnamese novel)"
                tooltip="Dùng LLM re-format từng chương cho tiểu thuyết Việt — gộp/tách đoạn văn, định dạng hội thoại (nháy cong), ngắt cảnh bằng <hr/>. Chậm (~2-5 phút/chương)."
                checked={settings.defaultDeepFormat}
                onChange={(v) => update('defaultDeepFormat', v)}
              />
              <ToggleRow
                icon={<ShieldOff className="h-4 w-4" />}
                label="AI watermark cleaning"
                tooltip="Tự động phát hiện & loại bỏ quảng cáo / watermark cuối chương (có memory để lần sau detect nhanh hơn)."
                checked={settings.defaultAiWatermarkClean}
                onChange={(v) => update('defaultAiWatermarkClean', v)}
              />
              <ToggleRow
                icon={<Smartphone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
                label="Reader-friendly (Onyx Boox / Kobo / Kindle)"
                tooltip="Mặc định BẬT. Strip CSS nặng (animation, blur, text-shadow, hyphens) + dùng stylesheet tối giản để EPUB render đúng trên máy đọc e-ink. Tắt nếu muốn giữ styling gốc của sách."
                checked={settings.defaultReaderFriendly}
                onChange={(v) => update('defaultReaderFriendly', v)}
              />
            </div>

            <Field
              label="Ngôn ngữ mặc định cho EPUB mới"
              icon={<Languages className="h-3 w-3" />}
              htmlFor="settings-default-language"
              full
            >
              <Select value={settings.defaultLanguage} onValueChange={(v) => update('defaultLanguage', v)}>
                <SelectTrigger id="settings-default-language" className="w-full" aria-label="Ngôn ngữ mặc định cho EPUB mới">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vi">Tiếng Việt</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="mixed">Hỗn hợp</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </Card>
        </TabsContent>

        {/* ── Watermarks tab (cross-book learning) ────────────────────────── */}
        <TabsContent value="watermarks" className="space-y-4 outline-none">
          <WatermarkMemoryPanel />
        </TabsContent>

        {/* ── Image generation tab ────────────────────────────────────────── */}
        <TabsContent value="image" className="space-y-4 outline-none">
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-primary" /> Image generation
                <Tooltip content="AI generates black-and-white illustrations for “highlight” chapters of novels. Output style adapts to the story (e.g. ink-wash for tu tiểu thuyết, manga for modern web novels)." side="top">
                  <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                    <Info className="h-3 w-3" />
                  </span>
                </Tooltip>
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

            {/* Provider cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['none', 'openai', 'minimax', 'custom'] as const).map((p) => (
                <button key={p} type="button" onClick={() => update('imageProvider', p)} aria-pressed={settings.imageProvider === p}
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4 pt-4 border-t border-border">
                  <ApiKeyField
                    id="settings-image-key"
                    label="Image API Key"
                    value={settings.imageApiKey}
                    masked={settings.imageApiKeyMasked}
                    required
                    showKey={showKey}
                    onToggleShow={() => setShowKey((v) => !v)}
                    onChange={(v) => update('imageApiKey', v)}
                    onClear={() => clearSavedKey('image')}
                  />

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
                    <Field label="Base URL" htmlFor="settings-image-url" full
                      tooltip={
                        <span>
                          Để trống sẽ dùng default của provider:{' '}
                          <span className="font-mono">
                            {settings.imageProvider === 'openai'  ? 'https://api.openai.com/v1' :
                             settings.imageProvider === 'minimax' ? 'https://api.minimax.io/v1' :
                             'bắt buộc cho Custom'}
                          </span>
                        </span>
                      }
                    >
                      <Input id="settings-image-url" type="url" value={settings.imageBaseUrl ?? ''}
                        onChange={(e) => update('imageBaseUrl', e.target.value)}
                        placeholder="https://api.example.com/v1"
                        className="font-mono"
                      />
                    </Field>
                  )}

                  <Field label="Art style" htmlFor="settings-image-style"
                    tooltip="Default is black-and-white anime line-art — keeps cover + chapters visually cohesive. Same character regenerates with matching look via per-chapter seed anchoring."
                  >
                    <Select value={settings.imageStyle} onValueChange={(v) => update('imageStyle', v)}>
                      <SelectTrigger id="settings-image-style" className="w-full" aria-label="Art style">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* B&W family — preferred for novels; covers + chapter
                            illustrations stay in the same visual language and
                            character consistency (per-chapter seed anchoring)
                            is easier when the provider has no colour to guess. */}
                        <SelectItem value="bw-anime">Anime line-art (Đen trắng) — RECOMMENDED for novels</SelectItem>
                        <SelectItem value="bw-manga">Manga / manhua (Đen trắng)</SelectItem>
                        <SelectItem value="bw-ink">Ink-wash line drawing (Đen trắng, 水墨)</SelectItem>
                        <SelectItem value="bw-sketch">Pencil sketch (Đen trắng)</SelectItem>
                        {/* Legacy / coloured alternatives */}
                        <SelectItem value="ink">Ink wash (legacy)</SelectItem>
                        <SelectItem value="manga">Manga (legacy)</SelectItem>
                        <SelectItem value="sketch">Pencil sketch (legacy)</SelectItem>
                        <SelectItem value="watercolor">Watercolor — softened colour</SelectItem>
                        <SelectItem value="none">Provider default (no style guide)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field label="Max illustrations per book" htmlFor="settings-image-max"
                    tooltip="AI sẽ phân tích từng chương, chỉ chọn những chương có cảnh đáng kể (giai đoạn quan trọng, đấu pháp, gặp gỡ nhân vật, v.v.) và tạo ảnh cho tối đa số chương trên."
                  >
                    <Input id="settings-image-max" type="number" min={0} max={50} value={settings.imageMaxPerBook}
                      onChange={(e) => update('imageMaxPerBook', parseInt(e.target.value, 10) || 0)}
                    />
                  </Field>
                </div>
              </>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="appearance" className="space-y-4 outline-none">
          <Card className="p-5 space-y-4">
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Palette className="h-4 w-4 text-primary" /> Giao diện ứng dụng
              </h2>
              <Tooltip content="Chọn giao diện cố định hoặc tự động theo cài đặt của hệ điều hành." side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Giao diện ứng dụng">
              {([
                { id: 'system' as const, label: 'Theo hệ thống', description: 'Tự đổi sáng/tối theo thiết bị', Icon: Monitor },
                { id: 'light' as const, label: 'Sáng', description: 'Nền sáng, độ tương phản cao', Icon: Sun },
                { id: 'dark' as const, label: 'Tối', description: 'Dịu mắt trong môi trường tối', Icon: Moon },
              ]).map(({ id: mode, label, description, Icon }) => (
                <Tooltip key={mode} content={description} side="bottom">
                  <button
                    type="button"
                    onClick={() => setAppTheme(mode)}
                    aria-pressed={theme === mode}
                    className={cn(
                      'w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      theme === mode ? 'border-primary bg-primary/5 ring-1 ring-primary/40' : 'border-border hover:bg-muted/40',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4" />{label}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          </Card>

          <Card className="p-5 space-y-3">
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-primary" /> Tuỳ chỉnh trình đọc
              </h2>
              <Tooltip content="Kiểu trang, font, cỡ chữ, giãn dòng, thụt đầu dòng và lề được lưu riêng trên thiết bị này. Mở một cuốn sách rồi chọn biểu tượng cài đặt trong thanh công cụ; nhấn ? để xem phím tắt." side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
            <Link href="/library" className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground">
              Mở thư viện
            </Link>
          </Card>
        </TabsContent>

        {/* ── Importers tab (Phase 4.3) ──────────────────────────────────── */}
        <TabsContent value="importers" className="space-y-4 outline-none">
          <CalibrePanel />
        </TabsContent>

        {/* ── User & access tab ─────────────────────────────────────────── */}
        <TabsContent value="users" className="space-y-4 outline-none">
          <Card className="p-5 space-y-4">
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" /> My profile
              </h2>
              <Tooltip content="Update your visible name, email, and password for local app access." side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Display name</label>
              <Input value={profileForm.name} onChange={(e) => setProfileForm((p) => ({ ...p, name: e.target.value }))} placeholder={currentUser?.name || 'Your name'} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Email</label>
              <Input value={profileForm.email} onChange={(e) => setProfileForm((p) => ({ ...p, email: e.target.value }))} placeholder="you@example.com" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">New password</label>
              <Input type="password" value={profileForm.password} onChange={(e) => setProfileForm((p) => ({ ...p, password: e.target.value }))} placeholder="Leave blank to keep current" />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="button" onClick={() => void saveProfile()} disabled={profileSaving}>
              {profileSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />}
              {profileSaving ? 'Saving…' : 'Save profile'}
            </Button>
          </div>
        </Card>

        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" /> Access & user management
              </h2>
              <Tooltip content="Admin-only user CRUD and role assignment for local app access." side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
            {currentUser?.role === 'ADMIN' && (
            <Button type="button" variant="outline" size="sm" onClick={() => { void fetchUsers(); void fetchAuditLogs(); }}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
            </Button>
          )}
        </div>

        {currentUser?.role !== 'ADMIN' ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
            Only the admin role can manage users and update app settings.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div className="space-y-1.5 md:col-span-1">
                <label className="text-xs font-medium">Username</label>
                <Input value={userForm.username} onChange={(e) => setUserForm((p) => ({ ...p, username: e.target.value }))} placeholder="new-user" />
              </div>
              <div className="space-y-1.5 md:col-span-1">
                <label className="text-xs font-medium">Email</label>
                <Input value={userForm.email} onChange={(e) => setUserForm((p) => ({ ...p, email: e.target.value }))} placeholder="user@example.com" />
              </div>
              <div className="space-y-1.5 md:col-span-1">
                <label className="text-xs font-medium">Password</label>
                <Input type="password" value={userForm.password} onChange={(e) => setUserForm((p) => ({ ...p, password: e.target.value }))} placeholder="changeme123" />
              </div>
              <div className="space-y-1.5 md:col-span-1">
                <label className="text-xs font-medium">Role</label>
                <Select value={userForm.role} onValueChange={(v) => setUserForm((p) => ({ ...p, role: v as 'USER' | 'ADMIN' }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">USER</SelectItem>
                    <SelectItem value="ADMIN">ADMIN</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={() => void createUser()} disabled={userSubmitting}>
                {userSubmitting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-2 h-3.5 w-3.5" />}
                {userSubmitting ? 'Creating…' : 'Create user'}
              </Button>
            </div>

            <div className="space-y-2">
              {userRows.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No users found.</div>
              ) : (
                userRows.map((user) => (
                  <div key={user.id} className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{user.name || user.username}</span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium uppercase', user.role === 'ADMIN' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
                          {user.role}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {user.username} {user.email ? `• ${user.email}` : ''}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground">Created {new Date(user.createdAt).toLocaleDateString()}</div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </Card>

      <Card className="p-5 space-y-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" /> Admin audit log
          </h2>
          <Tooltip content="Recent local admin actions, user creation, setting changes, and profile updates." side="top">
            <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        </div>

        {currentUser?.role !== 'ADMIN' ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
            Audit logs are visible only to administrators.
          </div>
        ) : auditLogs.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No audit events yet.</div>
        ) : (
          <div className="space-y-2">
            {auditLogs.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium uppercase tracking-wider text-primary">{entry.action}</span>
                  <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {entry.actor ? `${entry.actor.name || entry.actor.username} (${entry.actor.role})` : 'system'}
                  {entry.targetUser ? ` → ${entry.targetUser.name || entry.targetUser.username} (${entry.targetUser.role})` : ''}
                </div>
                {entry.details && <div className="mt-1">{entry.details}</div>}
              </div>
            ))}
          </div>
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
  placeholder, helpText, tooltip,
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
  tooltip?: ReactNode;
}) {
  const fieldId = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={fieldId} className="text-xs font-medium flex items-center gap-1.5">
          {label}
          {tooltip && (
            <Tooltip content={tooltip} side="top">
              <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                <Info className="h-3 w-3" />
              </span>
            </Tooltip>
          )}
        </label>
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
          <SelectTrigger id={fieldId} className="w-full font-mono">
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
        <Input id={fieldId} type="text" value={current}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="font-mono"
        />
      )}
      {helpText && <p className="text-[10px] text-muted-foreground">{helpText}</p>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * WatermarkMemoryPanel — list + manage remembered watermark phrases.
 *
 * The conversion pipeline auto-records every phrase it strips (source=auto).
 * Users can also pre-seed known publisher footers (source=user). Both are
 * stripped on the next conversion without re-running the frequency scan,
 * so book #2 with the same footer finishes the watermark step in O(10–50)
 * regex passes instead of O(chapters × blocks).
 * ──────────────────────────────────────────────────────────────────────── */
function WatermarkMemoryPanel() {
  const toast = useToast();
  const phraseInputId = useId();
  const [rows, setRows] = useState<WatermarkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newPhrase, setNewPhrase] = useState('');
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<'all' | 'auto' | 'user'>('all');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/watermarks');
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? `HTTP ${r.status}`); setRows([]); }
      else { setRows(data.phrases ?? []); setError(null); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const addPhrase = async () => {
    const p = newPhrase.trim();
    if (p.length < 4) { setError('Phrase phải ≥ 4 ký tự'); return; }
    setAdding(true); setError(null);
    try {
      const r = await fetch('/api/watermarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase: p }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? `HTTP ${r.status}`); return; }
      setNewPhrase('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const delPhrase = (phrase: string) => {
    toast.confirm({
      title: 'Xoá phrase khỏi memory?',
      description: phrase,
      confirmLabel: 'Xoá',
      destructive: true,
      onConfirm: async () => {
        setError(null);
        try {
          const r = await fetch(`/api/watermarks/${encodeURIComponent(phrase)}`, { method: 'DELETE' });
          if (!r.ok) {
            const data = await r.json().catch(() => ({})) as { error?: string };
            setError(data.error ?? `HTTP ${r.status}`);
            return;
          }
          await reload();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    });
  };

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.source === filter);
  const totalAuto = rows.filter((r) => r.source === 'auto').length;
  const totalUser = rows.filter((r) => r.source === 'user').length;

  return (
    <>
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" /> Watermark Memory
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-normal flex items-center gap-1">
                <Bookmark className="h-3 w-3" /> cross-book learning
              </span>
            </h2>
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
              Phrase đã phát hiện & loại bỏ ở lần convert trước sẽ được lưu lại. Book kế tiếp có cùng footer
              sẽ bị strip ngay khi convert — không cần chạy lại frequency scan. Tổng cộng{' '}
              <span className="font-semibold text-foreground">{rows.length}</span> phrase
              {rows.length !== 1 ? 's' : ''} ({totalAuto} auto · {totalUser} user).
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={reload} title="Tải lại">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Add new phrase */}
        <div className="space-y-1.5 pt-2 border-t border-border">
          <label htmlFor={phraseInputId} className="text-xs font-medium flex items-center gap-1.5">
            <Plus className="h-3 w-3" />
            Thêm phrase thủ công (vd: footer nhà xuất bản)
          </label>
          <div className="flex gap-2">
            <Input
              id={phraseInputId}
              type="text"
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addPhrase(); }}
              placeholder="vd: www.example-ebook.com"
              className="flex-1 font-mono text-xs"
              disabled={adding}
              maxLength={200}
            />
            <Button size="sm" onClick={addPhrase} disabled={adding || newPhrase.trim().length < 4}>
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Thêm
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Phrase sẽ bị strip ở mọi conversion từ giờ trở đi. Min 4 chars, max 200.
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive flex items-start gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Filter chips */}
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="text-muted-foreground mr-1">Lọc:</span>
          {(['all', 'auto', 'user'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn('rounded-full px-2.5 py-0.5 font-semibold border transition-colors',
                filter === f
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:bg-muted/40')}>
              {f === 'all' ? `Tất cả (${rows.length})` : f === 'auto' ? `Auto (${totalAuto})` : `User (${totalUser})`}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="rounded-lg border border-border divide-y divide-border max-h-[420px] overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mx-auto mb-1" />
              Đang tải…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {rows.length === 0 ? (
                <>
                  <Database className="h-6 w-6 mx-auto mb-1 opacity-40" />
                  Chưa có phrase nào trong memory. Bật &ldquo;AI Watermark Cleanup&rdquo; khi convert, hoặc thêm phrase thủ công ở trên.
                </>
              ) : (
                <>Không có phrase {filter} nào.</>
              )}
            </div>
          ) : (
            filtered.map((row) => (
              <div key={row.id} className="flex items-start gap-2 px-3 py-2 hover:bg-muted/30 transition-colors">
                <span className={cn('shrink-0 mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  row.source === 'auto' ? 'bg-primary/15 text-primary' :
                  row.source === 'user' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' :
                  'bg-muted text-muted-foreground',
                )}>
                  {row.source}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono break-words whitespace-pre-wrap">
                    {row.phrase}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    seen in <span className="font-semibold">{row.hitCount}</span> book{row.hitCount !== 1 ? 's' : ''}
                    {' · last '}
                    {new Date(row.lastSeenAt).toLocaleDateString()}
                  </p>
                </div>
                <Button size="sm" variant="ghost"
                  onClick={() => delPhrase(row.phrase)}
                  className="shrink-0 text-destructive hover:bg-destructive/10"
                  title="Xoá khỏi memory">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h3 className="text-xs font-semibold flex items-center gap-1.5">
          <ShieldOff className="h-3.5 w-3.5 text-primary" /> Cách hoạt động
        </h3>
        <ol className="text-[11px] text-muted-foreground space-y-1 list-decimal list-inside pl-1">
          <li>
            <span className="font-semibold text-foreground">Memory read trước</span> — mỗi conversion load memory,
            strip thẳng các phrase đã biết. Chi phí: 0 LLM call, ~1ms cho 50 phrase.
          </li>
          <li>
            <span className="font-semibold text-foreground">Detection bình thường</span> — frequency scan chạy trên
            những phrase <em>chưa</em> có trong memory, tìm watermark mới.
          </li>
          <li>
            <span className="font-semibold text-foreground">Auto-record</span> — phrase mới phát hiện được ghi vào DB
            kèm hitCount. Book kế tiếp cùng footer sẽ được strip ở bước (1).
          </li>
          <li>
            <span className="font-semibold text-foreground">User pre-seed</span> — thêm phrase thủ công ở trên nếu bạn
            biết trước footer nhà xuất bản.
          </li>
        </ol>
      </Card>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Field — consistent labelled form row used across every settings tab.
 *
 * Guarantees:
 *   - label + optional icon are always left-aligned on one baseline
 *   - the control sits directly below the label with a fixed 1.5 gap
 *   - help text + error share the same left inset as the control
 *   - `full` spans both columns of a 2-col grid; otherwise it occupies one
 *
 * Using this everywhere removes the ad-hoc `space-y-1.5` + hand-rolled label
 * drift that made fields mis-align between tabs.
 * ──────────────────────────────────────────────────────────────────────── */
function Field({
  label, icon, htmlFor, full, help, error, tooltip, children,
}: {
  label: string;
  icon?: ReactNode;
  htmlFor?: string;
  full?: boolean;
  help?: ReactNode;
  error?: string | null;
  /** When set, an info icon (ⓘ) appears next to the label and shows this
   *  text on hover/focus instead of always-visible helper text. */
  tooltip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', full && 'sm:col-span-2')}>
      <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        {label}
        {tooltip && (
          <Tooltip content={tooltip} side="top">
            <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        )}
      </label>
      {children}
      {help && !error && <p className="text-[10px] leading-relaxed text-muted-foreground">{help}</p>}
      {error && <p className="text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">{error}</p>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * ApiKeyField — shared API-key input row (AI + Image tabs).
 *
 * Renders the label, a password/text input, an optional "clear saved key"
 * button (only when a masked key is already stored), and a show/hide toggle
 * (only when a key is required). The "key đã lưu" confirmation badge appears
 * below the input so it never shifts the input's vertical alignment.
 * ──────────────────────────────────────────────────────────────────────── */
function ApiKeyField({
  id, label, value, masked, required, showKey, onToggleShow, onChange, onClear,
}: {
  id: string;
  label: string;
  value: string | null;
  masked: string | null;
  required: boolean;
  showKey: boolean;
  onToggleShow: () => void;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  return (
    <Field
      label={label}
      icon={<KeyRound className="h-3 w-3" />}
      htmlFor={id}
      full
      help={
        required
          ? (masked
              ? `Hiện đã lưu: ${masked} — nhập key mới để thay`
              : 'sk-...')
          : '(không cần cho provider này)'
      }
    >
      <div className="flex gap-2">
        <Input
          id={id}
          type={showKey ? 'text' : 'password'}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={required ? (masked ? `Hiện đã lưu: ${masked} — nhập key mới để thay` : 'sk-...') : '(không cần cho provider này)'}
          disabled={!required}
          className="flex-1 font-mono"
        />
        {required && masked && (
          <Button size="sm" variant="outline" type="button" onClick={onClear} title="Xoá key hiện tại" className="text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {required && (
          <Button size="sm" variant="ghost" type="button" onClick={onToggleShow} title={showKey ? 'Ẩn key' : 'Hiện key'}>
            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
        )}
      </div>
      {masked && (
        <div data-testid="api-key-saved-badge" className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          <Check className="h-3 w-3" />
          <span>
            Key đã lưu (<span className="font-mono">{masked}</span>) — để trống + Save sẽ giữ nguyên
          </span>
        </div>
      )}
    </Field>
  );
}

function ToggleRow({
  icon, label, description, checked, onChange, tooltip,
}: { icon: React.ReactNode; label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; tooltip?: ReactNode }) {
  return (
    <div
      onClick={() => onChange(!checked)}
      className={cn('w-full flex items-start gap-3 rounded-lg border border-border p-3 text-left transition-all cursor-pointer',
        checked ? 'bg-primary/5 ring-1 ring-primary/40 border-primary/20' : 'hover:bg-muted/30',
      )}>
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        checked ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-semibold">{label}</p>
          {tooltip && (
            <Tooltip content={tooltip} side="top">
              <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                <Info className="h-3 w-3" />
              </span>
            </Tooltip>
          )}
        </div>
        {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
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
