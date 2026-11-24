import { promises as dns } from 'node:dns';

export class PodResolver {
  private cache = new Map<string, { ips: string[]; expires: number }>();
  private rrIndex = new Map<string, number>();

  async resolve(serviceDns: string, ttlMs = 30_000): Promise<string[]> {
    const now = Date.now();
    const cached = this.cache.get(serviceDns);
    if (cached && cached.expires > now) return cached.ips;
    // Use lookup() so /etc/hosts is honoured (needed for bare-metal / LAN hostnames).
    const results = await dns.lookup(serviceDns, { all: true, family: 4 });
    const ips = results.map(r => r.address);
    this.cache.set(serviceDns, { ips, expires: now + ttlMs });
    return ips;
  }

  pickOne(serviceDns: string, ips: string[]): string {
    if (ips.length === 0) throw new Error(`no pods for ${serviceDns}`);
    const idx = (this.rrIndex.get(serviceDns) ?? 0) % ips.length;
    this.rrIndex.set(serviceDns, idx + 1);
    return ips[idx]!;
  }

  invalidate(serviceDns: string): void {
    this.cache.delete(serviceDns);
  }
}
