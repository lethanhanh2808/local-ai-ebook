// src/app/stats/page.tsx – Library statistics dashboard
import { BarChart3 } from 'lucide-react';
import { StatsView } from '@/components/library/StatsView';
import { PageHeader } from '@/components/layout/PageHeader';

export const metadata = { title: 'Statistics — Ebook Manager' };

export default function StatsPage() {
  return (
    <div className="mx-auto w-full max-w-canvas px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
      <PageHeader
        eyebrow="Phân tích"
        title="Thống kê thư viện"
        description="Tổng quan về hoạt động đọc và thư viện của bạn."
        icon={<BarChart3 className="h-4 w-4" />}
      />
      <StatsView />
    </div>
  );
}