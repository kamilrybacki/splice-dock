// PolicyStore — resolves the effective policy for a cli_passthrough tool.
//
// Effective policy = runtime override (if any) OR file-loaded policy. The
// override is a full replacement, not a merge — merging fields silently was
// rejected as too foot-gun-y during design.
//
// Persistence: overrides are stored in SQLite (the policy_overrides table, via PolicyOverrideRepository)
// so they survive pod restart. File policies remain helm-managed and are
// considered the operator-controlled source of truth.
//
// The wrapper's WeakMap-by-config cache is invalidated indirectly: when an
// override changes, listeners (currently just cli-passthrough-wrapper) call
// invalidate(tool) which clears any cached compiled policy keyed by the
// matching config object.

import type { CliPassthroughToolConfig, CliToolPolicy } from '../../config/types.js';
import { compilePolicy, PolicyCompileError, type CompiledCliPolicy, type CompileOptions } from './cli/rules.js';
import { logger } from '../../common/logger.js';
import type { PolicyOverrideRepository } from '../../contracts/outbound/repositories.js';

export interface EffectivePolicyView {
  tool: string;
  file_policy: CliToolPolicy | undefined;
  /** All-profiles override (applies when no profile override matches). */
  override: CliToolPolicy | null;
  /** Policy a caller with no profile override gets: override ?? file. */
  effective: CliToolPolicy | undefined;
  /** Profiles that carry their own override for this tool. */
  profile_overrides: string[];
}

export type PolicyInvalidator = (tool: string) => void;

export class PolicyStore {
  private invalidators: PolicyInvalidator[] = [];

  constructor(private readonly db: PolicyOverrideRepository) {}

  /** Subscribe to override changes. Each call to setOverride/deleteOverride
   *  fires every registered invalidator with the affected tool name. */
  onChange(fn: PolicyInvalidator): void {
    this.invalidators.push(fn);
  }

  private fire(tool: string): void {
    for (const fn of this.invalidators) {
      try { fn(tool); } catch (err) {
        logger.warn('policy invalidator threw', {
          tool, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async getOverride(tool: string): Promise<CliToolPolicy | null> {
    return await this.db.getPolicyOverride(tool);
  }

  /** Resolve the effective policy for a config, applying any stored override.
   *  Invariant: the override is read from the DB on every call (no in-process
   *  cache here), so overrides are already consistent across replicas. */
  async effective(config: CliPassthroughToolConfig, profile?: string): Promise<CliToolPolicy | undefined> {
    // Resolution order: profile override -> all-profiles override -> file policy.
    if (profile) {
      const scoped = await this.db.getProfilePolicyOverride(config.name, profile);
      if (scoped) return scoped;
    }
    const override = await this.db.getPolicyOverride(config.name);
    if (override) return override;
    return config.policy;
  }

  /** Build a view of all three forms (file, override, effective) for the WebUI. */
  async view(config: CliPassthroughToolConfig): Promise<EffectivePolicyView> {
    const override = await this.db.getPolicyOverride(config.name);
    return {
      tool: config.name,
      file_policy: config.policy,
      override,
      effective: override ?? config.policy,
      profile_overrides: await this.db.listProfilePolicyOverrideProfiles(config.name),
    };
  }

  async getProfileOverride(tool: string, profile: string): Promise<CliToolPolicy | null> {
    return await this.db.getProfilePolicyOverride(tool, profile);
  }

  async setProfileOverride(
    tool: string,
    profile: string,
    policy: CliToolPolicy,
    updatedBy: string | null = null,
    compileOptions: CompileOptions = {},
  ): Promise<CompiledCliPolicy> {
    const compiled = compilePolicy(policy, compileOptions); // throws PolicyCompileError
    await this.db.setProfilePolicyOverride(tool, profile, policy, updatedBy);
    this.fire(tool);
    logger.info('profile policy override set', { tool, profile, updated_by: updatedBy });
    return compiled;
  }

  async deleteProfileOverride(tool: string, profile: string): Promise<boolean> {
    const existed = await this.db.deleteProfilePolicyOverride(tool, profile);
    if (existed) {
      this.fire(tool);
      logger.info('profile policy override cleared', { tool, profile });
    }
    return existed;
  }

  /** Store a runtime override. Validates by attempting compilePolicy() first;
   *  throws PolicyCompileError on malformed regex / contradictory rules.
   *  Pass the tool's compile options so command-specific checks (flag arity,
   *  known subcommands) reject a bad override here instead of on first use. */
  async setOverride(
    tool: string,
    policy: CliToolPolicy,
    updatedBy: string | null = null,
    compileOptions: CompileOptions = {},
  ): Promise<CompiledCliPolicy> {
    let compiled: CompiledCliPolicy;
    try {
      compiled = compilePolicy(policy, compileOptions);
    } catch (err) {
      if (err instanceof PolicyCompileError) {
        logger.warn('policy override rejected', { tool, error: err.message });
        throw err;
      }
      throw err;
    }
    await this.db.setPolicyOverride(tool, policy, updatedBy);
    this.fire(tool);
    logger.info('policy override set', { tool, updated_by: updatedBy });
    return compiled;
  }

  async deleteOverride(tool: string): Promise<boolean> {
    const existed = await this.db.deletePolicyOverride(tool);
    if (existed) {
      this.fire(tool);
      logger.info('policy override cleared', { tool });
    }
    return existed;
  }
}
