// CliProfile: everything Splicedock knows about one CLI binary, keyed by the
// executable's basename. The policy engine, the passthrough wrapper and the
// isolation layer read these hooks instead of testing for specific binaries.
//
// A command without a profile gets the generic defaults (empty flag table, no
// known-command filter, no aliases, no hard denies). Fail-closed behaviour for
// such tools comes from their own YAML policy, not from the profile layer.
//
// Profiles are keyed by the binary, never by the YAML tool name: grants and
// approval shapes that key on tool names stay where they are.

import type { KnownCommandTable } from '../commands/table.js';
import type { CredentialPrintDeny } from '../credential-deny.js';
import type { FlagTable } from '../flags/table.js';

export interface InvocationContext {
  /** Canonical argv. */
  readonly argv: readonly string[];
  /** Canonical leading command path ('' when unknown or known-command filtering is off). */
  readonly path: string;
  /** Flag table already refined for this invocation. */
  readonly table: FlagTable;
}

/** Namespace confinement for a CLI whose policies may require a namespace. */
export interface NamespaceConfinement {
  /** CLI name used in confinement denial messages. */
  readonly label: string;
  /** Every namespace value the CLI reads from argv, in order (null when ambiguous).
   *  Uses the CLI's built-in flag table unless one is given. */
  namespaceValues(argv: readonly string[], table?: FlagTable): readonly string[] | null;
  /** Full denial text when argv escapes the namespace (re-targets the request,
   *  swaps identity or config, ...), or undefined. Never echoes values. */
  breachMessage(argv: readonly string[], table: FlagTable): string | undefined;
}

export interface CliProfile {
  /** Executable basename this profile applies to. */
  readonly name: string;
  /** Flags whose arity is the same in every subcommand. */
  readonly flags: FlagTable;
  /** Commands the binary implements itself, with their built-in aliases. */
  readonly knownCommands: KnownCommandTable;
  /** Short → long option spellings used to match policy arg rules. */
  readonly optionAliases: Readonly<Record<string, string>>;
  /** Subcommand paths denied regardless of policy (no kill switch). */
  readonly hardDenyPaths?: readonly (readonly string[])[];
  /** Env entries forced on every call, after declared env and isolated home. */
  readonly envPins?: Readonly<Record<string, string>>;
  /** Extra env pointing the CLI at its config inside the isolated home. */
  isolatedConfigEnv?(configHome: string): Readonly<Record<string, string>>;
  /** Refine the flag table for subcommand-specific flag meanings. */
  invocationFlagTable?(argv: readonly string[], base: FlagTable): FlagTable;
  /** Subcommand-specific option aliases, merged over `optionAliases`. */
  invocationOptionAliases?(ctx: InvocationContext): Readonly<Record<string, string>>;
  /** Invocations that exist to print a credential (`auth token`, `--jq env.X`).
   *  Refused before spawn, whatever the policy; see `credential-deny.ts`. */
  readonly credentialDenies?: readonly CredentialPrintDeny[];
  /** Paths the wrapper always refuses with `broker_required`, whatever the policy. */
  requiresBroker?(path: readonly string[]): boolean;
  /** Destructive paths that run only when the tool's policy routes them to
   *  approval, and then only with strong (WebAuthn) consent. Any other tool
   *  for the same CLI is refused. */
  strongApprovalPaths?(path: readonly string[]): boolean;
  /** Policies that require a namespace are confined to it by the namespace gate. */
  readonly namespaceConfinement?: NamespaceConfinement;
}
