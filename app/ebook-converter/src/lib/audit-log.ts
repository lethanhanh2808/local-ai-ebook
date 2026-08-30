import { prisma } from '@/lib/db/client';

export type AuditAction =
  | 'user_created'
  | 'user_updated'
  | 'user_deleted'
  | 'settings_updated'
  | 'profile_updated'
  | 'login_success'
  | 'logout';

export async function writeAuditLog(args: {
  action: AuditAction;
  actorId?: string | null;
  targetUserId?: string | null;
  details?: string | null;
}) {
  const { action, actorId, targetUserId, details } = args;
  if (!action) return null;
  return prisma.auditLog.create({
    data: {
      action,
      actorId: actorId ?? null,
      targetUserId: targetUserId ?? null,
      details: details ?? null,
    },
  });
}

export async function listAuditLogs(limit = 50) {
  return prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      actor: { select: { id: true, username: true, name: true, role: true } },
      targetUser: { select: { id: true, username: true, name: true, role: true } },
    },
  });
}
