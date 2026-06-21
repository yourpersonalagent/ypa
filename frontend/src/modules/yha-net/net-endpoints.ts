export interface NetMemberEndpoints {
  web?: string;
  funnel?: string;
  tailscaleHttps?: string;
  tailscale?: string;
  tailscaleHttp?: string;
  lan?: string;
  local?: string;
}

export interface NetReachability {
  networkId: string;
  networkName?: string;
  total: number;
  online: number;
  members?: Array<{ nodeId: string; online: boolean; label?: string }>;
}

export function isTailscaleBrowserHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.endsWith('.ts.net') || h.endsWith('.tailscale.net');
}

export function browserOrigin(raw: string | undefined): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' && isTailscaleBrowserHost(u.hostname)) {
      u.protocol = 'https:';
      u.port = '';
    }
    u.hash = '';
    u.search = '';
    u.pathname = '/';
    return u.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

export function appUrl(raw: string | undefined): string {
  const origin = browserOrigin(raw);
  if (!origin) return '';
  try {
    const u = new URL(origin);
    u.pathname = '/ypa';
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return origin.replace(/\/$/, '') + '/ypa';
  }
}

function endpointScore(raw: string, key: string): number {
  const origin = browserOrigin(raw);
  if (!origin) return -1;
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    const https = u.protocol === 'https:';
    if (https && (key === 'web' || key === 'funnel')) return 100;
    if (https && isTailscaleBrowserHost(host)) return 90;
    if (https) return 80;
    if (isTailscaleBrowserHost(host)) return 70;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 5;
    if (host.endsWith('.local')) return 15;
    return 20;
  } catch {
    return 0;
  }
}

const BROWSER_ENDPOINT_KEYS = ['web', 'funnel', 'tailscaleHttps', 'tailscale', 'tailscaleHttp'] as const;

export function bestBrowserOrigin(endpoints: NetMemberEndpoints | Record<string, string>): string {
  const entries = BROWSER_ENDPOINT_KEYS
    .map((key) => [key, (endpoints || {})[key]] as const)
    .filter((entry): entry is [typeof BROWSER_ENDPOINT_KEYS[number], string] => !!entry[1]);
  entries.sort((a, b) => endpointScore(b[1], b[0]) - endpointScore(a[1], a[0]));
  return browserOrigin(entries[0]?.[1]);
}

export function sshHint(sshHost: string | undefined, installPath: string | undefined): string {
  const host = String(sshHost || '').trim();
  const dir = String(installPath || '').trim();
  if (!host) return dir || 'SSH host unknown';
  if (!dir) return `ssh ${host}`;
  return `ssh ${host}  # cd ${dir}`;
}

export function updateSourceLabel(updateStatus?: {
  mode?: 'standard' | 'custom';
  sourceLabel?: string;
} | null): string {
  if (updateStatus?.sourceLabel === 'custom' || updateStatus?.mode === 'custom') return 'custom';
  if (updateStatus?.sourceLabel === 'public' || updateStatus?.mode === 'standard') return 'public';
  return 'public';
}

export function formatUpdateStatus(updateStatus?: {
  upToDate?: boolean;
  behind?: number;
  ahead?: number;
  dirty?: boolean;
  localVersion?: string | null;
  remoteVersion?: string | null;
  branch?: string | null;
  fetchOk?: boolean;
  mode?: 'standard' | 'custom';
  sourceLabel?: string;
  sourceDisplayUrl?: string | null;
} | null): string {
  const source = updateSourceLabel(updateStatus);
  if (!updateStatus) return `${source} · update status unknown`;
  if (updateStatus.dirty) return `${source} · uncommitted local changes`;
  if (updateStatus.upToDate) {
    const ver = updateStatus.localVersion || updateStatus.remoteVersion;
    return ver ? `${source} · up to date (${ver})` : `${source} · up to date`;
  }
  const behind = Number(updateStatus.behind || 0);
  const ahead = Number(updateStatus.ahead || 0);
  if (behind > 0) return `${source} · ${behind} commit${behind === 1 ? '' : 's'} behind${ahead ? `, ${ahead} ahead` : ''}`;
  if (!updateStatus.fetchOk) return `${source} · could not check updates`;
  return `${source} · update status unknown`;
}

export function browserEndpointLabel(raw: string | undefined): string {
  const url = appUrl(raw);
  if (!url) return 'no endpoint';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/ypa' ? '/ypa' : u.pathname}`;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

export function summarizeNetworkReachability(
  reachability: Record<string, NetReachability> | undefined,
  networks: Array<{ id: string; name?: string }>,
): { label: string; online: number; total: number } {
  const primary = networks[0];
  if (!primary) return { label: 'No YHA Net', online: 0, total: 0 };
  const stats = reachability?.[primary.id];
  if (stats) {
    return {
      label: stats.networkName || primary.name || primary.id,
      online: stats.online,
      total: stats.total,
    };
  }
  const members = Object.keys((networks[0] as { members?: Record<string, unknown> }).members || {});
  return {
    label: primary.name || primary.id,
    online: 0,
    total: members.length,
  };
}
