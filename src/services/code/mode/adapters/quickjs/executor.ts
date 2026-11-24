import { getQuickJS } from 'quickjs-emscripten';
import type { CompatibilityCallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { codeModeDef, type CodeExecutor } from '../../base.js';

export const executeCode: CodeExecutor = async (code, catalog, dispatch, signal) => {
  const trace: Array<{ name: string; status: string; duration_ms: number }> = [];
  const envelope = (result: unknown, error?: string): CompatibilityCallToolResult => {
    const data = { result, calls: trace, ...(error ? { error } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(error ? { isError: true } : {}) };
  };
  if (typeof code !== 'string' || Buffer.byteLength(code) > 65536) return envelope(null, 'code must be a string of at most 65536 bytes');
  const module = await getQuickJS();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 30_000;
  let cpuDeadline = Date.now() + 1000;
  runtime.setInterruptHandler(() => Date.now() >= deadline || Date.now() >= cpuDeadline || signal?.aborted === true);
  const vm = runtime.newContext();
  let closed = false;
  let active = 0;
  let count = 0;
  const queue: Array<() => void> = [];
  const pending = new Set<ReturnType<typeof vm.newPromise>>();
  const json = (value: unknown) => vm.unwrapResult(vm.evalCode(`(${JSON.stringify(value)})`));
  const api = vm.newObject();
  const list = vm.newFunction('list', () => json(catalog().map(({ name, description }) => ({ name, description }))));
  const search = vm.newFunction('search', query => {
    const terms = vm.getString(query).toLowerCase().split(/\s+/).filter(Boolean);
    return json(catalog().filter(tool => terms.every(term => `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(term))));
  });
  const call = vm.newFunction('call', (nameHandle, argsHandle) => {
    const name = vm.getString(nameHandle);
    const args = argsHandle ? vm.dump(argsHandle) : {};
    if (name === codeModeDef.name) throw new Error('recursive Code Mode is forbidden');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
    if (++count > 50) throw new Error('tool call limit exceeded');
    const deferred = vm.newPromise();
    pending.add(deferred);
    const run = async () => {
      if (closed) return;
      active++;
      const start = Date.now();
      const entry = { name: name.slice(0, 256), status: 'running', duration_ms: 0 };
      trace.push(entry);
      try {
        const result = await dispatch(name, args);
        entry.status = result.isError ? 'error' : 'ok';
        if (!closed) {
          const encoded = JSON.stringify(result);
          if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('tool result exceeds 4 MiB');
          const handle = json(result);
          deferred.resolve(handle);
          handle.dispose();
        }
      } catch {
        entry.status = 'error';
        if (!closed) {
          const error = vm.newError('tool call failed');
          deferred.reject(error);
          error.dispose();
        }
      } finally {
        entry.duration_ms = Date.now() - start;
        active--;
        if (!closed) queue.shift()?.();
      }
    };
    if (active < 4) void run(); else queue.push(() => { void run(); });
    return deferred.handle;
  });
  for (const [name, handle] of [['list', list], ['search', search], ['call', call]] as const) {
    vm.setProp(api, name, handle);
    handle.dispose();
  }
  vm.setProp(vm.global, 'tools', api);
  api.dispose();
  try {
    const handle = vm.unwrapResult(vm.evalCode(`(async () => {\n${code}\n})()`));
    try {
      while (true) {
        if (signal?.aborted || Date.now() >= deadline) throw new Error('workflow cancelled or timed out; operations may have completed');
        cpuDeadline = Date.now() + 1000;
        const jobs = runtime.executePendingJobs();
        if (jobs.error) { const message = String(vm.dump(jobs.error)); jobs.error.dispose(); throw new Error(message); }
        const state = vm.getPromiseState(handle);
        if (state.type === 'fulfilled') {
          const value = vm.dump(state.value);
          state.value.dispose();
          if (Buffer.byteLength(JSON.stringify(value) ?? 'null') > 65536) throw new Error('result exceeds 64 KiB');
          if (active || queue.length) throw new Error('workflow returned with unawaited calls; operations may have completed');
          return envelope(value ?? null);
        }
        if (state.type === 'rejected') {
          const error = vm.dump(state.error);
          state.error.dispose();
          throw new Error(typeof error?.message === 'string' ? error.message : 'workflow rejected');
        }
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    } finally { handle.dispose(); }
  } catch (error) {
    return envelope(null, error instanceof Error ? error.message : 'workflow failed');
  } finally {
    closed = true;
    queue.length = 0;
    for (const deferred of pending) deferred.dispose();
    vm.dispose();
    runtime.dispose();
  }
};
