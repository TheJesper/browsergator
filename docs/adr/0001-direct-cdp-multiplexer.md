# ADR 0001: Use a direct CDP multiplexer

Status: accepted

The gateway uses one browser-level CDP WebSocket with flattened target sessions rather than spawning or wrapping one `chrome-devtools-mcp` process per client.

This is the smallest architecture that places page routing, event observation, leases, policy, and FIFO scheduling in one authority. The upstream server remains a useful single-client tool and implementation reference, but its stdio-per-conversation deployment is the source of the current split-brain control plane.
