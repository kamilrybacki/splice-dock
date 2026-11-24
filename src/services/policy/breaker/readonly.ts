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
