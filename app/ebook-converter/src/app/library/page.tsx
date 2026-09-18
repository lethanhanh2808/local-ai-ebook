// src/app/library/page.tsx – Full library page
'use client';

import { Library, BookOpen } from 'lucide-react';
import { BookGrid } from '@/components/library/BookGrid';
import { PageHeader } from '@/components/layout/PageHeader';

export default function LibraryPage() {
  return (
    <div className="mx-auto w-full max-w-canvas px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
      <PageHeader
        eyebrow="Thư viện"
        title="Tất cả sách"
        description="Tìm kiếm, lọc, và quản lý toàn bộ thư viện ebook của bạn."
        icon={<Library className="h-4 w-4" />}
      />
      <BookGrid />
    </div>
  );
}