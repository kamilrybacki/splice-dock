/** Decides whether an exact argv is a read-only probe the breaker may exempt. */
export type ReadonlyProbe = (argv: readonly string[]) => boolean;

/** Tool name (as configured in YAML) to its read-only probe. */
export interface ReadonlyProbes {
  isReadonly(tool: string, argv: readonly string[]): boolean;
}

/** Closed, deliberately small exemption vocabulary: no flags, plugins or HTTP APIs. */
export function createReadonlyProbes(entries: Readonly<Record<string, ReadonlyProbe>>): ReadonlyProbes {
  const byTool = new Map(Object.entries(entries));
  return { isReadonly: (tool, argv) => byTool.get(tool)?.(argv) ?? false };
}

/** Nothing is exempt. */
export const NO_READONLY_PROBES: ReadonlyProbes = createReadonlyProbes({});

/** Rejects any `read_allowlist` entry the injected probes do not recognise as read-only.
 *  Run wherever a breaker config is adopted (startup and reload), so an unsupported
 *  exemption refuses the config instead of silently never matching. */
export function assertSupportedReadAllowlist(
  probes: ReadonlyProbes,
  allowlist: readonly { readonly tool: string; readonly argv: readonly string[] }[],
): void {
  allowlist.forEach((entry, index) => {
    if (!probes.isReadonly(entry.tool, entry.argv)) {
      throw new Error(`unsupported breaker read exemption: server.breaker.read_allowlist[${index}] (tool ${JSON.stringify(entry.tool)})`);
    }
  });
}
