import { vaultEvent, authEvent } from '../../../authentication/lifecycle-events.js';
import { resolveAuthValueRaw } from './resolver.js';
export type SecretResult = { ok: true; value: string } | { ok: false; code: 'vault_unavailable' | 'vault_timeout' | 'secret_missing' };
let timeoutMs = 3000;
export function configureSecretGuard(config: { timeout_ms: number }): void { timeoutMs = config.timeout_ms; }
/** No credential cache: all consumers, including destructive CLI calls, fail closed. */
export async function resolveSecretStrict(ref: string, ctx: { auth: boolean; destructive: boolean }): Promise<SecretResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const value = await Promise.race([
      resolveAuthValueRaw(ref, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('vault_timeout')); controller.abort(); }, timeoutMs); }),
    ]);
    if (ref.startsWith('vault:')) vaultEvent('ok');
    return { ok: true, value };
  } catch (err) {
    const code = err instanceof Error && err.message === 'vault_timeout' ? 'vault_timeout' : err instanceof Error && err.message === 'secret_missing' ? 'secret_missing' : 'vault_unavailable';
    if (ctx.auth && ref.startsWith('vault:')) authEvent('vault_unavailable');
    if (ref.startsWith('vault:')) vaultEvent(code === 'vault_timeout' ? 'timeout' : code === 'secret_missing' ? 'missing' : 'unavailable');
    return { ok: false, code };
  } finally { if (timer) clearTimeout(timer); }
}
export async function requireSecret(ref: string): Promise<string> {
  const result = await resolveSecretStrict(ref, { auth: true, destructive: true });
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
