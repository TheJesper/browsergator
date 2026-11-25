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

Configured sensitive URL patterns are protected by default. On a protected tab (for example a login form), only agent IDs explicitly allowlisted in `BROWSER_GATEWAY_PROTECTED_AGENTS` may interact with page content (click, fill, type, evaluate and similar). Any agent may still claim, close, or navigate away from a protected tab, because leaving a login page never touches its content; a protected tab can therefore never become a dead end. The destination of a navigation is still checked, and a rendered fetch that redirects to a protected URL is rejected and its temporary tab closed. Reads remain possible for authenticated clients in the MVP; per-reader ACLs are a roadmap item.

## Site auth (opt-in)

`BROWSER_GATEWAY_SITE_AUTH` lists `https://host=ENV_VAR_NAME` entries. For each entry whose environment variable is set, the shared Chrome adds `Authorization: Bearer <value>` to requests for that exact origin, so intranet tools such as Confluence or Jira work without a manual login. The header is added only to top-level/frame navigations and to requests from a page already on the same origin, never to cross-site requests, and never when the request already has its own Authorization header. Only the variable name is stored in configuration; the token value is resolved at start and is never logged or emitted as an event. New tabs to a configured origin open blank first and then load, so the first request already carries the header.

## Prohibited automation

Development and tests must not purchase, trade, submit sensitive forms, handle BankID, or solve CAPTCHA. CAPTCHA detection will become a `NEEDS_HUMAN` pause flow; it is not implemented as bypass logic.

## Threat boundaries

The bearer token protects local callers but does not make LAN exposure safe. All connected MCP clients can inspect browser content, so clients themselves remain trusted principals. In-memory agent IDs are asserted by authenticated clients in the MVP; signed client identity is planned before any broader deployment.

The bearer token and MCP client session authenticate/connect a local client but do not identify its internal agents. Policy, leases, and audit use explicit `agentId`, `taskId`, and `leaseOwnerId`. Those values remain caller-asserted in the loopback MVP. The stdio adapter accepts only a loopback HTTP `/mcp` URL and never accepts a CDP or Chrome launch setting.
