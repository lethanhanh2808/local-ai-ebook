// src/app/stats/page.tsx – Library statistics dashboard
import { BarChart3 } from 'lucide-react';
import { StatsView } from '@/components/library/StatsView';
import { PageHeader } from '@/components/layout/PageHeader';

export const metadata = { title: 'Statistics — Ebook Manager' };

export default function StatsPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
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