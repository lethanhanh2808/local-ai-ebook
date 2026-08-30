'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Loader2, LogIn, ShieldCheck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (res.ok) router.replace('/');
      } catch {
        // ignore and show login
      }
    };
    void check();
  }, [router]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: 'Login failed.' }));
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? 'Login failed.');
      }
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-5xl items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md overflow-hidden border border-border/80 bg-background/90 shadow-xl">
        <div className="border-b border-border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-6">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Local AI Ebook</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">Use the local admin account to access the app and settings. We recommend changing the default password after your first sign-in.</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 p-6">
          <div className="space-y-2">
            <label htmlFor="username" className="text-xs font-medium">Username</label>
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-xs font-medium">Password</label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="admin123" autoComplete="current-password" />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogIn className="mr-2 h-4 w-4" />}
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>

          <div className="rounded-md border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <Lock className="h-3.5 w-3.5" />
              Default local admin
            </div>
            <div className="mt-2 flex justify-between gap-3">
              <span>Username</span>
              <span className="font-mono">admin</span>
            </div>
            <div className="mt-1 flex justify-between gap-3">
              <span>Password</span>
              <span className="font-mono">admin123</span>
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}
