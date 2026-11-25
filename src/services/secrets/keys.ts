import type { MintTarget } from './base.js';

/** Separates the parts of an in-memory key. Profiles, backends and providers are validated names, so none contains it. */
export const KEY_SEPARATOR = '\u0000';
const PATH_SAFE = /[^A-Za-z0-9_.-]/g;
/** Stands in for "no agent" in a storage path; `sanitize` never emits it, so it cannot equal a real label. */
const NO_AGENT_SEGMENT = '~';

/**
 * Tag for the agent part of an in-memory key. "No agent" and an agent are told
 * apart by the leading character, so no label (including `_` or the empty
 * string) can equal the absence of one.
 */
export function agentKeyTag(agent: string | null): string {
  return agent === null ? '0' : `1${agent}`;
}

/** In-memory key for a minted credential. The agent comes last so the profile stays the key prefix. */
export function credentialCacheKey(providerName: string, target: MintTarget): string {
  return [target.profile, target.backend, providerName, agentKeyTag(target.agent)].join(KEY_SEPARATOR);
}

/** Prefix of every in-memory key that belongs to one profile. */
export function profileKeyPrefix(profile: string): string {
  return profile + KEY_SEPARATOR;
}

export function sanitizePathSegment(segment: string): string {
  return segment.replace(PATH_SAFE, '_');
}

/** Storage path `profile/backend/agent/provider`; a present agent keeps its historical segment. */
export function credentialEntryPath(providerName: string, target: MintTarget): string {
  const agent = target.agent === null ? NO_AGENT_SEGMENT : sanitizePathSegment(target.agent);
  return [sanitizePathSegment(target.profile), sanitizePathSegment(target.backend), agent, sanitizePathSegment(providerName)].join('/');
}

/** What a storage path says about the credential behind it. Backend and agent are as sanitized as they were stored. */
export interface ParsedEntryPath {
  readonly profile: string;
  readonly backend: string;
  readonly agent: string | null;
  readonly provider: string;
}

/** Inverse of `credentialEntryPath`; undefined for a path that is not `profile/backend/agent/provider`. */
export function parseCredentialEntryPath(path: string): ParsedEntryPath | undefined {
  const parts = path.split('/');
  if (parts.length !== 4 || parts.some(part => part === '')) return undefined;
  const [profile, backend, agent, provider] = parts as [string, string, string, string];
  return { profile, backend, agent: agent === NO_AGENT_SEGMENT ? null : agent, provider };
}
