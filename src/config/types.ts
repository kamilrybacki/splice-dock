// Re-export inferred types for use across the codebase.
// Do not add hand-written interfaces here — derive from schema.ts.
export type {
  SplicedockConfig,
  ToolConfig,
  McpProxyToolConfig,
  HttpToolConfig,
  CliToolConfig,
  CliPassthroughToolConfig,
  CliToolPolicy,
  ProfileConfig,
  ProfileCredential,
  CredentialSource,
  CredentialProviderConfig,
  CredentialStorageConfig,
  CommandProviderConfig,
} from './schema.js';
