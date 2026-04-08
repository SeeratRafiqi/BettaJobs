import { Request, Response, NextFunction } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';

export type UserRole = 'admin' | 'candidate' | 'company';

export type AuthProvider = 'local' | 'google';

/** Attached to `req.user` after JWT verification (password is never in the token). */
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  email: string;
  name: string;
  avatar: string | null;
  googleId: string | null;
  email_verified: boolean;
  /** Set from JWT; omit on raw DB/Passport user until you attach claims */
  auth_provider?: AuthProvider;
}

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

/** Request after authenticateToken / optionalAuth (req.user is AuthUser when set). */
export type AuthRequest = Request;

export function isUserRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'candidate' || value === 'company';
}

/** Standard access-token claims (local login, refresh, and Google OAuth callback should all issue this shape). */
export interface JwtAccessClaims {
  id: string;
  username: string;
  role: UserRole;
  email: string;
  name: string;
  avatar: string | null;
  googleId: string | null;
  email_verified: boolean;
  auth_provider: AuthProvider;
}

export function buildJwtAccessClaims(user: {
  id: string;
  username: string;
  role: UserRole;
  email: string;
  name: string;
  avatar?: string | null;
  googleId?: string | null;
  email_verified?: boolean;
}): JwtAccessClaims {
  const googleId = user.googleId ?? null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email,
    name: user.name,
    avatar: user.avatar ?? null,
    googleId,
    email_verified: user.email_verified ?? false,
    auth_provider: googleId ? 'google' : 'local',
  };
}

function jwtPayloadToAuthUser(payload: JwtPayload): AuthUser | null {
  const d = payload as Record<string, unknown>;
  if (
    typeof d.id !== 'string' ||
    typeof d.username !== 'string' ||
    typeof d.email !== 'string' ||
    typeof d.name !== 'string' ||
    !isUserRole(d.role)
  ) {
    return null;
  }
  const googleId = typeof d.googleId === 'string' ? d.googleId : null;
  return {
    id: d.id,
    username: d.username,
    role: d.role,
    email: d.email,
    name: d.name,
    avatar: typeof d.avatar === 'string' ? d.avatar : null,
    googleId,
    email_verified: d.email_verified === true,
    auth_provider:
      d.auth_provider === 'google' || (googleId !== null && googleId.length > 0)
        ? 'google'
        : 'local',
  };
}

/** Bearer token or `x-access-token` (common for SPA / OAuth redirects). */
export function getAccessToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  const raw = req.headers['x-access-token'];
  const x = Array.isArray(raw) ? raw[0] : raw;
  if (typeof x === 'string' && x.trim()) return x.trim();
  return undefined;
}

function tryAttachUserFromToken(req: AuthRequest, token: string): boolean {
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default-secret';
  try {
    const decoded = jwt.verify(token, secret);
    if (typeof decoded === 'string') return false;
    const user = jwtPayloadToAuthUser(decoded);
    if (!user) return false;
    req.user = user;
    return true;
  } catch {
    return false;
  }
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getAccessToken(req);
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  if (!tryAttachUserFromToken(req, token)) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}

export function requireCompany(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  if (req.user.role !== 'company') {
    return res.status(403).json({ message: 'Company access required' });
  }
  next();
}

export function requireCandidate(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  if (req.user.role !== 'candidate') {
    return res.status(403).json({ message: 'Candidate access required' });
  }
  next();
}

// Optional auth — attaches user if token is present and valid, but does not reject if missing/invalid
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getAccessToken(req);
  if (token) {
    tryAttachUserFromToken(req, token);
  }
  next();
}

export function requireAnyRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: `Access requires one of: ${roles.join(', ')}` });
    }
    next();
  };
}
