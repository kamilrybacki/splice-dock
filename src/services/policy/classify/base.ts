/** Impact class of one operation. `unknown` is an abstention, never a permission. */
export type OpClass = 'benign' | 'disruptive' | 'destructive' | 'unknown';

const ORDER: Readonly<Record<OpClass, number>> = { benign: 0, disruptive: 1, destructive: 2, unknown: 3 };

/** The worse of two classes (`unknown` is worst: an operation we cannot read is never lowered). */
export function worse(a: OpClass, b: OpClass): OpClass {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** One row of a tool's table: a verb path, a default class, per-kind overrides, and the flags it understands. */
export interface VerbEntry {
  /** Space-joined leading positionals, e.g. `delete` or `rollout restart`. */
  readonly verb: string;
  readonly class: OpClass;
  /** Resource-kind overrides (kind as typed, lower case). Absent kind falls back to `class`. */
  readonly kinds?: Readonly<Record<string, OpClass>>;
  /** When true a kind not listed in `kinds` abstains instead of inheriting `class`. */
  readonly closedKinds?: boolean;
}

export interface ToolTable {
  readonly verbs: readonly VerbEntry[];
  /** Flags known not to change impact; each maps to whether it consumes a value. */
  readonly neutralFlags: Readonly<Record<string, boolean>>;
  /** Flags that raise the operation to destructive whatever the verb says. Never lower anything. */
  readonly raiseFlags: readonly string[];
  /** Values of `-X`/`--method`-style flags that raise to destructive (HTTP verbs); other tools leave it empty. */
  readonly raiseValueFlags?: Readonly<Record<string, readonly string[]>>;
}

export interface Classification {
  readonly class: OpClass;
  /** Typed key `tool|verb|kind` for queueing an unseen operation for human review. */
  readonly key: string;
  readonly reason: string;
}
