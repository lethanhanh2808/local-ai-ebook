// src/app/api/library/[id]/cover/route.ts
// GET /api/library/:id/cover – serve cover image or generated SVG placeholder
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { resolveCoverPath } from '@/lib/storage';

/** Generate a deterministic color from a string */
function strToHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** Wrap text into lines of maxChars */
function wrapText(text: string, maxChars = 18): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > maxChars) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4); // max 4 lines
}

function generateCoverSvg(title: string, author: string): string {
  const hue = strToHue(title);
  const hue2 = (hue + 35) % 360;
  const titleLines = wrapText(title, 18);
  const authorLines = wrapText(author, 22);
  const titleY = 200 - (titleLines.length - 1) * 18;

  const titleSvg = titleLines
    .map((l, i) => `<text x="150" y="${titleY + i * 38}" text-anchor="middle" fill="white" font-size="26" font-weight="bold" font-family="Georgia,serif">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text>`)
    .join('\n  ');
  const authorSvg = authorLines
    .map((l, i) => `<text x="150" y="${titleY + titleLines.length * 38 + 28 + i * 22}" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="17" font-family="Arial,sans-serif">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text>`)
    .join('\n  ');

  const dividerY = titleY + titleLines.length * 38 + 14;

  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},55%,22%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},45%,38%)"/>
    </linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="300" height="450" fill="url(#bg)"/>
  <!-- Decorative circle -->
  <circle cx="150" cy="140" r="70" fill="rgba(255,255,255,0.05)" filter="url(#glow)"/>
  <circle cx="150" cy="140" r="48" fill="rgba(255,255,255,0.08)"/>
  <!-- Book icon -->
  <text x="150" y="157" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="48">📖</text>
  <!-- Border -->
  <rect x="16" y="16" width="268" height="418" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1" rx="4"/>
  <!-- Title -->
  ${titleSvg}
  <!-- Divider -->
  <line x1="60" y1="${dividerY}" x2="240" y2="${dividerY}" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
  <!-- Author -->
  ${authorSvg}
</svg>`;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return new NextResponse(null, { status: 404 });

  // Serve stored cover if available
  const storedCover = await resolveCoverPath(book);
  if (storedCover && fs.existsSync(storedCover)) {
    const ext = path.extname(storedCover).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'svg' ? 'image/svg+xml'
      : ext === 'webp' ? 'image/webp'
      : 'image/jpeg';
    const buf = fs.readFileSync(storedCover);
    // BUGFIX 2026-07-11: covers are explicitly user-regenerable, so the
    // previous `max-age=86400` (24h) cache meant a BookCard remounting
    // after navigation served the OLD response from browser cache — even
    // though the on-disk PNG had been replaced. Switch to `no-cache,
    // must-revalidate` so the browser re-validates on every navigation
    // but still benefits from a `304 Not Modified` round-trip when the
    // file hasn't changed. The ETag header (auto-set by Next.js on a
    // Buffer-backed response) makes the 304 cheap.
    return new NextResponse(buf, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'no-cache, must-revalidate',
      },
    });
  }

  // Generate SVG placeholder
  const svg = generateCoverSvg(book.title, book.author);
  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
