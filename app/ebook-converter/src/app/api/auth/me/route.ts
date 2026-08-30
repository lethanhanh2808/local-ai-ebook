import { NextRequest, NextResponse } from 'next/server';
import { resolveAuthenticatedUserFromRequest } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await resolveAuthenticatedUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ ok: false, authenticated: false }, { status: 401 });
  }

  return NextResponse.json({ ok: true, authenticated: true, user });
}
