# ADR 0002: Stateful Streamable HTTP sessions for MVP

Status: accepted

The gateway uses the stable `@modelcontextprotocol/sdk` 1.30 stateful Streamable HTTP transport. Session IDs allow explicit cleanup when a client disconnects or sends DELETE. Application coordination does not depend solely on the transport session; agent/task/page identity remains in tool arguments.

The gateway is a deliberate singleton, so sticky routing and horizontal replicas are not MVP concerns. A future MCP protocol/SDK migration can remove transport sessions without changing page coordination contracts.
