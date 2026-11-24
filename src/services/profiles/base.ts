import { minimatch } from 'minimatch';
import type { ProfileRegistry } from './profile-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { McpToolDef } from '../../contracts/internal/mcp-tool.js';

export interface ProfileAccess {
  getToolsForProfile(profileName: string): McpToolDef[];
  isToolAllowedForProfile(profileName: string, toolId: string): boolean;
  isCodeModeEnabled(name: string): boolean;
}

export class ProfileService implements ProfileAccess {
  constructor(
    private readonly profiles: ProfileRegistry,
    private readonly tools: ToolRegistry,
  ) {}

  isCodeModeEnabled(name: string): boolean { return this.profiles.isCodeModeEnabled(name); }

  getToolsForProfile(profileName: string): McpToolDef[] {
    const profile = this.profiles.getProfile(profileName);
    if (!profile) return [];
    return this.tools.getAllTools()
      .filter(entry => profile.tools.some(pattern => minimatch(entry.id, pattern)))
      .map(entry => entry.mcpDef);
  }

  isToolAllowedForProfile(profileName: string, toolId: string): boolean {
    const profile = this.profiles.getProfile(profileName);
    if (!profile) return false;
    return profile.tools.some(pattern => minimatch(toolId, pattern));
  }
}
