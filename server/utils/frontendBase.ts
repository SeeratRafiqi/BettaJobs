import type { Request } from 'express';

/**
 * Where to send the browser after Google OAuth (SPA origin).
 * Prefer FRONTEND_URL in production; otherwise infer from the incoming request (same-origin dev).
 */
export function resolveFrontendBaseUrl(req: Request): string {
  const fromEnv = process.env.FRONTEND_URL?.trim() || process.env.CLIENT_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  const xfProto = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(xfProto) ? xfProto[0] : xfProto)?.split(',')[0]?.trim() ||
    (req.protocol as string) ||
    'http';

  const xfHost = req.headers['x-forwarded-host'];
  const host =
    (Array.isArray(xfHost) ? xfHost[0] : xfHost)?.split(',')[0]?.trim() ||
    req.headers.host ||
    `localhost:${process.env.PORT || '5000'}`;

  return `${proto}://${host}`;
}

/**
 * Must match an "Authorized redirect URI" in Google Cloud Console exactly.
 * Example: http://localhost:5000/api/auth/google/callback
 */
export function googleOAuthCallbackUrl(): string {
  const explicit = process.env.GOOGLE_CALLBACK_URL?.trim();
  if (explicit) return explicit;
  const base = (process.env.PUBLIC_API_URL || 'http://localhost:5003').replace(/\/$/, '');
  return `${base}/api/auth/google/callback`;
}
