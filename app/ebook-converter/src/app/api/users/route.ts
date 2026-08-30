import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { resolveAuthenticatedUserFromRequest, AUTH_DEFAULT_PASSWORD, AUTH_DEFAULT_USERNAME, hashPassword } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sessionUser = await resolveAuthenticatedUserFromRequest(req);
  if (!sessionUser) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (sessionUser.role !== 'ADMIN') {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ ok: true, users });
}

export async function POST(req: NextRequest) {
  const sessionUser = await resolveAuthenticatedUserFromRequest(req);
  if (!sessionUser) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (sessionUser.role !== 'ADMIN') {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as {
    username?: string;
    name?: string;
    email?: string;
    password?: string;
    role?: string;
  };

  const username = (body.username ?? '').trim();
  const name = ((body.name ?? username) || 'New user').trim();
  const email = (body.email ?? '').trim() || null;
  const password = body.password ?? AUTH_DEFAULT_PASSWORD;
  const role = (body.role ?? 'USER').toUpperCase();

  if (!username) {
    return NextResponse.json({ ok: false, error: 'Username is required.' }, { status: 400 });
  }

  if (role !== 'ADMIN' && role !== 'USER') {
    return NextResponse.json({ ok: false, error: 'Role must be ADMIN or USER.' }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ ok: false, error: 'User already exists.' }, { status: 409 });
  }

  const user = await prisma.user.create({
    data: {
      username,
      name,
      email,
      role,
      passwordHash: await hashPassword(password),
    },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });

  await writeAuditLog({
    action: 'user_created',
    actorId: sessionUser.id,
    targetUserId: user.id,
    details: `Created user ${user.username} with role ${user.role}`,
  });

  return NextResponse.json({ ok: true, user });
}
