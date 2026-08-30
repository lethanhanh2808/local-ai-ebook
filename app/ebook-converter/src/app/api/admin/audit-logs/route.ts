import { NextRequest, NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/audit-log';
import { resolveAuthenticatedUserFromRequest } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await resolveAuthenticatedUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const logs = await listAuditLogs(50);
  return NextResponse.json({ ok: true, logs });
}
