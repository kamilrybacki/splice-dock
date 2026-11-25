// Output redaction for CLI passthrough children.
//
// A child process receives credentials through its environment (a minted token,
// a vault-backed secret, an inherited `*_TOKEN`). Anything the child prints can
// echo them back, so everything returned to the caller is scrubbed of those
// exact values first.
//
// The scrub runs on the fully assembled output, not per chunk, so a value split
// across stream chunks is still found. Only literal occurrences are detected: a
// credential the child transforms (base64, hashing, splitting with separators)
// is not. Hard-denied invocations (`credential-deny.ts`) cover the CLI features
// that exist to print credentials; this is the backstop for everything else.

/** Replaces every redacted value in returned output. */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/** Values shorter than this are never redacted: replacing a 3-character "secret"
 *  would mangle ordinary output far more than it would protect. */
export const MIN_REDACT_LENGTH = 8;

/** When output was truncated mid-stream, a trailing run of at least this many
 *  characters that starts a secret is treated as that secret's cut-off prefix. */
const MIN_TRUNCATED_PREFIX = 4;

/** Env names that carry a credential even when not declared as one explicitly. */
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export interface RedactionOptions {
  /** The output was cut off, so it may end partway through a secret. */
  readonly truncated?: boolean;
}

/** Candidate strings to scrub for one env value: the value, plus each of its
 *  lines when it spans several (a PEM key, a multi-line kubeconfig token). */
function candidatesOf(value: string): string[] {
  const lines = value.includes('\n') ? value.split(/\r?\n/).map(line => line.trim()) : [];
  return [value, ...lines];
}

/**
 * The values to scrub for a child's env: every entry named in `secretNames`
 * (credentials the wrapper injected) plus every entry whose name looks like a
 * credential. Empty and short values are skipped; the result is deduplicated and
 * ordered longest first so a value that contains another is matched whole.
 */
export function collectSecretValues(
  env: Readonly<Record<string, string | undefined>>,
  secretNames: Iterable<string>,
): string[] {
  const names = new Set<string>(secretNames);
  for (const name of Object.keys(env)) {
    if (isSecretName(name)) names.add(name);
  }
  const values = new Set<string>();
  for (const name of names) {
    const value = env[name];
    if (typeof value !== 'string') continue;
    for (const candidate of candidatesOf(value)) {
      if (candidate.length >= MIN_REDACT_LENGTH) values.add(candidate);
    }
  }
  return [...values].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Length of the longest suffix of `text` that is a proper prefix of a secret. */
function truncatedPrefixLength(text: string, secrets: readonly string[]): number {
  let longest = 0;
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, text.length);
    for (let len = max; len > longest && len >= MIN_TRUNCATED_PREFIX; len--) {
      if (text.endsWith(secret.slice(0, len))) {
        longest = len;
        break;
      }
    }
  }
  return longest;
}

/** `text` with every occurrence of every secret replaced by the placeholder.
 *  `secrets` must come from `collectSecretValues` (longest first, no short values). */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
  options: RedactionOptions = {},
): string {
  if (secrets.length === 0 || text.length === 0) return text;
  // One pass over an alternation, longest first: replaced text is never rescanned.
  const pattern = new RegExp(secrets.map(escapeRegExp).join('|'), 'g');
  const scrubbed = text.replace(pattern, REDACTION_PLACEHOLDER);
  if (!options.truncated) return scrubbed;
  const cut = truncatedPrefixLength(scrubbed, secrets);
  return cut > 0 ? scrubbed.slice(0, scrubbed.length - cut) + REDACTION_PLACEHOLDER : scrubbed;
}
