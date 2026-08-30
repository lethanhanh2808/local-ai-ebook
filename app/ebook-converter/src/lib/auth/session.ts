import crypto from 'crypto';
import { prisma } from '@/lib/db/client';
import { normalizeUserRole } from '@/lib/db/settings';

export const AUTH_SESSION_COOKIE = 'ebook-auth-session';
export const AUTH_DEFAULT_USERNAME = 'admin';
export const AUTH_DEFAULT_PASSWORD = 'admin123';
export const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export function parseCookieValue(cookieHeader: string | null | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  const section = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (!section) return null;
  const raw = section.slice(cookieName.length + 1);
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw || null;
  }
}

export function createSessionToken(userId: string): string {
  const secret = process.env.SESSION_SECRET ?? 'local-ai-ebook-dev-secret';
  const payload = Buffer.from(JSON.stringify({
    userId,
    exp: Date.now() + AUTH_SESSION_TTL_MS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string | null | undefined): { userId: string } | null {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const secret = process.env.SESSION_SECRET ?? 'local-ai-ebook-dev-secret';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { userId?: string; exp?: number };
    if (!decoded.userId || typeof decoded.exp !== 'number' || Date.now() > decoded.exp) {
      return null;
    }
    return { userId: decoded.userId };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || !hash.includes(':')) return false;
  const [salt, storedHash] = hash.split(':', 2);
  if (!salt || !storedHash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(derived, 'hex'));
}

export async function ensureLocalAdminUser() {
  let user = await prisma.user.findUnique({
    where: { username: AUTH_DEFAULT_USERNAME },
  });

  if (!user) {
    const passwordHash = await hashPassword(AUTH_DEFAULT_PASSWORD);
    user = await prisma.user.create({
      data: {
        username: AUTH_DEFAULT_USERNAME,
        name: 'Local admin',
        email: 'admin@local',
        role: 'ADMIN',
        passwordHash,
      },
    });
    return user;
  }

  if (!user.passwordHash) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(AUTH_DEFAULT_PASSWORD) },
    });
    user = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  }

  return user;
}

export async function resolveAuthenticatedUserFromRequest(req: Request | { headers: Headers | { get(name: string): string | null } }): Promise<{ id: string; name: string; username: string; email: string | null; role: string } | null> {
  const cookieHeader = typeof req.headers?.get === 'function' ? req.headers.get('cookie') : null;
  const token = parseCookieValue(cookieHeader, AUTH_SESSION_COOKIE);
  const session = token ? verifySessionToken(token) : null;
  if (!session) return null;

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: normalizeUserRole(user.role),
  };
}
