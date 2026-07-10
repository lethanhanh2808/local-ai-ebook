// src/app/api/library/[id]/route.ts
// GET    /api/library/:id  – book details
// PATCH  /api/library/:id  – update tags/notes/readProgress
// DELETE /api/library/:id  – remove from library (file stays on disk unless purge=1)
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook, updateBook, deleteBook } from '@/lib/db/books';
import { assertWithinRoots, pathRoots, SafePathError } from '@/lib/storage/safe-path';

const READ_STATUSES = new Set(['unread', 'reading', 'read', 'archived']);

class ValidationError extends Error {}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new ValidationError(`${field} is too long`);
  return trimmed;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(book);
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const body = await req.json() as Record<string, unknown>;
    const data: Parameters<typeof updateBook>[1] = {};

    if ('title' in body) {
      if (typeof body.title !== 'string' || !body.title.trim()) {
        throw new ValidationError('title must not be empty');
      }
      if (body.title.trim().length > 500) throw new ValidationError('title is too long');
      data.title = body.title.trim();
    }
    if ('titleVi' in body) data.titleVi = optionalText(body.titleVi, 'titleVi', 500);
    if ('author' in body) {
      if (typeof body.author !== 'string') throw new ValidationError('author must be a string');
      if (body.author.trim().length > 300) throw new ValidationError('author is too long');
      data.author = body.author.trim() || 'Unknown';
    }
    if ('language' in body) {
      if (typeof body.language !== 'string' || !/^(?:[a-z]{2,8}(?:-[a-z0-9]{1,8})*|mixed)$/i.test(body.language.trim())) {
        throw new ValidationError('language must be a valid language tag');
      }
      data.language = body.language.trim().toLowerCase();
    }

    for (const [field, limit] of [
      ['description', 20_000],
      ['publisher', 500],
      ['publishDate', 100],
      ['identifier', 300],
      ['series', 500],
      ['notes', 20_000],
    ] as const) {
      if (field in body) data[field] = optionalText(body[field], field, limit);
    }

    if ('seriesIndex' in body) {
      if (body.seriesIndex === null || body.seriesIndex === '') data.seriesIndex = null;
      else if (typeof body.seriesIndex !== 'number' || !Number.isFinite(body.seriesIndex) || body.seriesIndex < 0) {
        throw new ValidationError('seriesIndex must be a non-negative number or null');
      } else data.seriesIndex = body.seriesIndex;
    }
    if ('rating' in body) {
      if (body.rating === null || body.rating === 0 || body.rating === '') data.rating = null;
      else if (typeof body.rating !== 'number' || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 10) {
        throw new ValidationError('rating must be an integer from 1 to 10 or null');
      } else data.rating = body.rating;
    }
    if ('tags' in body) {
      if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === 'string')) {
        throw new ValidationError('tags must be an array of strings');
      }
      const tags = [...new Set(body.tags.map((tag) => tag.trim()).filter(Boolean))];
      if (tags.length > 100 || tags.some((tag) => tag.length > 100)) {
        throw new ValidationError('tags contain too many or overly long values');
      }
      data.tags = tags;
    }
    if ('readProgress' in body) {
      if (typeof body.readProgress !== 'number' || !Number.isFinite(body.readProgress)) {
        throw new ValidationError('readProgress must be a number');
      }
      data.readProgress = Math.round(Math.max(0, Math.min(100, body.readProgress)));
    }
    if ('readStatus' in body) {
      if (typeof body.readStatus !== 'string' || !READ_STATUSES.has(body.readStatus)) {
        throw new ValidationError('readStatus is invalid');
      }
      data.readStatus = body.readStatus;
    }
    if ('isFavorite' in body) {
      if (typeof body.isFavorite !== 'boolean') throw new ValidationError('isFavorite must be a boolean');
      data.isFavorite = body.isFavorite;
    }
    if ('lastRead' in body) {
      if (body.lastRead === null || body.lastRead === '') data.lastRead = null;
      else if (typeof body.lastRead !== 'string') throw new ValidationError('lastRead must be an ISO date or null');
      else {
        const parsed = new Date(body.lastRead);
        if (Number.isNaN(parsed.getTime())) throw new ValidationError('lastRead must be a valid date');
        data.lastRead = parsed;
      }
    }

    const updated = await updateBook(params.id, data);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message || 'Invalid JSON body' }, { status: 400 });
    }
    throw error;
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const purge = req.nextUrl.searchParams.get('purge') === '1';
  const roots = pathRoots();
  if (purge) {
    try {
      const filePath = assertWithinRoots(book.filePath, [roots.library]);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
      if (!(error instanceof SafePathError)) throw error;
    }
  }
  if (book.coverPath) {
    try {
      const cover = assertWithinRoots(book.coverPath, [roots.library]);
      if (fs.existsSync(cover)) fs.unlinkSync(cover);
    } catch (error) {
      if (!(error instanceof SafePathError)) throw error;
    }
  }

  // Voice and audiobook rows cascade with the Book record; remove their
  // corresponding per-book directories at the same time so no inaccessible
  // media accumulates on disk.
  for (const [root, dir] of [
    [roots.voices, path.join(roots.voices, book.id)],
    [roots.audiobooks, path.join(roots.audiobooks, book.id)],
  ] as const) {
    const safeDir = assertWithinRoots(dir, [root]);
    fs.rmSync(safeDir, { recursive: true, force: true });
  }

  await deleteBook(params.id);
  return NextResponse.json({ ok: true });
}
