// src/app/shelves/page.tsx – Reading lists / Shelves management
import { Suspense } from 'react';
import { BookMarked } from 'lucide-react';
import { ShelvesView } from '@/components/library/ShelvesView';
import { PageHeader } from '@/components/layout/PageHeader';

export const metadata = { title: 'Shelves — Ebook Manager' };

export default function ShelvesPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <PageHeader
        eyebrow="Bộ sưu tập"
        title="Shelves"
        description="Tổ chức sách theo bộ sưu tập tuỳ chỉnh — giống Calibre shelves."
        icon={<BookMarked className="h-4 w-4" />}
      />
      <Suspense fallback={<div className="h-48 animate-pulse rounded-xl bg-muted" />}>
        <ShelvesView />
      </Suspense>
    </div>
  );
}