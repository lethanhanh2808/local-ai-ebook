// src/app/api/validate/route.ts
// POST /api/validate – quick EPUB structure check (no AI, no queue)
import { NextRequest, NextResponse } from 'next/server';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { validateEpub } from '@/lib/pipeline/epub-validator';
import { ensureDirs, uploadPath } from '@/lib/storage';
import { v4 as uuid } from 'uuid';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    ensureDirs();
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });
    if (!file.name.endsWith('.epub')) {
      return NextResponse.json({ error: 'Only EPUB validation is supported' }, { status: 415 });
    }

    const tempId = uuid();
    const tempPath = uploadPath(tempId, file.name);
    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(tempPath, buf);

    let result;
    try {
      const epub = await parseEpub(tempPath);
      result = validateEpub(epub);
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
