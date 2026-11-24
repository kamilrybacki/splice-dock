// Per-call config isolation for cli_passthrough tools (1c fix B).
//
// gh resolves unknown subcommands through config aliases and installed
// extensions; kubectl finds plugins on PATH and reads ~/.kube; most CLIs keep
// state under $HOME / $XDG_*. A shared HOME lets one call plant config that a
// later call executes. Each call therefore runs with a fresh, private (0700)
// HOME and XDG_* tree, removed when the call ends.
//
// Root dir: $SPLICEDOCK_TOOL_HOME, else the OS temp dir. The isolated keys
// win over any declared env var of the same name. KUBECONFIG and other
// explicit config-path vars are NOT touched: if declared, they still apply.
// That is safe because the child env is operator-only: it is built from the
// names (and vault refs) in the tool config, never from the MCP caller, who
// controls argv and cwd only. The caller's way to pick another kubeconfig is
// the --kubeconfig flag, which a namespace-confined policy refuses
// (cli-kubectl-confinement.ts).
//
// kubectl >= 1.33 also reads preferences (default flags, command aliases)
// from $KUBERC or ~/.kube/kuberc. toolEnvPins() turns that off for every
// kubectl call, with or without isolation and over any declared KUBERC, so
// neither a planted file nor operator env can rewrite a confined argv.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../../../common/logger.js';
import { cliProfileFor } from '../../../policy/cli/profiles/index.js';

export const ISOLATED_ENV_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'GH_CONFIG_DIR',
]);

export interface IsolatedHome {
  readonly dir: string;
  /** Env entries to overlay on the restricted env. */
  readonly env: Readonly<Record<string, string>>;
  /** Remove the tree. Idempotent; never throws (failures are logged). */
  cleanup(): void;
}

const PRIVATE = 0o700;

/** Thrown when the isolated tree cannot be created. The message carries no path. */
export class IsolationError extends Error {
  constructor() {
    super('could not create an isolated config dir for this call');
    this.name = 'IsolationError';
  }
}

/** Env entries forced for a tool on every call, after the declared env and
 *  the isolated home. They come from the CLI's profile (kubectl: kuberc off). */
export function toolEnvPins(command: string): Readonly<Record<string, string>> {
  return cliProfileFor(command)?.envPins ?? {};
}

function errName(err: unknown): string {
  return err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : 'unknown';
}

export function createIsolatedHome(command: string): IsolatedHome {
  const root = process.env['SPLICEDOCK_TOOL_HOME'] || tmpdir();
  let dir: string;
  try {
    // mkdtemp creates the directory with mode 0700.
    dir = mkdtempSync(join(root, 'splicedock-tool-'));
  } catch (err) {
    logger.error('isolated config dir creation failed', { error: errName(err) });
    throw new IsolationError();
  }
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('isolated config dir cleanup failed', { error: errName(err) });
    }
  };
  try {
    const xdg = {
      XDG_CONFIG_HOME: join(dir, '.config'),
      XDG_DATA_HOME: join(dir, '.local', 'share'),
      XDG_STATE_HOME: join(dir, '.local', 'state'),
      XDG_CACHE_HOME: join(dir, '.cache'),
    };
    // recursive mkdir applies `mode` to every level it creates (incl. .local).
    for (const p of Object.values(xdg)) mkdirSync(p, { recursive: true, mode: PRIVATE });
    const env: Record<string, string> = {
      HOME: dir,
      ...xdg,
      ...(cliProfileFor(command)?.isolatedConfigEnv?.(xdg.XDG_CONFIG_HOME) ?? {}),
    };
    return { dir, env, cleanup };
  } catch (err) {
    cleanup();
    logger.error('isolated config dir setup failed', { error: errName(err) });
    throw new IsolationError();
  }
}
