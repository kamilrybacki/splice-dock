# ADR 0003: Per-Connection MCP Server Instances

**Date:** 2026-04-14  
**Status:** Accepted

## Context

The MCP SSE endpoint must support multiple simultaneous AI agent connections, each potentially requesting a different profile (tool subset). The `Server` class from `@modelcontextprotocol/sdk` can be connected to exactly one transport at a time and maintains per-session state (request handlers, active transport).

## Decision

Call `buildMcpServer(...)` once **per incoming SSE connection**, creating a fresh `Server` instance for each client.

## Rationale

1. **Profile isolation**: Each SSE connection carries a `?profile=<name>` query parameter. The `ListToolsRequestSchema` handler closes over that profile value. If multiple connections shared one `Server`, their profile filters would conflict.

2. **Session state safety**: The MCP protocol is stateful within a session (initialization handshake, capability negotiation). A shared server instance would mix state from different clients unless carefully locked — an unnecessary complexity.

3. **Transport exclusivity**: `server.connect(transport)` pairs the server to exactly one transport. Attempting to reuse a connected server for a second client would error.

4. **Low cost**: The `Server` constructor is lightweight (no I/O, no thread spawning). Creating one per connection has negligible overhead for typical concurrency levels (<100 simultaneous agents).

## Consequences

- **Positive**: Complete session isolation; no cross-client data leakage; profile filtering is correct by construction.
- **Negative**: Memory usage scales linearly with concurrent connections. Mitigated by the 100-session cap in `createMcpExpressApp`.
- **Neutral**: The session `Map` in the Express app holds transport references until the SSE connection closes, which triggers the `onclose` cleanup callback.
