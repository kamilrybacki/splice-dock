// Canonical operation: the single definition of "what is being run".
//
// Every consumer that reasons about an argv (policy evaluation, the approval
// hook, argvHash, opDigest, and the consent page) MUST go through
// canonicalizeArgv. Two independent normalisations are how "approved X,
// executed Y" happens, so there is exactly one.
//
// Canonicalisation never rewrites bytes. It validates and freezes: the
// strings that are hashed are the strings that are spawned. Input that would
// be silently altered on its way to the child (a NUL truncates a C string, a
// lone surrogate becomes U+FFFD when encoded as UTF-8) is rejected instead.
//
// Error messages carry a reason code and an index, never argv contents.

import { createHash } from 'node:crypto';

/** Hard ceiling on argv length, independent of a policy's max_args. */
export const MAX_CANONICAL_ARGS = 4096;

/** Cap on the total size of argv (UTF-16 code units), as a DoS guard. */
export const MAX_CANONICAL_ARGV_CHARS = 1 << 20;

export type ArgvRejectReason = 'not_array' | 'not_string' | 'nul' | 'ill_formed' | 'too_many' | 'too_large';

export class ArgvCanonicalizationError extends Error {
  constructor(
    readonly reason: ArgvRejectReason,
    readonly index?: number,
  ) {
    super(index === undefined ? `argv rejected: ${reason}` : `argv rejected: ${reason} at position ${index}`);
    this.name = 'ArgvCanonicalizationError';
  }
}

declare const canonicalBrand: unique symbol;
export type CanonicalArgv = readonly string[] & { readonly [canonicalBrand]: true };

const canonical = new WeakSet<object>();

// In unicode mode a well-formed surrogate pair is one code point, so this
// matches only lone (ill-formed) surrogates. Equivalent to !isWellFormed().
const LONE_SURROGATE = /\p{Cs}/u;

export function isCanonicalArgv(argv: unknown): argv is CanonicalArgv {
  return typeof argv === 'object' && argv !== null && canonical.has(argv);
}

/** Validate and freeze argv. Idempotent: a canonical argv is returned as-is. */
export function canonicalizeArgv(input: unknown): CanonicalArgv {
  if (isCanonicalArgv(input)) return input;
  if (!Array.isArray(input)) throw new ArgvCanonicalizationError('not_array');
  if (input.length > MAX_CANONICAL_ARGS) throw new ArgvCanonicalizationError('too_many');
  const out: string[] = [];
  let total = 0;
  for (let i = 0; i < input.length; i++) {
    const tok: unknown = input[i];
    if (typeof tok !== 'string') throw new ArgvCanonicalizationError('not_string', i);
    if (tok.includes('\u0000')) throw new ArgvCanonicalizationError('nul', i);
    if (LONE_SURROGATE.test(tok)) throw new ArgvCanonicalizationError('ill_formed', i);
    total += tok.length;
    if (total > MAX_CANONICAL_ARGV_CHARS) throw new ArgvCanonicalizationError('too_large', i);
    out.push(tok);
  }
  Object.freeze(out);
  canonical.add(out);
  return out as unknown as CanonicalArgv;
}

export interface CanonicalOperation {
  readonly tool: string;
  /** Canonical argv (canonicalizeArgv is applied again defensively). */
  readonly argv: readonly string[];
  /** Effective resolved cwd; null when the operation has none. */
  readonly cwd: string | null;
  readonly profile: string;
  /** Token identity. Never the shared legacy-query id for strong consent. */
  readonly tokenId: string;
}

export type ConsentLevel = 'weak' | 'strong';

export const OP_DIGEST_VERSION = 'v1';

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function field(s: string): Buffer[] {
  const bytes = Buffer.from(s, 'utf8');
  return [u32(bytes.length), bytes];
}

/** SHA-256 over a length-prefixed, fixed-order encoding of the operation and
 *  its consent parameters:
 *
 *    field("v1") field(tool) u32(argc) field(argv[0]) ... field(argv[n-1])
 *    u8(cwd present 0|1) [field(cwd)] field(profile) field(tokenId)
 *    u64be(expiresAt) field(level) field(approvalId)
 *
 *  field(s) = u32be(byteLength(utf8(s))) || utf8(s). Every variable-length
 *  value is prefixed, so no two distinct inputs share an encoding. */
export function opDigest(op: CanonicalOperation, expiresAt: number, level: ConsentLevel, approvalId: string): string {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new RangeError('opDigest: expiresAt must be a non-negative integer (unix seconds)');
  }
  if (level !== 'weak' && level !== 'strong') throw new RangeError('opDigest: invalid level');
  const argv = canonicalizeArgv(op.argv);
  const exp = Buffer.alloc(8);
  exp.writeBigUInt64BE(BigInt(expiresAt));
  const parts: Buffer[] = [
    ...field(OP_DIGEST_VERSION),
    ...field(op.tool),
    u32(argv.length),
    ...argv.flatMap(field),
    Buffer.from([op.cwd === null ? 0 : 1]),
    ...(op.cwd === null ? [] : field(op.cwd)),
    ...field(op.profile),
    ...field(op.tokenId),
    exp,
    ...field(level),
    ...field(approvalId),
  ];
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}
