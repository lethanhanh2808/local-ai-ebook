// src/app/api/tools/calibre/route.ts
// GET /api/tools/calibre?force=0|1
//
// Phase 4.3 of docs/NEXT_UP_PLAN.md — thin wrapper over probeCalibre().
// Returns the wire shape consumed by:
//   - CalibrePanel in src/components/status/CalibrePanel.tsx
//   - UploadZone in src/components/jobs/UploadZone.tsx (reactive accept types)
//   - convert page in src/app/convert/page.tsx (SUPPORTED_FORMATS row)
//
// Per-process cache (60s TTL) inside probeCalibre(); this route does NOT
// set its own Cache-Control header because the UI owns its refresh cadence.
// The `?force=1` query param triggers a fresh probe (used by the
// "Re-check" button on the Settings → Importers tab).

import { NextRequest, NextResponse } from 'next/server';
import { probeCalibre } from '@/lib/tools/calibre';
import { CALIBRE_FORMATS } from '@/lib/tools/calibre-formats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INSTALL_URL = 'https://calibre-ebook.com/download';

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get('force') === '1';
  const probe = await probeCalibre(force);

  const body = {
    ok: probe.ok,
    path: probe.path,
    version: probe.version,
    error: probe.error,
    checkedAt: probe.checkedAt,
    formats: CALIBRE_FORMATS.map((f) => ({
      extension: f.extension,
      mimeTypes: f.mimeTypes,
      description: f.description,
      requiresOcr: f.requiresOcr,
    })),
    bannerText: probe.ok
      ? null
      : 'Calibre (ebook-convert) chưa cài — PDF/DOCX/MOBI/AZW3 sẽ bị tắt cho đến khi bạn cài đặt.',
    installUrl: INSTALL_URL,
  };

  return NextResponse.json(body, { status: probe.ok ? 200 : 503 });
}
