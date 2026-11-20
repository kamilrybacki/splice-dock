# ADR 0002: Express for MCP SSE, Fastify for Admin API

**Date:** 2026-04-14  
**Status:** Accepted

## Context

Splicedock exposes two HTTP surfaces: an MCP SSE endpoint (port 8788, consumed by AI agents) and an admin REST API (port 8789, consumed by operators). Both need HTTP, but their requirements differ significantly.

## Decision

Use **Express** for the MCP SSE server and **Fastify** for the admin API.

## Rationale

### Express for MCP SSE (port 8788)

The `@modelcontextprotocol/sdk` `SSEServerTransport` is designed around the Node.js `http.ServerResponse` object. Express wraps that response directly without adding an abstraction layer. Attempting to use Fastify here would require stripping Fastify's response interceptors to reach the raw `res` object — adding complexity with no benefit.

Express is also lightweight for this role: the SSE endpoint (`GET /sse`) and message handler (`POST /messages`) are the only two routes needed.

### Fastify for Admin API (port 8789)

Fastify provides:
- **Built-in JSON schema validation** and structured error responses out of the box.
- **`@fastify/sensible`** for standard HTTP error helpers.
- **Hook system** (`addHook('preHandler', ...)`) that cleanly separates auth from route logic.
- **Typed reply** ensuring response shape consistency.
- **Better performance** under concurrent admin operations compared to Express.

## Consequences

- **Positive**: Each server is optimized for its use case; MCP SSE transport works unmodified; admin API gets validation and hooks at the framework level.
- **Negative**: Two HTTP frameworks in the same project increases the learning curve for contributors unfamiliar with one of them.
- **Neutral**: Both servers are started independently on different ports and do not share middleware state.
