'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function AppAuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (pathname === '/login') return;

    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!cancelled && !res.ok) {
          router.replace('/login');
        }
      } catch {
        if (!cancelled) {
          router.replace('/login');
        }
      }
    };

    void check();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return <>{children}</>;
}
