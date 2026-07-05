#!/usr/bin/env tsx
// scripts/e2e-preflight.ts
// Fail-fast checks for local Playwright runs.

const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function fetchJson(path: string, timeoutMs = 5_000): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${path}`, { signal: controller.signal });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

async function main() {
  const results = await Promise.all([
    check('Next.js + library API', async () => {
      const { status, json } = await fetchJson('/api/library?limit=1');
      if (status !== 200) throw new Error(`HTTP ${status}`);
      if (!Array.isArray(json)) throw new Error('response is not an array');
      return `${json.length} book(s) returned`;
    }),
    check('Worker + Redis', async () => {
      const { status, json } = await fetchJson('/api/worker/status');
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const body = asRecord(json);
      if (body.redis !== true) throw new Error('Redis is not reachable');
      if (body.online !== true) throw new Error('Worker is not online');
      return 'worker online, Redis ok';
    }),
    check('Unified TTS + VieNeu', async () => {
      const { status, json } = await fetchJson('/api/tts/health');
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const body = asRecord(json);
      if (body.ok !== true) throw new Error(String(body.recommendation ?? 'TTS health is not ok'));
      const services = asRecord(body.services);
      if (services.vieneu !== true) throw new Error('VieNeu backend is not ready');
      return 'VieNeu ready';
    }),
    check('Settings API', async () => {
      const { status, json } = await fetchJson('/api/settings');
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const body = asRecord(json);
      if (!body.aiProvider) throw new Error('missing aiProvider');
      return `AI provider: ${body.aiProvider}`;
    }),
  ]);

  console.log(`E2E preflight for ${BASE_URL}`);
  for (const result of results) {
    console.log(`${result.ok ? '✓' : '✗'} ${result.name}: ${result.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error('\nPreflight failed. Start the full local stack first:');
    console.error('  cd /Volumes/EXT-SSD/Users/anhl/Local-AI');
    console.error('  ./scripts/start_full_app.sh --background');
    console.error('  ./scripts/start_full_app.sh --status');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
