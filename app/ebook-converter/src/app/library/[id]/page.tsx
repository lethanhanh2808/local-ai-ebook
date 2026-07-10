// src/app/library/[id]/page.tsx
// Book-detail page: metadata + AI Illustrations panel + nav to /read & /edit.
//
// Before this page existed, /edit was the only place to "do something" with a
// book, but it's a chapter-editor — too cramped for AI-generation controls.
// This page is the natural hub for everything that isn't chapter-by-chapter
// editing: Read, Edit chapters, AI Illustrations. Voice Bible, Character
// Bible, and Audiobook panels will land here in follow-up commits.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BookOpen, PencilLine } from 'lucide-react';
import { getBook } from '@/lib/db/books';
import { IllustrationsPanel } from '@/components/library/IllustrationsPanel';
import { TitleViEditor } from '@/components/library/TitleViEditor';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/card';
import { buttonClasses } from '@/components/ui/button';

export async function generateMetadata({ params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  return { title: book ? book.title : 'Book' };
}

export default async function BookDetailPage({ params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  if (!book) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Library', href: '/library' },
          { label: book.title },
        ]}
        title={book.title}
        description={book.author ? `bởi ${book.author}` : undefined}
        actions={
          <>
            <Link
              href={`/library/${book.id}/read`}
              className={buttonClasses({ variant: 'outline', size: 'sm' })}
            >
              <BookOpen className="h-3.5 w-3.5 mr-1.5" /> Đọc
            </Link>
            <Link
              href={`/library/${book.id}/edit`}
              className={buttonClasses({ variant: 'outline', size: 'sm' })}
            >
              <PencilLine className="h-3.5 w-3.5 mr-1.5" /> Sửa chapters
            </Link>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 space-y-3">
          <h2 className="text-sm font-semibold">Thông tin</h2>
          <dl className="space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Tác giả</dt>
              <dd className="font-medium">{book.author || '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Ngôn ngữ</dt>
              <dd className="font-medium">{book.language?.toUpperCase() ?? '—'}</dd>
            </div>
            <div className="flex gap-2 items-start">
              <dt className="w-24 shrink-0 text-muted-foreground pt-1.5">Tiêu đề VN</dt>
              <dd className="flex-1 min-w-0">
                <TitleViEditor bookId={book.id} fallbackTitle={book.title} initialTitleVi={book.titleVi} />
              </dd>
            </div>
            {book.identifier && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">ISBN</dt>
                <dd className="font-mono text-[11px]">{book.identifier}</dd>
              </div>
            )}
            {book.series && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Series</dt>
                <dd className="font-medium">
                  {book.series}
                  {book.seriesIndex != null ? ` #${book.seriesIndex}` : ''}
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Trạng thái</dt>
              <dd className="font-medium">{readStatusLabel(book.readStatus)}</dd>
            </div>
            {book.lastRead && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Lần đọc cuối</dt>
                <dd className="font-medium">
                  {new Date(book.lastRead).toLocaleString()}
                </dd>
              </div>
            )}
          </dl>
        </Card>

        <IllustrationsPanel bookId={book.id} />
      </div>
    </div>
  );
}

function readStatusLabel(status: string | undefined | null) {
  switch (status) {
    case 'reading': return 'Đang đọc';
    case 'read':    return 'Đã đọc xong';
    case 'archived': return 'Đã lưu trữ';
    default:         return 'Chưa đọc';
  }
}
