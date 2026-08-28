# Security

## Browser isolation

The gateway only connects to a configured CDP URL and defaults to `http://127.0.0.1:9222`. It never launches or terminates Chrome. Non-loopback CDP URLs are rejected. The dedicated agent profile is deployment-specific and must remain separate from normal Chrome, Edge, Firefox, and their profiles.

## HTTP boundary

- Bind address defaults to and is restricted to loopback.
- `/mcp` and `/status` require a bearer token supplied only through the environment.
- No usable default token exists; startup fails if it is missing or too short.
- Host and supplied Origin values must resolve to loopback names/addresses.
- Health and readiness reveal only coarse state and version.

These controls follow the MCP Streamable HTTP guidance for DNS-rebinding protection and local authentication.

## Sensitive data

Authorization, Proxy-Authorization, Cookie, Set-Cookie, API-key headers, password-like keys, and token-like keys are recursively redacted before logging or tool output. Audit events contain operation metadata and outcomes, never screenshots or response bodies. Request post bodies are not retained by default. Response bodies are returned only on explicit request and capped.

## Protected tabs

Configured sensitive URL patterns are protected by default. Only agent IDs explicitly allowlisted in `BROWSER_GATEWAY_PROTECTED_AGENTS` may claim, navigate, close, or atomically mutate them. Reads remain possible for authenticated clients in the MVP; per-reader ACLs are a roadmap item.

## Prohibited automation

Development and tests must not purchase, trade, submit sensitive forms, handle BankID, or solve CAPTCHA. CAPTCHA detection will become a `NEEDS_HUMAN` pause flow; it is not implemented as bypass logic.

## Threat boundaries

The bearer token protects local callers but does not make LAN exposure safe. All connected MCP clients can inspect browser content, so clients themselves remain trusted principals. In-memory agent IDs are asserted by authenticated clients in the MVP; signed client identity is planned before any broader deployment.

The bearer token and MCP client session authenticate/connect a local client but do not identify its internal agents. Policy, leases, and audit use explicit `agentId`, `taskId`, and `leaseOwnerId`. Those values remain caller-asserted in the loopback MVP. The stdio adapter accepts only a loopback HTTP `/mcp` URL and never accepts a CDP or Chrome launch setting.
