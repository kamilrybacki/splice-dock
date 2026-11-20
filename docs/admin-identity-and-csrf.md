# Admin identity and CSRF protection

## Approver identity

The `approver` recorded on an approval comes from authentication, never from
the request body. `approver` in the body of `approve`/`reject` is still
accepted for compatibility but ignored.

- The legacy single admin token (`server.admin_token_env`) maps to the fixed
  identity `admin`.
- Named admin tokens (`server.admin_tokens`) map to their `name`:

```yaml
server:
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  admin_tokens:
    - name: alice
      token_env: SPLICEDOCK_ADMIN_TOKEN_ALICE
    - name: bob
      token_file: /path/to/bob-token-file
```

Rules: names match `[A-Za-z0-9_.-]{1,64}` and are unique; `admin` is reserved;
each entry sets exactly one of `token_env` / `token_file`; two names must not
share the same token; startup fails (without printing token values) if a source
is missing or empty. Named tokens also work for WebUI login. Token comparison
is constant-time. `admin_tokens` is omitted from YAML exports.

## CSRF

State-changing requests (anything other than GET/HEAD/OPTIONS) authenticated
by the **session cookie** must send the header `x-cellarette-csrf: 1`;
otherwise they get `403 {"code":"csrf"}`. Cross-site pages cannot set custom
headers without a CORS preflight, which the server does not grant. The bundled
WebUI adds the header automatically to same-origin fetches.

Requests authenticated with `Authorization: Bearer ...` are exempt.

Known limits: the form posts `POST /admin/login` and `POST /admin/logout` are
outside the authenticated scope and are not covered; there is no Origin check
(to avoid breaking reverse-proxy setups). The session cookie is SameSite=Strict.
