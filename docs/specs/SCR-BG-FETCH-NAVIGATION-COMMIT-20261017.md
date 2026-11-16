# Rendered Fetch must not return the initial blank document

Status: approved bounded repair. Owner raider-codex; delegate prep_failure_analysis.
Jesper requested real Raider pinpoint Fetch recovery, including existing shared
Browsergator, 2026-10-17. No private browser, CAPTCHA handling or browser lifecycle.

## Evidence
Exact Padthai request returned requestedUrl unchanged, finalUrl=about:blank,
39-byte empty html/body, statusCode=null at 12:01:05Z. Raider refused correctly.
openTab creates a target but does not await document commit; the initial blank
document already has a body, satisfying fetchRenderedPage's current readiness.
Audit URL sanitization is not evidence that the caller dropped the path.

## Scope
Only fetchRenderedPage readiness in src/gateway.ts, related MockBrowserDriver
cases in test/gateway.integration.test.ts, and docs/MCP-TOOLS.md's Fetch contract.
Preserve existing dirty-tree hunks. No broad navigation/driver change needed:
within the same existing lease/FIFO/deadline, await an HTTP(S), non-about:blank
committed document and suitable document readiness before capture. Redirects
may legitimately change URL; do not require string equality to requested URL.
Final captured location must itself still satisfy the commit predicate (race
between check and capture cannot yield blank success). Use the original deadline,
no second navigation, no infinite network-idle wait, no random sleeps or source-
specific selectors. Empty/unknown/timeout returns typed failure, never fake HTML.
Preserve finally close-only-created-tab and auth/host/origin/identity protections.

## Verification and handoff
Mock blank-body then committed-document; blank forever timeout; redirected target;
final-snapshot regresses to blank; normal capture/protocol/cleanup preservation.
Run repository lint/typecheck/test/build. No live browser calls, process restart,
commit or deployment by delegate. Root reviews exact diff then coordinates any
gateway-only activation; normal user browser and agent Chrome stay untouched.
Existing src/gateway.ts/test dirty edits belong to other work: preserve bytewise
outside scoped additions and record before/after hashes. Root owns this additive
scope only; no other files are released.

### Scope clarification — test fixture only (2026-10-17)
Approved by root: `test/helpers/mock-browser-driver.ts` may receive a narrowly
scoped readiness-expression default for `({url:location.href,readyState:document.readyState})`.
It reports the mock tab's current URL and modeled `complete` state only for that
expression; all other expressions retain their prior behavior, and tests may
override the readiness result to model blank/loading/redirect cases. Baseline
SHA-256 before this edit: `cf418eb24534b1c511f16109a8ab76e210383123`.
# Runtime activation receipt — 2026-10-17T12:13Z

Root reviewed frozen source and loaded the compiled gateway only after observing
zero queued/leased tab work. Verified old gateway31128 lifetime/path/parent31012
before stopping that exact child. New launcher134536/child120816 uses existing
run-gateway.mjs; no Chrome lifecycle/config/profile changes. Health200; all30
pre-existing page IDs preserved. Native fetch_rendered_page example.com returned
HTTP200,2497bytes and source hash9bc978e30055d7d7d4fd6f6acf16b3393ee7c361c734278b4ca6720c7aa74ef7;
own temporary page removed. Actual subsequent Raider diagnostic for the prior
foodorderanywhere.online Pad-Thai path returned a nonblank HTTP200 document at
expireddomains.com. That proves navigation evidence, NOT restaurant/menu success.
Old failed Raider job remains intact; no queue reset. Evidence in Raider
.devkit/complete/pinpoint-batch-20261017/browsergator-reload.*.log and RESULT.md.

## Bounded follow-up — attach before navigation and settle SPA capture

Approved by root raider-codex 2026-10-17 under the same live Fetch-repair mandate.
Delegate scout_semantic_review owns only these follow-up hunks; preserve prior
dirty-tree edits. Bangkok and Wrapsody actual captures have unknown document
status; Wrapsody retained 1075 bytes containing only noscript and an empty root.
Transport success and document readyState are not semantic readiness.

Context/released files: src/gateway.ts (fetchRenderedPage only),
src/cdp/websocket-cdp-driver.ts (attachment readiness ordering only), existing
test/gateway.integration.test.ts, test/helpers/mock-browser-driver.ts and a
focused driver test if necessary; docs/MCP-TOOLS.md Fetch contract. Driver/types
may be read for existing navigation/event interfaces, not broadly refactored.
Baselines: gateway 6bd5dabf41c7bba1ffedee979c3eed35b7b9316298aeb65efa399ceaa41cdb8a;
driver 9cc40c52bf4c82da69e6689dc836a82cc69ed9ba02de4af467fc94d95b42a509;
mock 57f6d4cb61ddd92918b89b912b9f2a96956609050b51fb934259d6b155000218;
integration 6812b924985f7d704d0ace6a7973adde4c98ec175085d79696d116f968580c3d.

Use an owned blank target, fully await Page/Network attachment, then navigate
the requested URL once through existing lease/FIFO and bounded network-idle
navigation. All steps share the original deadline; no random sleep, source-site
selector, extra browser or new service. Ensure an in-progress attachment cannot
return early merely because sessionByPage was set. Preserve ordinary open_tab.
Match observed final main-document transport without the URL fragment; keep the
complete requested/final URL in receipts. Prefer existing frame/request/loader
identity evidence; do not use a same-URL subframe response as the main document.
No status fabrication when evidence is absent. Network-idle is a bounded capture
condition, not proof of a menu or guaranteed arbitrary-SPA completeness.

Controls: attach must finish before requested navigation; delayed SPA renders
before snapshot; fragment response matches correctly; redirects; missing status;
timeout; subframe confusion; finally close only owned tab. Run lint/typecheck/
tests/build. Source-only delegate; root owns independent review and any gateway-
only activation after checking active work. No Chrome lifecycle or old-job reset.

Independent-review follow-up, root approved: prep_failure_analysis owns only
fetchRenderedPage finally cleanup and focused controls. Existing protected-URL
policy can refuse close after redirect; never bypass it. Surface cleanup-unknown
as an explicit tool failure with safe owned page identity and audit, not silently
successful overall return. Capture observation is separate from successful
temporary-page cleanup. No other page close or permission changes.
