import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { AUTH_DEFAULT_PASSWORD, AUTH_DEFAULT_USERNAME, AUTH_SESSION_COOKIE, createSessionToken, hashPassword, verifyPassword } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as { username?: string; password?: string };
    const username = (body.username ?? '').trim();
    const password = body.password ?? '';

    if (!username || !password) {
      return NextResponse.json({ ok: false, error: 'Username and password are required.' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.passwordHash) {
      const isDefaultAdmin = username === AUTH_DEFAULT_USERNAME && password === AUTH_DEFAULT_PASSWORD;
      if (!isDefaultAdmin) {
        return NextResponse.json({ ok: false, error: 'Invalid username or password.' }, { status: 401 });
      }
      const passwordHash = await hashPassword(AUTH_DEFAULT_PASSWORD);
      const createdUser = await prisma.user.upsert({
        where: { username: AUTH_DEFAULT_USERNAME },
        update: { passwordHash },
        create: {
          username: AUTH_DEFAULT_USERNAME,
          name: 'Local admin',
          email: 'admin@local',
          role: 'ADMIN',
          passwordHash,
        },
      });
      const token = createSessionToken(createdUser.id);
      const response = NextResponse.json({ ok: true, user: { id: createdUser.id, username: createdUser.username, name: createdUser.name, role: createdUser.role } });
      response.cookies.set(AUTH_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
      return response;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ ok: false, error: 'Invalid username or password.' }, { status: 401 });
    }

    const token = createSessionToken(user.id);
    await writeAuditLog({ action: 'login_success', actorId: user.id, targetUserId: user.id, details: 'User login succeeded' });
    const response = NextResponse.json({ ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    response.cookies.set(AUTH_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
    return response;
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
