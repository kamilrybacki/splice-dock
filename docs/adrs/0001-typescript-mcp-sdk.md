# ADR 0001: TypeScript + Official MCP SDK

**Date:** 2026-04-14  
**Status:** Accepted

## Context

Splicedock needs a runtime that can speak the MCP protocol natively, handle async I/O efficiently, and integrate with a mature ecosystem for HTTP and YAML parsing. The primary candidates were TypeScript/Node.js, Go, and Python.

## Decision

Use **TypeScript (Node.js ≥ 20)** with the **`@modelcontextprotocol/sdk`** package from Anthropic.

## Rationale

1. **Protocol alignment**: The official MCP SDK is TypeScript-first. It provides `Server`, `SSEServerTransport`, typed request schemas (`ListToolsRequestSchema`, `CallToolRequestSchema`), and a `Client` with `SSEClientTransport` for upstream proxy connections. Using it removes the need to hand-implement the JSON-RPC framing and SSE encoding.

2. **Async primitives**: Node.js native `async/await`, `EventEmitter`, and `net.Server` are well-suited to the SSE keep-alive pattern required by MCP. Go would require manual goroutine management; Python asyncio has a larger surface area for foot-guns.

3. **Ecosystem**: `js-yaml`, `zod`, `minimatch`, `express`, and `fastify` are all well-maintained TypeScript libraries that cover the gateway's needs without custom parsing or validation code.

4. **Team knowledge**: TypeScript is already used elsewhere on the team. Consistency lowers maintenance cost.

## Consequences

- **Positive**: Full type safety through the MCP request/response cycle; Zod schemas share types with the runtime config parser.
- **Negative**: Node.js single-threaded model means a blocking tool call (e.g. a slow CLI command) can delay other requests. Mitigated by the per-request timeout in the CLI driver.
- **Neutral**: ESM-only project (`"type": "module"`) requires `.js` extensions in import paths, which is a minor DX friction but aligns with future-proof Node.js module resolution.
