export async function retry<T>(max: number, backoffMs: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < max; i++) {
    try { return await fn(); } catch (err) {
      lastError = err;
      if (i < max - 1) await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, i)));
    }
  }
  throw lastError;
}
