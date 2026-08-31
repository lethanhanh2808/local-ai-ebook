// src/lib/db/books.ts
// CRUD helpers for the Book (library) model
import fs from 'fs';
import { prisma } from './client';

export interface CreateBookInput {
  id?: string;
  title: string;
  author: string;
  language?: string;
  description?: string;
  publisher?: string;
  publishDate?: string;
  identifier?: string;
  series?: string;
  seriesIndex?: number;
  rating?: number;
  coverPath?: string;
  filePath: string;
  fileSize: number;
  originalFilename: string;
  tags?: string[];
  notes?: string;
  readStatus?: string;
  isFavorite?: boolean;
}

export async function createBook(input: CreateBookInput) {
  const { tags, id, ...rest } = input;
  const book = await prisma.book.create({
    data: {
      ...(id ? { id } : {}),
      ...rest,
      language: rest.language ?? 'vi',
      tags: tags ? JSON.stringify(tags) : null,
    },
  });
  return hydrateBook(book);
}

export async function listBooks(opts?: {
  search?: string;
  language?: string;
  series?: string;
  readStatus?: string;
  tags?: string;
  isFavorite?: boolean;
  limit?: number;
}) {
  const { search, language, series, readStatus, isFavorite, limit = 200 } = opts ?? {};
  const books = await prisma.book.findMany({
    orderBy: { addedAt: 'desc' },
    take: limit,
    where: {
      ...(language ? { language } : {}),
      ...(series ? { series: { contains: series } } : {}),
      ...(readStatus ? { readStatus } : {}),
      ...(isFavorite !== undefined ? { isFavorite } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search } },
              { author: { contains: search } },
              { series: { contains: search } },
            ],
          }
        : {}),
    },
  });
  return books.map(hydrateBook);
}

export async function getBook(id: string) {
  const book = await prisma.book.findUnique({ where: { id } });
  if (!book) return null;
  return hydrateBook(book);
}

export async function updateBook(
  id: string,
  data: Partial<{
    title: string;
    titleVi: string | null;
    author: string;
    language: string;
    description: string | null;
    publisher: string | null;
    publishDate: string | null;
    identifier: string | null;
    series: string | null;
    seriesIndex: number | null;
    rating: number | null;
    tags: string[];
    notes: string | null;
    readProgress: number;
    readStatus: string;
    isFavorite: boolean;
    lastRead: Date | null;
    coverPath: string | null;
    // File-related fields — only set by the in-place editor save.
    // (Save-As creates a brand-new Book row instead.)
    filePath: string;
    fileSize: number;
    originalFilename: string;
  }>,
) {
  const { tags, ...rest } = data;
  const book = await prisma.book.update({
    where: { id },
    data: {
      ...rest,
      ...(tags !== undefined ? { tags: JSON.stringify(tags) } : {}),
    },
  });
  return hydrateBook(book);
}

export async function deleteBook(id: string) {
  return prisma.book.delete({ where: { id } });
}

export async function updateBookWatermarks(id: string, watermarks: string[]) {
  // Use raw SQL to avoid Prisma cached-type issues after schema migration
  await prisma.$executeRawUnsafe(
    'UPDATE "Book" SET watermarks = ?, updatedAt = datetime(\'now\') WHERE id = ?',
    JSON.stringify(watermarks),
    id,
  );
  const book = await getBook(id);
  return book;
}

export async function getBookWatermarks(id: string): Promise<string[]> {
  try {
    // Use raw SQL to avoid Prisma cached-type issues after schema migration
    const rows = await prisma.$queryRawUnsafe<{ watermarks: string | null }[]>(
      'SELECT watermarks FROM "Book" WHERE id = ? LIMIT 1',
      id,
    );
    if (!rows.length) return [];
    return JSON.parse(rows[0].watermarks ?? '[]') as string[];
  } catch {
    return [];
  }
}

// ── Shelves ───────────────────────────────────────────────────────────────────

export async function listShelves() {
  const shelves = await prisma.shelf.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      books: {
        orderBy: { position: 'asc' },
        take: 4,
        include: { book: { select: { id: true, coverPath: true, readStatus: true } } },
      },
      _count: { select: { books: true } },
    },
  });
  return shelves.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    isPublic: s.isPublic,
    sortOrder: s.sortOrder,
    bookCount: s._count.books,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    previewBooks: s.books.map((sb) => ({
      id: sb.book.id,
      hasCover: !!sb.book.coverPath,
      readStatus: sb.book.readStatus,
    })),
    readingCount: s.books.filter((sb) => sb.book.readStatus === 'reading').length,
  }));
}

export async function getShelf(id: string) {
  const shelf = await prisma.shelf.findUnique({
    where: { id },
    include: { books: { orderBy: { position: 'asc' }, include: { book: true } } },
  });
  if (!shelf) return null;
  return {
    id: shelf.id,
    name: shelf.name,
    description: shelf.description,
    isPublic: shelf.isPublic,
    sortOrder: shelf.sortOrder,
    books: shelf.books.map((sb) => hydrateBook(sb.book)),
    createdAt: shelf.createdAt.toISOString(),
  };
}

export async function createShelf(input: { name: string; description?: string; isPublic?: boolean }) {
  const shelf = await prisma.shelf.create({ data: input });
  return shelf;
}

export async function updateShelf(id: string, data: Partial<{ name: string; description: string; isPublic: boolean; sortOrder: number }>) {
  return prisma.shelf.update({ where: { id }, data });
}

export async function deleteShelf(id: string) {
  return prisma.shelf.delete({ where: { id } });
}

export async function addBookToShelf(shelfId: string, bookId: string) {
  return prisma.shelfBook.upsert({
    where: { shelfId_bookId: { shelfId, bookId } },
    create: { shelfId, bookId },
    update: {},
  });
}

export async function removeBookFromShelf(shelfId: string, bookId: string) {
  // Idempotent delete keeps repeated UI actions/retries from surfacing as
  // Prisma P2025 errors.
  return prisma.shelfBook.deleteMany({ where: { shelfId, bookId } });
}

// ── Library stats ─────────────────────────────────────────────────────────────

export async function getLibraryStats() {
  const [total, recentlyRead, allBooks] = await Promise.all([
    prisma.book.count(),
    prisma.book.findMany({
      where: { lastRead: { not: null } },
      orderBy: { lastRead: 'desc' },
      take: 5,
      select: { id: true, title: true, lastRead: true, readProgress: true },
    }),
    prisma.book.findMany({ select: { readStatus: true, language: true } }),
  ]);

  // Compute groupBy manually to avoid Prisma SQLite groupBy issues
  const byStatusMap: Record<string, number> = {};
  const byLanguageMap: Record<string, number> = {};
  for (const b of allBooks) {
    const s = (b.readStatus as string) ?? 'unread';
    byStatusMap[s] = (byStatusMap[s] ?? 0) + 1;
    const l = b.language ?? 'unknown';
    byLanguageMap[l] = (byLanguageMap[l] ?? 0) + 1;
  }

  const byStatus = Object.entries(byStatusMap).map(([readStatus, _count]) => ({ readStatus, _count }));
  const byLanguage = Object.entries(byLanguageMap).map(([language, _count]) => ({ language, _count }));

  return { total, byStatus, byLanguage, recentlyRead };
}

function hydrateBook(book: {
  id: string;
  title: string;
  titleVi?: string | null;
  author: string;
  language: string;
  description: string | null;
  publisher: string | null;
  publishDate: string | null;
  identifier: string | null;
  series?: string | null;
  seriesIndex?: number | null;
  rating?: number | null;
  coverPath: string | null;
  filePath: string;
  fileSize: number;
  originalFilename: string;
  tags: string | null;
  notes: string | null;
  watermarks?: string | null;
  readProgress: number;
  readStatus?: string;
  isFavorite?: boolean;
  lastRead: Date | null;
  addedAt: Date;
  updatedAt: Date;
}) {
  return {
    ...book,
    titleVi: book.titleVi ?? null,
    tags: book.tags ? (JSON.parse(book.tags) as string[]) : [],
    watermarks: book.watermarks ? (JSON.parse(book.watermarks) as string[]) : [],
    series: book.series ?? null,
    seriesIndex: book.seriesIndex ?? null,
    rating: book.rating ?? null,
    readStatus: book.readStatus ?? 'unread',
    isFavorite: book.isFavorite ?? false,
    addedAt: book.addedAt.toISOString(),
    updatedAt: book.updatedAt.toISOString(),
    lastRead: book.lastRead?.toISOString() ?? null,
    // `hasCover` lets the UI surface a visible "Generate cover" action on
    // books whose cover file is missing on disk (e.g. the cover was still
    // being extracted when the book was registered, or extraction failed).
    // We resolve the stored path and check the file exists rather than
    // trusting the non-null `coverPath`, because a stale/placeholder SVG is
    // served when the file is absent — the user sees no cover at all.
    hasCover: book.coverPath ? fs.existsSync(book.coverPath) : false,
  };
}
