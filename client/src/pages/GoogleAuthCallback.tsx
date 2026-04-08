import { useEffect, useState } from 'react';
import { useLocation, Link } from 'wouter';
import { setAuthToken } from '@/lib/apiClient';
import { getCurrentUser } from '@/api';
import { useAuthStore } from '@/store/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

function readTokenFromBrowserUrl(): string | null {
  const rawHash = window.location.hash;
  const hashBody = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  const fromHash = new URLSearchParams(hashBody).get('token');
  if (fromHash) return fromHash;
  return new URLSearchParams(window.location.search).get('token');
}

export default function GoogleAuthCallback() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function complete() {
      const token = readTokenFromBrowserUrl();
      if (!token) {
        setError('Missing sign-in token. Close this tab and try Google sign-in again.');
        return;
      }

      setAuthToken(token);
      try {
        const user = await getCurrentUser();
        if (cancelled) return;
        useAuthStore.setState({ user, isAuthenticated: true });
        window.history.replaceState(null, '', '/auth/google/callback');
        if (user.role === 'admin') setLocation('/admin/dashboard');
        else if (user.role === 'company') setLocation('/company/dashboard');
        else setLocation('/candidate/dashboard');
      } catch (e: unknown) {
        setAuthToken(null);
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Could not complete sign-in';
          setError(msg);
        }
      }
    }

    void complete();
    return () => {
      cancelled = true;
    };
  }, [setLocation]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Google sign-in</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/login">Back to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gradient-to-br from-background via-background to-primary/5 p-4">
      <Loader2 className="h-10 w-10 animate-spin text-primary" aria-hidden />
      <p className="text-sm text-muted-foreground">Completing sign-in…</p>
    </div>
  );
}
