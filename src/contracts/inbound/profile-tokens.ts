/** Payloads received by the admin profile-token API before validation. */
export interface IssueProfileTokenRequest {
  profile?: string;
  agent?: unknown;
  expires_in_seconds?: number;
}

export interface RelabelProfileTokenRequest {
  agent?: unknown;
}

export interface RevokeProfileTokenRequest {
  reason?: string;
}
