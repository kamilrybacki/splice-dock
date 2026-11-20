# ADR 0005: CLI Driver Uses shell: false (execFile, Not exec)

**Date:** 2026-04-14  
**Status:** Accepted

## Context

The CLI driver executes local commands (e.g. `kubectl`, `helm`) on behalf of AI agents. Tool arguments come from the MCP call payload, which is ultimately constructed by an LLM. This creates a command injection risk if arguments are concatenated into a shell string.

## Decision

Spawn CLI commands using `child_process.execFile` (equivalent: `spawn` with `shell: false`), passing each argument as a separate element of the `args` array.

## Rationale

1. **No shell interpolation**: `execFile` passes arguments directly to the OS `execve` syscall. The shell never sees the argument strings, so metacharacters (`; | && $() \`` etc.) in LLM-generated argument values are treated as literals, not shell syntax.

2. **Executable whitelist**: The `command` field in the CLI tool config must match `^[a-zA-Z0-9_-]+$` (a Zod regex), and the executable name is checked against a server-level `cli_whitelist` at call time. This prevents `../../../bin/sh` path traversal regardless of the `shell: false` setting.

3. **Restricted environment**: The subprocess inherits only the env vars explicitly listed in the tool's `env` field, plus `PATH` and `HOME`. No credentials or internal env vars are leaked to the subprocess.

4. **Timeout + SIGKILL**: Each CLI invocation has a `timeout_ms` (default 30 s, max 300 s). On timeout, the process is sent `SIGKILL` to prevent zombie processes.

## Consequences

- **Positive**: Shell injection is structurally impossible; whitelist prevents tool scope creep; restricted env prevents secret leakage.
- **Negative**: Some legitimate shell features (pipes, redirections) are unavailable. Tools requiring complex shell pipelines must be wrapped in a dedicated script and whitelisted by name.
- **Neutral**: The `args` array supports `{param}` template substitution, which happens in TypeScript before `execFile` is called — no shell involved.
