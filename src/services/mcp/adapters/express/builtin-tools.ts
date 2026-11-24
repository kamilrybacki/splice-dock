// Built-in MCP tools: tools Splicedock serves itself rather than through a
// YAML-defined driver (approval waiting). The MCP server
// lists and dispatches them through this registry instead of testing for
// specific names, so adding one means registering a BuiltinTool, nothing else.
//
// Code Mode is not a built-in tool in this sense: it orchestrates other tools
// and is wired into the server directly.

import type { CompatibilityCallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalWaitLimitError } from '../../../approvals/base.js';
import { currentCaller, type CallerIdentity } from '../../../../common/request-context.js';

export interface BuiltinToolCallContext {
  readonly signal?: AbortSignal;
}

export interface BuiltinTool {
  readonly def: Tool;
  /** 'head' tools are listed before the profile's tools, 'tail' ones after. */
  readonly listPosition: 'head' | 'tail';
  /** When true, a profile must allow the tool by name to see or call it. */
  readonly profileGated: boolean;
  call(args: Record<string, unknown>, ctx: BuiltinToolCallContext): Promise<CompatibilityCallToolResult>;
}

const registry = new Map<string, BuiltinTool>();

export function registerBuiltinTool(tool: BuiltinTool): void {
  registry.set(tool.def.name, tool);
}

export function unregisterBuiltinTool(name: string): void {
  registry.delete(name);
}

export function builtinTool(name: string): BuiltinTool | undefined {
  return registry.get(name);
}

/** Registered built-ins at one list position, filtered by profile access. */
export function listedBuiltinTools(
  position: BuiltinTool['listPosition'],
  isAllowed: (name: string) => boolean,
): Tool[] {
  return [...registry.values()]
    .filter(t => t.listPosition === position && (!t.profileGated || isAllowed(t.def.name)))
    .map(t => t.def);
}

const errorText = (text: string): CompatibilityCallToolResult => ({ content: [{ type: 'text', text }], isError: true });

// ── approvals__wait ─────────────────────────────────────────────────────────

export const APPROVAL_WAIT_TOOL = 'approvals__wait';

export type ApprovalWaitHandler = (
  id: string,
  timeout: number,
  caller: CallerIdentity | undefined,
  signal?: AbortSignal,
) => Promise<string>;

/** Every profile may wait on its own approvals, so the tool is not profile-gated. */
export function approvalWaitTool(handler: ApprovalWaitHandler): BuiltinTool {
  return {
    def: {
      name: APPROVAL_WAIT_TOOL,
      description: 'Wait for your approval decision, then retry the same operation before expires_at.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, timeout_s: { type: 'number', minimum: 0, maximum: 120 } },
        required: ['id', 'timeout_s'],
        additionalProperties: false,
      },
    },
    listPosition: 'head',
    profileGated: false,
    async call(args, { signal }) {
      const { id, timeout_s: timeout } = args;
      if (typeof id !== 'string' || typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
        return errorText('invalid input');
      }
      try {
        const status = await handler(id, timeout, currentCaller(), signal);
        return { content: [{ type: 'text', text: JSON.stringify({ status }) }] };
      } catch (error) {
        return errorText(error instanceof ApprovalWaitLimitError ? error.message : 'approval not found');
      }
    },
  };
}
