import { NextResponse } from 'next/server';
import { AUTH_SESSION_COOKIE } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_SESSION_COOKIE, '', { httpOnly: true, path: '/', sameSite: 'lax', maxAge: 0 });
  return response;
}
