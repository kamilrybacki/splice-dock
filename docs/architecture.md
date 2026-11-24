# Architecture

Splicedock groups gateway functionality into services. Each service owns its
rules, use cases, and integrations. An operator can still add a configured
tool in YAML without changing the gateway code.

```text
docs/
  adrs/                      architecture decisions
  web/                       sources for GitHub Pages
src/
  services/
    <service>/
      base.ts                service entry point or backend-neutral interface
      adapters/<provider>/   framework or backend implementations, where needed
  config/                    configuration loading, schemas, and types
  contracts/
    internal/                gateway data exposed to callers
    outbound/                ports and data exchanged with backend providers
    inbound/                 payloads received from external callers
  common/                    shared utilities
  main.ts                    composition root: wires adapters into services
  *.ts                       root helpers that touch the process (env, files, stdout)
tests/
  fixtures/
  unit/
  functional/
  e2e/
```

For example, the database service exposes a SQL interface through
`services/database/base.ts` and implements it under `adapters/sqlite/` and
`adapters/postgres/`. Services that own a use case, such as profiles or
approvals, keep its implementation in `base.ts` and depend on repository
contracts for persistence. Fastify and Express are entry adapters for the
admin and MCP services.

| Location | Allowed local dependencies |
|---|---|
| `common` | `common` |
| `contracts` | `common`, `config`, `contracts` |
| `config` | `common`, `config`, `contracts`, service rules |
| service core | `common`, `config`, `contracts`, service cores |
| service adapters and composition root | any layer |

`npm run lint:layers` enforces these dependency directions in CI. Wire
concrete adapters in `main.ts` and keep provider imports out of the service
core.

Outside adapters and the composition root, the same check also limits package
imports to pure, backend-free libraries:

| Location | Allowed packages |
|---|---|
| `common` | `node:async_hooks`, `node:crypto` |
| `contracts` | none |
| `config` | `zod` |
| service core | `node:crypto`, `node:path`, `node:timers/promises`, `zod`, `minimatch` |

It also rejects `process.env` reads there, with no exceptions: the environment
is mapped onto configuration only in the composition root (`src/*.ts`, e.g.
`env-config.ts`, `config-file.ts`) and in adapters. The check uses
the TypeScript AST rather than a text match. Existing violations are listed in
`scripts/layers-baseline.json`. The baseline only shrinks: a new violation
fails CI, and so does an entry that has been fixed. After fixing one, run
`node scripts/check-layers.mjs --prune` to drop it from the list.

## Extension points

### YAML tools

Each tool in the configuration names a driver (MCP upstream, HTTP, CLI). Its
argument schema, policy and approval rules sit next to it in YAML. Nothing in
`src/` tests a tool's name, with one exception: data that is keyed by YAML tool
name on purpose (standing-grant shapes, operator grant exceptions).

### CLI profiles (`src/services/policy/cli/profiles/`)

What the runtime knows about a particular executable lives in a `CliProfile`:
- its flag table
- its known subcommands
- option aliases
- pinned environment variables
- whether namespace confinement applies

Profiles are selected by the executable's basename. A CLI without a profile gets
generic, conservative handling. To support a new CLI, add one profile module and
list it in `profiles/index.ts`.

### Built-in MCP tools (`src/services/mcp/adapters/express/tools/builtin.ts`)

Only `approvals__wait` is served by Splicedock itself rather than by a YAML
driver; it waits on an operator decision.

Each built-in is a `BuiltinTool`, with:
- a definition
- a list position (`head` or `tail`)
- whether a profile must allow it
- a `call` function

The MCP server lists and dispatches built-ins through the registry. To add one,
register a `BuiltinTool`; the server needs no other change.

### Strong-consent YAML tools

Destructive operations, such as deleting a repository, are ordinary YAML tools,
not built-ins. A `cli_passthrough` tool routes the operation to approval with
`policy.approval_subcommand_paths`. Approval paths must not overlap the deny
lists: deny always wins, and `compilePolicy` rejects the overlap.

Some paths are marked in the CLI profile itself (`strongApprovalPaths`; for `gh`
that is `repo delete`). The wrapper refuses such a path in every tool whose
policy does not route it to approval, counts the refusal toward the circuit
breaker, and asks for WebAuthn whenever it does go to approval. Listing a tool in
`server.consent.strong_default_tools` makes every approval of that tool strong.
The approval is bound to the caller, profile, cwd and exact argv, and no standing
grant covers it.

```yaml
server:
  consent:
    strong_default_tools: [gh_repo_delete]
tools:
  - type: cli_passthrough
    name: gh_repo_delete
    description: "Delete a GitHub repository (WebAuthn approval per call)"
    command: gh
    env: [GH_TOKEN]
    policy:
      allow_subcommand_paths: [["repo", "delete"]]
      approval_subcommand_paths: [["repo", "delete"]]
```

### Built-in grant exceptions (`src/services/policy/grants/config.ts`)

Operations that must never be covered by a standing grant are declared once in
`BUILT_IN_GRANT_EXCEPTIONS`. Both the standing-grant service and the admin API read
that constant. It is empty today: strong (WebAuthn) tools are always excluded on
their own. Operators add further exceptions at runtime; those live in the
database.

## Tests

| Tier                      | Location            | Scope                                                     |
|---------------------------|---------------------|-----------------------------------------------------------|
| `npm run test:unit`       | `tests/unit/`       | one module, collaborators faked; no network or processes  |
| `npm run test:functional` | `tests/functional/` | several modules wired together against stub upstreams     |
| `npm run test:e2e`        | `tests/e2e/`        | the built server, run as a process                        |

Shared fixtures live in `tests/fixtures/`, and helpers in `tests/helpers/`. The
`tests/unit/` tree mirrors `src/`.
