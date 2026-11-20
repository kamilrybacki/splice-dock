# Strong operation consent — enrollment and recovery

Manual prerequisite: an operator must enroll TWO physical FIDO2 security keys
(primary and backup). No operator enrollment was performed by the implementation
agent. Never generate or import an operator private key in software.

Runtime requires Node 22 or later (SimpleWebAuthn server 14.0.3). Primary API
reference: https://simplewebauthn.dev/docs/packages/server . Context7 was attempted
but its provider returned fetch failed; primary documentation was read directly.

Before enabling, configure server.consent.rp_id and server.consent.origin to the
operator-controlled HTTPS consent host. The origin must be exactly its URL origin,
without a trailing slash; its hostname must equal or be a subdomain of rp_id.
Startup refuses enabled consent without this binding. Serve the admin/consent port
through that HTTPS origin, separately from MCP. Find consent links on the admin
approval page; pending replies include the approval id for approvals__wait.

1. Back up the SQLite database securely while stopped, including WAL as appropriate.
2. Log into the admin browser UI using an authorized admin identity. On the same
   HTTPS host open /api/v1/webauthn/enroll. Registration is admin authenticated;
   browser POSTs also carry the admin CSRF header. Keep admin credentials away from agents.
3. Insert the primary physical key, set its PIN through the vendor/OS tooling,
   select label primary and register. Repeat separately with label backup and the
   second key. Store the backup offline in a separate secure place.
4. Test each key against a controlled operation before expanding strong tools.
   Check the full operation, profile, token identity and cwd on the consent page.
   Previewing the URL changes no approval state. Touch/PIN authorizes only the
   displayed operation, not arbitrary retries. A retry must use the exact same
   argv, resolved cwd and authenticated profile token.

Hardware policy: registration requests cross-platform/direct attestation and UV;
verification refuses backup-capable/synced credentials, platform attachment and
zero/non-increasing counters. Assertions require UP, UV, exact RP and origin.
A counter regression revokes the credential. Not all FIDO2 authenticators support
increasing counters; those keys are intentionally unsupported. The implementation
requires manufacturer trust: configure `server.consent.hardware_roots` with PEM CA
certificates obtained from the vendor's authenticated publication for approved
physical security key models. Review fingerprints and the manufacturer's scope
out of band. Do not copy a root or AAGUID supplied by an enrolling client. Roots
must exclusively represent the hardware assurance the operator accepts; a CA
covering software authenticators is not an acceptable anchor. Only full `packed`
attestation with x5c is supported. None, self, other formats and untrusted chains
are refused. SimpleWebAuthn's exported certificate-path verifier validates against
these nonempty roots, separately from registration signature verification. No
custom crypto or AAGUID-only trust is used. See
https://simplewebauthn.dev/docs/advanced/server/settings-service (empty roots in
that library SKIP chain validation; Splicedock explicitly refuses this state).

No roots were provisioned by this implementation. Missing roots yield
`hardware_trust_unconfigured` on registration options and refuse enrollment and
all assertions. Previously enrolled credentials have no trust-policy marker and
cannot approve; re-enroll both keys. A SHA-256 marker binds each enrollment to the
exact configured root list. Changing or reordering roots requires re-enrollment;
plan a maintenance window. No online MetadataService is initialized. Vendor root
withdrawal/revocation review and configuration updates are operator duties.
Manual checks must demonstrate primary and backup enrollment, approval with each,
and rejection of an unsupported/synced/software authenticator. Local tests seed
explicit test-only policy markers to exercise signatures; these are not operator
enrollments or evidence of live hardware compatibility.

Revocation: use authenticated DELETE /api/v1/webauthn/credentials/:id; obtain the
credential ID from the controlled registration response/device inventory, never
publish the credential record. Revocation is soft and immediately excludes the key.
Enroll a replacement while another enrolled key remains available, test it and
revoke the lost key. Revocation currently needs admin authority, not a key assertion.

All keys lost: stop the service and isolate its admin endpoint. With audited local
host access, back up the DB and configuration, revoke existing WebAuthn credential
rows and reject all pending/approved strong operations in a local DB transaction.
Rotate compromised admin credentials at the Vault SOURCE, update every consumer,
and check ESO SecretSynced; never edit the delivered Secret. Restart behind the
controlled HTTPS origin, enroll two new keys using the authenticated enrollment
page, test both and restore access. There is no remote bypass or recovery secret.

Kill switch: server.consent.enabled=false disables consent and enrollment routes
and prevents strong reservation; it never downgrades strong rows. Existing weak
admin approvals remain supported for compatibility. Hook/weak-credential consent
defaults to `server.consent.weak.enabled=false`; keep it false until the operator
explicitly confirms the hook design. When enabled, admin POST
`/api/v1/profile-tokens/:id/consent-credential` issues/rotates a hash-only credential
shown once with no-store. POST `/api/v1/consent/weak/:id/approve` requires the bound
profile token as Authorization bearer and `{credential}`; admin bearer is not a
substitute. Credentials expire at weak.ttl_seconds after issuance/rotation and are
consumed on successful approval. Three bad attempts reject the approval. These
routes only change approval state and never spawn. Revoked/expired profile tokens
are refused. Rotation invalidates the previous credential. No config was enabled. Never use this switch to
approve destructive work. Independent root security review precedes publication,
merge, deployment, key enrollment and live notification verification.
