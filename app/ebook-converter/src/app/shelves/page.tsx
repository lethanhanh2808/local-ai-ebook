// src/app/shelves/page.tsx – Reading lists / Shelves management
//
// Calm, library-style landing page for curated collections. Each shelf is
// rendered as a horizontal "book" card: subtle gradient spine on the left,
// the title and metadata on the right, with a small stack of actual book
// covers (or initials) as the visual focal point. No saturated 2010s
// gradients, no chrome — just typography, white space, and quiet accents.
import { Suspense } from 'react';
import { BookMarked } from 'lucide-react';
import { ShelvesView } from '@/components/library/ShelvesView';
import { PageHeader } from '@/components/layout/PageHeader';

export const metadata = { title: 'Shelves — Ebook Manager' };

export default function ShelvesPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <PageHeader
        eyebrow="Bộ sưu tập"
        title="Shelves"
        description="Những bộ sưu tập bạn tự tạo — gom sách theo chủ đề, series hoặc tâm trạng."
        icon={<BookMarked className="h-4 w-4" />}
      />
      <Suspense fallback={<div className="h-48 animate-pulse rounded-xl bg-muted" />}>
        <ShelvesView />
      </Suspense>
    </div>
  );
}