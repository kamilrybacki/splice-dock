import { minimatch } from 'minimatch';
import type { ProfileRegistry } from '../registry/profile-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { McpToolDef } from '../registry/tool-registry.js';

export class ProfileService {
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
