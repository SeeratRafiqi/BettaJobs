import { API_BASE_URL } from '@/lib/apiClient';

/** Full URL to start Google OAuth (same host as the SPA in dev; respects VITE_API_URL when absolute). */
export function getGoogleSignInUrl(): string {
  const base = API_BASE_URL.replace(/\/$/, '');
  const path = `${base}/auth/google`;
  if (typeof window === 'undefined') {
    return path;
  }
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return path;
  }
  return `${window.location.origin}${path}`;
}
