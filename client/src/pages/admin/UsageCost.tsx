import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAdminUsage } from '@/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { DollarSign, Zap, Coins, Users, Search, Cpu, Hash, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const emptyPlatform = {
  totalCost: 0,
  totalCredits: 0,
  totalTokens: 0,
  totalApiCalls: 0,
  byFeature: [] as { feature: string; displayName: string; calls: number; cost: number; credits: number; tokens: number }[],
};

export default function UsageCost() {
  const [search, setSearch] = useState('');
  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['admin-usage'],
    queryFn: getAdminUsage,
    refetchInterval: 25_000,
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Usage & Cost</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card><CardContent className="p-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
      </div>
    );
  }

  if (error || !data) {
    const message = error instanceof Error ? error.message : 'Failed to load usage data.';
    const isConnection = /connection|server running|npm run dev/i.test(message);
    const isForbidden = /403|forbidden|authentication required|access denied|401/i.test(message);
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Usage & Cost</h1>
        <p className={isConnection ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
          {message}
        </p>
        {isForbidden && (
          <p className="text-sm text-muted-foreground">
            This page is only for accounts with the <strong>admin</strong> role. Log in with an admin user or ask your team to grant admin access.
          </p>
        )}
        {isConnection && (
          <p className="text-sm text-muted-foreground">
            In a terminal, run <code className="rounded bg-muted px-1 py-0.5">npm run dev</code> from the project root, then refresh this page.
          </p>
        )}
      </div>
    );
  }

  const platform = { ...emptyPlatform, ...data.platform, byFeature: data.platform?.byFeature ?? [] };
  const externalApis = data.externalApis ?? [];
  const pricingDocUrl = data.pricingDocUrl;
  const users = Array.isArray(data.users) ? data.users : [];
  const searchLower = search.trim().toLowerCase();
  const filteredUsers = searchLower
    ? users.filter(
        (u) =>
          (u.name || '').toLowerCase().includes(searchLower) ||
          (u.email || '').toLowerCase().includes(searchLower)
      )
    : users;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Usage & Cost</h1>
          {pricingDocUrl && (
            <a href={pricingDocUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline mt-1 inline-block">
              Alibaba Model Studio pricing (official) →
            </a>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching} className="shrink-0">
          <RefreshCw className={`w-4 h-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Platform overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <DollarSign className="w-4 h-4 text-emerald-500" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Platform spend (real)</p>
                <p className="text-xl font-bold">${Number(platform.totalCost ?? 0).toFixed(2)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Zap className="w-4 h-4 text-blue-500" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">API calls</p>
                <p className="text-xl font-bold">{platform.totalApiCalls ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Coins className="w-4 h-4 text-amber-500" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total calls (count)</p>
                <p className="text-xl font-bold">{platform.totalCredits ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10">
                <Hash className="w-4 h-4 text-violet-500" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Tokens (Alibaba)</p>
                <p className="text-xl font-bold">
                  {platform.totalTokens > 0 ? platform.totalTokens.toLocaleString() : '—'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10">
                <Cpu className="w-4 h-4 text-violet-500" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">APIs in use</p>
                <p className="text-xl font-bold">{(platform.byFeature ?? []).length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Which APIs we're using */}
      {(platform.byFeature ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">APIs in use — which ones</CardTitle>
            <p className="text-sm text-muted-foreground font-normal">
              {platform.byFeature!.length} API{platform.byFeature!.length !== 1 ? 's' : ''} currently in use: {platform.byFeature!.map((b) => b.displayName).join(', ')}. Call counts and cost below.
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-3 font-medium">API / Feature</th>
                    <th className="text-right p-3 font-medium">Calls</th>
                    <th className="text-right p-3 font-medium">Tokens</th>
                    <th className="text-right p-3 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {(platform.byFeature ?? []).map((b) => (
                    <tr key={b.feature} className="border-b last:border-0">
                      <td className="p-3 font-medium">{b.displayName}</td>
                      <td className="p-3 text-right">{b.calls}</td>
                      <td className="p-3 text-right">{b.tokens > 0 ? b.tokens.toLocaleString() : '—'}</td>
                      <td className="p-3 text-right">${Number(b.cost).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Which APIs we use + pricing (from .env or defaults) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Cpu className="w-5 h-5" />
            APIs we use ({externalApis?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(!externalApis || externalApis.length === 0) && (
            <p className="text-sm text-amber-600 dark:text-amber-400 mb-3">
              API list not loaded — restart the backend server and refresh this page.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-3 font-medium">API</th>
                  <th className="text-left p-3 font-medium">Model</th>
                  <th className="text-right p-3 font-medium">Input ($/1M)</th>
                  <th className="text-right p-3 font-medium">Output ($/1M)</th>
                  <th className="text-right p-3 font-medium">TTS ($/10K chars)</th>
                  <th className="text-left p-3 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {(externalApis ?? []).map((api) => (
                  <tr key={api.id} className="border-b last:border-0">
                    <td className="p-3 font-medium">{api.name}</td>
                    <td className="p-3 text-muted-foreground">{api.model}</td>
                    <td className="p-3 text-right">
                      {api.inputPricePer1M != null ? `$${api.inputPricePer1M.toFixed(4)}` : '—'}
                    </td>
                    <td className="p-3 text-right">
                      {api.outputPricePer1M != null ? `$${api.outputPricePer1M.toFixed(4)}` : '—'}
                    </td>
                    <td className="p-3 text-right">
                      {api.pricePer10KChars != null ? `$${api.pricePer10KChars.toFixed(4)}` : '—'}
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {api.pricingSource === 'env' ? 'From .env' : 'International defaults'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Per-user usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="w-5 h-5" />
            Per-user usage ({users.length})
          </CardTitle>
          <p className="text-sm text-muted-foreground font-normal">
            Real cost (from tokens) and API call count per user. Search by name or email.
          </p>
          <div className="relative max-w-sm mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-3 font-medium">User</th>
                  <th className="text-left p-3 font-medium">Email</th>
                  <th className="text-left p-3 font-medium">Role</th>
                    <th className="text-right p-3 font-medium">Cost</th>
                  <th className="text-right p-3 font-medium">API calls</th>
                  <th className="text-right p-3 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-muted-foreground">
                      {search ? 'No users match your search.' : 'No users yet.'}
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((u) => (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{u.name}</td>
                      <td className="p-3 text-muted-foreground">{u.email}</td>
                      <td className="p-3 capitalize">{u.role}</td>
                      <td className="p-3 text-right">${Number(u.totalCost).toFixed(4)}</td>
                      <td className="p-3 text-right">{u.totalCredits}</td>
                      <td className="p-3 text-right">{u.totalTokens > 0 ? u.totalTokens.toLocaleString() : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
