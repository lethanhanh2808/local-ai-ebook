import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { resolveAuthenticatedUserFromRequest } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await resolveAuthenticatedUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const profile = await prisma.user.findUnique({
    where: { id: user.id },
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

  return NextResponse.json({ ok: true, profile });
}

export async function PUT(req: NextRequest) {
  const actor = await resolveAuthenticatedUserFromRequest(req);
  if (!actor) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as {
    name?: string;
    email?: string;
    password?: string;
  };

  const nextName = (body.name ?? '').trim();
  const nextEmail = (body.email ?? '').trim() || null;
  const nextPassword = body.password?.trim() ? body.password.trim() : null;

  const updates: { name?: string; email?: string | null; passwordHash?: string } = {};
  if (nextName) updates.name = nextName;
  if (body.email !== undefined) updates.email = nextEmail;
  if (nextPassword) {
    const { hashPassword } = await import('@/lib/auth/session');
    updates.passwordHash = await hashPassword(nextPassword);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: 'No profile changes supplied.' }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id: actor.id },
    data: updates,
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      role: true,
      updatedAt: true,
    },
  });

  await writeAuditLog({
    action: 'profile_updated',
    actorId: actor.id,
    targetUserId: actor.id,
    details: `Updated profile fields: ${Object.keys(updates).join(', ')}`,
  });

  return NextResponse.json({ ok: true, user });
}
