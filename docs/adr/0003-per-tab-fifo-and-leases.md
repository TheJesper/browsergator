# ADR 0003: Combine per-tab FIFO with short leases

Status: accepted

FIFO queues solve simultaneous mutations that arrive together. Leases solve longer logical ownership across calls. Both are required: a lease alone does not define fair ordering, and a queue alone cannot protect a multi-call workflow.

Reads bypass the mutation queue. Atomic operations occupy one FIFO slot and use an ephemeral lease unless the same task already owns the page.
