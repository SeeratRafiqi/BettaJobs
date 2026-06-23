import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export type UserRole = 'admin' | 'candidate' | 'company';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: UserRole;
    email: string;
    name: string;
    avatar?: string | null;
    googleId?: string | null;
    email_verified?: boolean;
  };
}

/** Payload signed into JWT access tokens (local login, refresh, Google OAuth). */
export function buildJwtAccessClaims(input: {
  id: string;
  username: string;
  role: UserRole;
  email: string;
  name: string;
  avatar?: string | null;
  googleId?: string | null;
  email_verified?: boolean;
}) {
  return {
    id: input.id,
    username: input.username,
    role: input.role,
    email: input.email,
    name: input.name,
    avatar: input.avatar ?? null,
    googleId: input.googleId ?? null,
    email_verified: Boolean(input.email_verified),
  };
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default-secret';
  
  try {
    const decoded = jwt.verify(token, secret) as any;
    req.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
      email: decoded.email,
      name: decoded.name,
      avatar: decoded.avatar ?? null,
      googleId: decoded.googleId ?? null,
      email_verified: Boolean(decoded.email_verified),
    };
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
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

// Optional auth — attaches user if token is present, but doesn't reject if missing
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next(); // No token — continue without user
  }

  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default-secret';
  try {
    const decoded = jwt.verify(token, secret) as any;
    req.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
      email: decoded.email,
      name: decoded.name,
      avatar: decoded.avatar ?? null,
      googleId: decoded.googleId ?? null,
      email_verified: Boolean(decoded.email_verified),
    };
  } catch {
    // Invalid token — just continue without user
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
