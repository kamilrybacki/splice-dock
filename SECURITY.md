# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub's **Report a vulnerability** button on the repository's
Security tab (private vulnerability reporting). Include the affected version
or commit, a description of the impact and, if you can, steps to reproduce.

You should get a first answer within a week. Fixes are released on `main`;
there are no maintained release branches.

## Scope

splicedock is a gateway that holds credentials for the backends it fronts, so
reports about any of these are especially welcome:

- authentication or profile isolation bypasses (one profile reaching another
  profile's tools or credentials);
- credential leakage into logs, metrics, error messages or tool output;
- approval-gate bypasses;
- command or argument injection through CLI passthrough tools.

Deployment mistakes in your own configuration (for example an admin endpoint
exposed without authentication) are out of scope, but documentation that
makes them easy to get wrong is in scope.
