# Event model

The CDP driver continuously observes attached page targets, even with zero MCP clients.

Per page, the gateway keeps bounded ring buffers for:

- console calls, JavaScript exceptions, and Chrome log entries
- request, response, completion, failure, and WebSocket metadata
- target and page lifecycle changes

Every event has a gateway timestamp, `pageId`, kind, and redacted data. Oldest entries are evicted when the configured capacity is reached. Buffers are diagnostic memory, not durable telemetry.

Network request IDs are Chrome-scoped handles. `network_get_response_body` works only while Chrome retains that request's body and the request still belongs to the requested page. The audit log records that retrieval occurred but never records the returned body.

On target destruction, the latest buffer remains until normal bounded eviction or process restart, so agents can diagnose a recently closed tab. On browser reconnect, lifecycle events mark disconnect/reconnect and target sessions are rebuilt.
