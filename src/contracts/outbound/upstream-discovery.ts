import type { McpProxyToolConfig } from '../../config/types.js';
import type { McpToolDef } from '../internal/mcp-tool.js';

/** Resolves a headless Service DNS name to live pod addresses. */
export interface PodAddressResolver {
  resolve(serviceDns: string, ttlMs?: number): Promise<string[]>;
  pickOne(serviceDns: string, ips: string[]): string;
}

/** A short-lived session with one upstream MCP server, used to list its tools. */
export interface UpstreamToolLister {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  disconnect(): Promise<void>;
}

/** Opens a tool-listing session for one configured upstream. */
export type UpstreamToolListerFactory = (config: McpProxyToolConfig) => UpstreamToolLister;
