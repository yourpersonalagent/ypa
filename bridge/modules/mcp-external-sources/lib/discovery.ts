// ── External MCP catalog discovery providers ────────────────────────────────
'use strict';

const REGISTRY_BASE = process.env.YHA_MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io';

function pickText(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function firstPackage(server: any): any {
  const packages = Array.isArray(server?.packages) ? server.packages : [];
  return packages[0] || null;
}

function installToTransport(server: any): any | null {
  // Registry server.json commonly carries either remote endpoints or package
  // install metadata. Keep this conservative: produce only configs YHA knows
  // how to run/connect.
  const remotes = Array.isArray(server?.remotes) ? server.remotes : [];
  const remote = remotes.find((r) => typeof r?.url === 'string') || null;
  if (remote) return { type: 'http', url: remote.url, auth: remote.auth?.type === 'oauth2' ? 'oauth' : 'none' };

  const pkg = firstPackage(server);
  if (!pkg) return null;
  const registry = String(pkg.registry_name || pkg.registry || '').toLowerCase();
  const name = pkg.name || pkg.package || pkg.identifier;
  if (registry === 'npm' && name) return { type: 'stdio', command: 'npx', args: ['-y', String(name)] };
  if ((registry === 'pypi' || registry === 'uv') && name) return { type: 'stdio', command: 'uvx', args: [String(name)] };
  if ((registry === 'docker' || registry === 'oci') && name) return { type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', String(name)] };
  return null;
}

function normalizeServer(server: any): any | null {
  const name = pickText(server, ['name', 'id', 'qualified_name', 'server_id']);
  if (!name) return null;
  const transport = installToTransport(server);
  return {
    id: String(name).split('/').pop()?.replace(/[^a-zA-Z0-9._-]+/g, '-') || name,
    name,
    label: pickText(server, ['display_name', 'title', 'name']) || name,
    description: pickText(server, ['description', 'summary']) || '',
    homepage: pickText(server, ['homepage', 'repository', 'repo_url']) || '',
    transport,
    raw: server,
  };
}

async function searchOfficialRegistry(query: string, limit = 20): Promise<any[]> {
  const q = String(query || '').trim();
  const lim = Math.max(1, Math.min(Number(limit) || 20, 50));
  const url = new URL('/v0/servers', REGISTRY_BASE);
  url.searchParams.set('limit', String(lim));
  if (q) url.searchParams.set('search', q);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  const data: any = await res.json();
  const items = Array.isArray(data?.servers) ? data.servers
    : Array.isArray(data?.items) ? data.items
    : Array.isArray(data) ? data
    : [];
  const normalized = items.map(normalizeServer).filter(Boolean);
  if (!q) return normalized.slice(0, lim);
  const needle = q.toLowerCase();
  return normalized
    .filter((s) => `${s.name} ${s.label} ${s.description}`.toLowerCase().includes(needle))
    .slice(0, lim);
}

module.exports = { searchOfficialRegistry, _normalizeServer: normalizeServer };
