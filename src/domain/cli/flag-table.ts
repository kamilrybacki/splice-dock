// Flag arity tables: which flags of a CLI consume the next argv token.
// Generic machinery only; per-CLI tables live in ./profiles/.

export type FlagArity = 'value' | 'bool';

export interface FlagTable {
  long: ReadonlyMap<string, FlagArity>;
  short: ReadonlyMap<string, FlagArity>;
}

export interface FlagTableSpec {
  longValue?: readonly string[];
  longBool?: readonly string[];
  shortValue?: readonly string[];
  shortBool?: readonly string[];
}

export function flagTable(spec: FlagTableSpec): FlagTable {
  const long = new Map<string, FlagArity>();
  const short = new Map<string, FlagArity>();
  for (const f of spec.longBool ?? []) long.set(f, 'bool');
  for (const f of spec.longValue ?? []) long.set(f, 'value');
  for (const f of spec.shortBool ?? []) short.set(f, 'bool');
  for (const f of spec.shortValue ?? []) short.set(f, 'value');
  return { long, short };
}

/** Table for a CLI without a profile: every flag has unknown arity. */
export const EMPTY_FLAG_TABLE: FlagTable = flagTable({});
