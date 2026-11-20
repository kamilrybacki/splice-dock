// SSRF guard for runtime-created mcp_proxy upstreams. An operator-entered
// service_dns makes the gateway open a connection to that host, so API/wizard
// created upstreams must match server.mcp_upstream_allowlist (deny by default).
// Entries are exact hostnames or `*.suffix` (matches any subdomain, not the apex).

export function isUpstreamHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.com"
      return h.length > suffix.length && h.endsWith(suffix);
    }
    return entry === h;
  });
}
