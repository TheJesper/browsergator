# MCP tools

All tools operating on an existing page require its explicit Chrome target ID in `pageId`. `fetch_rendered_page` is the exception: it creates its own temporary page for the supplied URL and closes only that page. Tool failures return a structured JSON object and set MCP `isError`.

`open_tab` creates one individual tab only. It never creates or changes Chrome tab groups. `create_browser_context` and `dispose_browser_context` are the only explicit browser-context lifecycle operations; no context is created implicitly.

`fetch_rendered_page` is a one-call convenience for rendered-page fetching. It creates an owned blank tab, fully attaches observation, obtains its own short lease, and navigates the requested URL once through the existing FIFO coordinator. Within the original deadline it waits for bounded network-idle navigation and a committed HTTP(S) document, then rechecks the captured document identity. Network idle is a capture condition, not a guarantee of arbitrary SPA completeness or menu content. It never treats the initial `about:blank` body as a successful fetch; if navigation does not settle before the deadline, it returns a typed failure and closes only its own page. Redirects may change the final URL. Observed transport metadata is bound to the final main-frame loader and document request; URL fragments are excluded only from HTTP-response matching, never from receipt URLs. Missing or ambiguous observation remains null. It returns rendered `html` with final URL, observed document status (nullable), byte count, SHA-256 and capture time. It accepts only HTTP(S) URLs without embedded credentials, enforces a response-size cap, and does not click, submit forms, solve challenges, or read browser storage. Cloudflare/CAPTCHA pages are returned as ordinary page content for the caller to classify; the tool does not bypass them. This fetch tool returns page HTML to the authenticated caller; audit logs record only URL, hash, size and status.

## Reads

- `list_tabs`: current page targets plus protected/lease metadata. No page queue.
- `snapshot`: bounded accessibility tree for one page. No mutation queue.
- `screenshot`: PNG or JPEG image for one page. No mutation queue.
- `console_list`: bounded observed console/log/exception entries.
- `network_list`: bounded observed request/response/WebSocket metadata with sensitive headers redacted.
- `network_get_response_body`: asks Chrome for a retained response body. Returns `RESPONSE_BODY_UNAVAILABLE` if evicted or unknown and caps output size.

## Mutations

- `open_tab`: creates a new page target. It does not reuse an existing tab.
- `create_browser_context`: creates an explicitly owned, incognito-like CDP browser context with a bounded TTL.
- `dispose_browser_context`: disposes an owned context and its pages; active leases require `force=true`.
- `fetch_rendered_page`: one-call temporary-page rendered fetch with content receipt; see safety and size limits above.
- `close_tab`: per-page FIFO mutation; denied for protected tabs unless authorized.
- `navigate`: per-page FIFO mutation with automatic short lease behavior.
- `click`: per-page FIFO mutation; clicks an element using a CSS selector, optionally narrowed by visible text.
- `fill`: per-page FIFO mutation; fills an input, textarea, select, or contenteditable element using a CSS selector.
- `wait_for`: waits for a CSS selector or visible text without mutating the page.
- `press_key`: dispatches a key press to the focused element.
- `type_text`: inserts text into the focused element.
- `hover`: dispatches hover events for a targeted element.
- `click_at`: clicks viewport coordinates.
- `drag`: drags between two targeted elements.
- `fill_form`: fills multiple CSS-selected controls sequentially.
- `handle_dialog`: accepts or dismisses an open JavaScript dialog.
- `run_atomic`: FIFO claim, policy check, navigate, optional URL/title verification, and release. The required idempotency key deduplicates retries.

## Coordination

- `claim_tab`: obtains or renews a short runtime lease for `{agentId, taskId, leaseOwnerId}`.
- `release_tab`: releases a matching lease ID and explicit logical owner. Client-session cleanup is only a best-effort fallback.

Mutation metadata uses required `agentId`, `taskId`, and `leaseOwnerId`, optional `correlationId`, and optional or required `idempotencyKey`. The server-supplied MCP client session is recorded separately and is never sufficient to identify an agent or lease owner.

## Error codes

`TAB_NOT_FOUND`, `TAB_PROTECTED`, `LEASE_CONFLICT`, `LEASE_EXPIRED`, `BROWSER_DISCONNECTED`, `NEEDS_HUMAN`, `DIALOG_NOT_OPEN`, `WAIT_TIMEOUT`, `RESPONSE_BODY_UNAVAILABLE`, `AUTH_REQUIRED`, `INVALID_CONFIG`, `INVALID_SELECTOR`, `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_INTERACTABLE`, `IDEMPOTENCY_CONFLICT`, `INVALID_FETCH_URL`, `FETCH_BODY_TOO_LARGE`, `CONTEXT_NOT_FOUND`, `CONTEXT_OWNER_MISMATCH`, `CONTEXT_HAS_ACTIVE_LEASES`, and `INTERNAL_ERROR`.
