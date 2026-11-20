import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/application/registry/tool-registry.js';
import type { RegistryEntry } from '../../../src/application/registry/tool-registry.js';

function makeEntry(id: string, source: 'file' | 'runtime' = 'file'): RegistryEntry {
  return {
    id,
    driver: 'http',
    source,
    config: { type: 'http', name: id, namespace: 'test', description: 'desc', method: 'GET', url: 'http://example.com', params: [], auth: { type: 'none' } },
    mcpDef: { name: id, inputSchema: { type: 'object' } },
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => { registry = new ToolRegistry(); });

  it('adds and retrieves a file tool', () => {
    const entry = makeEntry('tool-a', 'file');
    registry.addFileTool(entry);
    expect(registry.getTool('tool-a')).toBe(entry);
  });

  it('adds and retrieves a runtime tool', () => {
    const entry = makeEntry('tool-b', 'runtime');
    registry.addRuntimeTool(entry);
    expect(registry.getTool('tool-b')).toBe(entry);
  });

  it('getAllTools returns both file and runtime tools', () => {
    registry.addFileTool(makeEntry('file-tool'));
    registry.addRuntimeTool(makeEntry('runtime-tool', 'runtime'));
    const all = registry.getAllTools();
    expect(all).toHaveLength(2);
    expect(all.map(e => e.id)).toContain('file-tool');
    expect(all.map(e => e.id)).toContain('runtime-tool');
  });

  it('runtime tool overrides file tool on same id', () => {
    const fileTool = makeEntry('shared-id', 'file');
    const runtimeTool = makeEntry('shared-id', 'runtime');
    registry.addFileTool(fileTool);
    registry.addRuntimeTool(runtimeTool);
    expect(registry.getTool('shared-id')).toBe(runtimeTool);
    expect(registry.getAllTools()).toHaveLength(1);
    expect(registry.getAllTools()[0]).toBe(runtimeTool);
  });

  it('removeTool removes a runtime tool and returns true', () => {
    registry.addRuntimeTool(makeEntry('rt', 'runtime'));
    expect(registry.removeTool('rt')).toBe(true);
    expect(registry.getTool('rt')).toBeUndefined();
  });

  it('removeTool returns false for a file-defined tool and does not remove it', () => {
    registry.addFileTool(makeEntry('ft', 'file'));
    expect(registry.removeTool('ft')).toBe(false);
    expect(registry.getTool('ft')).toBeDefined();
  });

  it('isFileDefined returns true for file tool, false for runtime-only', () => {
    registry.addFileTool(makeEntry('ft'));
    registry.addRuntimeTool(makeEntry('rt', 'runtime'));
    expect(registry.isFileDefined('ft')).toBe(true);
    expect(registry.isFileDefined('rt')).toBe(false);
    expect(registry.isFileDefined('nonexistent')).toBe(false);
  });
});
