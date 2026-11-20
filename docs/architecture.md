# Architecture

Splicedock is a hexagonal (ports and adapters) application. Services are reached
only through tools defined in YAML; the runtime holds no per-service code. A new
backend is a YAML entry, not a new module.

## Layers

```
src/
  common/       logging, metrics, request context; depends on nothing else
  domain/       pure rules: CLI profiles, policy, profiles, shadow model, tool types
  config/       YAML loading and schema (zod); produces domain types
  ports/        interfaces the application needs from the outside world
  application/  use cases: approvals, broker, code mode, credentials, policy, runtime…
  adapters/     inbound (MCP, admin HTTP, consent) and outbound (drivers, persistence…)
  main.ts       composition root: wires adapters into ports
```

### Allowed imports

| Layer             | May import from                                      |
|-------------------|------------------------------------------------------|
| `common`          | `common`                                             |
| `domain`          | `domain`, `config`, `common`                         |
| `config`          | `config`, `domain`, `common`                         |
| `ports`           | `ports`, `domain`, `config`, `common`                |
| `application`     | `application`, `ports`, `domain`, `config`, `common` |
| `adapters`        | anything                                             |
| root (`src/*.ts`) | anything                                             |

`npm run lint:layers` (`scripts/check-layers.mjs`) enforces the table in CI. A file
in a directory that is not a known layer is a violation too.

The application layer talks to the database, the network, push channels and
upstream servers only through `src/ports/*`. Adapters implement those ports, and
`main.ts` connects them.

## Extension points

### YAML tools

Each tool in the configuration names a driver (MCP upstream, HTTP, CLI). Its
argument schema, policy and approval rules sit next to it in YAML. Nothing in
`src/` tests a tool's name, with one exception: data that is keyed by YAML tool
name on purpose (standing-grant shapes, operator grant exceptions).

### CLI profiles (`src/domain/cli/profiles/`)

What the runtime knows about a particular executable lives in a `CliProfile`:
- its flag table
- its known subcommands
- option aliases
- pinned environment variables
- whether namespace confinement applies

Profiles are selected by the executable's basename. A CLI without a profile gets
generic, conservative handling. To support a new CLI, add one profile module and
list it in `profiles/index.ts`.

### Built-in MCP tools (`src/adapters/inbound/mcp/builtin-tools.ts`)

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

### Built-in grant exceptions (`src/domain/policy/grant-config.ts`)

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
