import type { ProfileConfig } from '../../config/types.js';

export type ProfileSource = 'file' | 'runtime';

export type ProfileInput = Partial<Omit<ProfileConfig, 'tools'>> & Pick<ProfileConfig, 'tools'> & {
  revision?: number;
  updated_at?: number;
  updated_by?: string | null;
};

export interface ProfileEntry extends ProfileInput {
  source: ProfileSource;
}

/** Only the implicit empty-profile sentinel is reserved forever. `default` may
 * be imported from config and edited like any other catalog entry, but cannot
 * be created out of thin air through the legacy API. */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set(['default', '__no_tools__']);

/** The browser-managed catalog is authoritative after startup seeding. `source`
 * records provenance for the UI only; file-origin rows are editable too. */
export class ProfileRegistry {
  private profiles = new Map<string, ProfileEntry>();
  private mutationCount = 0;

  get mutations(): number { return this.mutationCount; }

  addFileProfile(name: string, profile: ProfileInput): void {
    this.profiles.set(name, { ...profile, source: 'file' });
  }

  addRuntimeProfile(name: string, profile: ProfileInput): void {
    this.mutationCount += 1;
    this.profiles.set(name, { ...profile, source: 'runtime' });
  }

  loadCatalogProfile(name: string, profile: ProfileInput & { source?: ProfileSource }): void {
    this.profiles.set(name, { ...profile, source: profile.source ?? 'runtime' });
  }

  replaceCatalogProfiles(profiles: ReadonlyArray<{ name: string } & ProfileInput & { source?: ProfileSource }>): void {
    this.mutationCount += 1;
    this.profiles = new Map(profiles.map(profile => [
      profile.name,
      { ...profile, source: profile.source ?? 'runtime' as const },
    ]));
  }

  getProfile(name: string): ProfileEntry | undefined {
    return this.profiles.get(name);
  }

  getAllProfiles(): Array<{ name: string } & ProfileEntry> {
    return Array.from(this.profiles.entries()).map(([name, entry]) => ({ name, ...entry }));
  }

  isCodeModeEnabled(name: string): boolean {
    return this.profiles.get(name)?.enable_code_mode === true;
  }

  isFileProfile(name: string): boolean {
    return this.profiles.get(name)?.source === 'file';
  }

  removeProfile(name: string): boolean {
    this.mutationCount += 1;
    return this.profiles.delete(name);
  }
}
