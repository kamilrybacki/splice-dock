import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRefreshService } from '../../../src/services/tools/refresh.js';

const mockResolve = vi.fn().mockResolvedValue(['10.0.0.1']);
const mockPickOne = vi.fn().mockReturnValue('10.0.0.1');
const mockRegistry = {
  replaceToolsForUpstream: vi.fn(),
};
const mockMetrics = {
  refreshSuccess: { inc: vi.fn() },
  refreshFailures: { inc: vi.fn() },
};
const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

const mockDriver = {
  connect: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue([{ name: 'test-tool', description: 'desc', inputSchema: {} }]),
  disconnect: vi.fn().mockResolvedValue(undefined),
};

describe('ToolRefreshService', () => {
  const configs = [
    { type: 'mcp_proxy', name: 'seq', service_dns: 'seq.svc', port: 8000, refresh_interval_ms: 600_000 },
  ];

  let svc: ToolRefreshService;
  beforeEach(() => {
    vi.clearAllMocks();
    svc = new ToolRefreshService(
      configs as never,
      mockRegistry as never,
      { resolve: mockResolve, pickOne: mockPickOne } as never,
      mockMetrics as never,
      mockLogger as never,
      600_000,
      () => mockDriver,
    );
  });

  it('probeOnce fetches tools and populates registry', async () => {
    await svc.probeOnce();
    expect(mockDriver.connect).toHaveBeenCalled();
    expect(mockDriver.listTools).toHaveBeenCalled();
    expect(mockRegistry.replaceToolsForUpstream).toHaveBeenCalledWith(configs[0], expect.any(Array));
    expect(mockMetrics.refreshSuccess.inc).toHaveBeenCalledWith({ upstream: 'seq' });
  });

  it('start/stop setInterval lifecycle', async () => {
    vi.useFakeTimers();
    svc.start();
    vi.advanceTimersByTime(600_001);
    svc.stop();
    vi.useRealTimers();
  });

  it('refresh failure increments refreshFailures when DNS fails', async () => {
    mockResolve.mockRejectedValueOnce(new Error('dns fail'));
    await svc.probeOnce();
    expect(mockMetrics.refreshFailures.inc).toHaveBeenCalledWith({ upstream: 'seq' });
  });

  it('refresh failure increments refreshFailures when connect throws', async () => {
    mockDriver.connect.mockRejectedValueOnce(new Error('connect fail'));
    await svc.probeOnce();
    expect(mockMetrics.refreshFailures.inc).toHaveBeenCalledWith({ upstream: 'seq' });
    expect(mockDriver.disconnect).toHaveBeenCalled();
  });

  it('disconnect called even on listTools failure', async () => {
    mockDriver.listTools.mockRejectedValueOnce(new Error('list fail'));
    await svc.probeOnce();
    expect(mockDriver.disconnect).toHaveBeenCalled();
    expect(mockMetrics.refreshFailures.inc).toHaveBeenCalledWith({ upstream: 'seq' });
  });
});
