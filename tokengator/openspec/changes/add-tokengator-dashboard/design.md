# Design

## Context

See `proposal.md` for motivation. Constraints that shape the design:

- The owner works on Windows; agents and CI run on Linux and macOS. Everything must be cross-platform and need no native modules.
- Providers differ wildly in what they expose. A few have documented APIs (ElevenLabs, OpenRouter, the OpenAI and Anthropic cost APIs), some leave machine-readable traces on disk (Claude Code status line input, Codex session logs), several have only undocumented endpoints, and some (Suno, most creative tools) have nothing but a web page.
- The numbers are only useful if they are current, and a tool that needs daily typing is abandoned within a week.
- The repository already hosts Browsergator, whose rules (`AGENTS.md`) forbid anything that touches the user's browser or weakens loopback, Host or Origin checks. Tokengator must not couple to the gateway.

## Goals / Non-Goals

**Goals:**

- One implementation of the waste maths, used by the browser, the CLI and the MCP server, so a person and an agent are always told the same thing.
- A first screen that answers "what do I use now" in two seconds.
- Freshness without typing wherever a dependable source exists, and a five-second manual path where none does.
- Runs from a clone with `npm ci && npm run build && npm start`; no database, no framework, no build service.

**Non-Goals:**

- Scraping provider web pages from inside Tokengator. Reading a usage page is delegated to an agent that already has a browser, through `report_usage`.
- Currency conversion. Amounts stay in the currency the user entered.
- Per-request token analytics. Tools such as ccusage do that well; Tokengator tracks quota windows, not prompts.
- Multi-user or hosted operation. One person, one machine, loopback.
- Automatically spending quota. Tokengator informs; it never starts work.

## Decisions

### D1. A self-contained package inside this repository

`tokengator/` has its own `package.json`, lockfile, lint, tests and OpenSpec directory. The root only ignores it in ESLint and adds a CI job.

*Alternatives:* a workspace of the root package (rewrites the gateway's lockfile and couples release cadence); a separate repository (not available to this change). Keeping it self-contained means it can be split out later with `git subtree split` and nothing else changes.

### D2. One isomorphic core, three shells

```
src/core/     pure TypeScript, no Node or DOM imports (enforced by lint)
src/server/   state store, application service, HTTP, MCP, collectors
src/cli/      argument parsing and terminal rendering
src/web/      the dashboard, bundled with esbuild; imports core
```

The core holds the types, reset-rule arithmetic, reading application, roll-over, forecast, tiers, ordering, the quick-entry parser, wording, the catalog and the sample data. The server compiles it with `tsc`; the browser gets the same source through the bundle. This is what makes requirement "One wording everywhere" true by construction instead of by discipline.

*Alternative:* compute everything on the server and send finished view models. Rejected: countdowns and tiers change with the clock, so the browser would need a round trip per tick or a second implementation, and the sample-data mode would need a server.

### D3. Store readings, derive everything else on read

The state file holds accounts, meters with their raw amounts and reset times, the samples of the current window, finished cycles, spend entries and settings. Pace, projection, value, tier, staleness and wording are never stored; they are functions of `(meter, account, now)`.

Roll-over is also a pure function, `rollState(state, now)`, applied by the service before every read and write and by the browser on every tick. It is idempotent, so it does not matter who runs it first.

### D4. The forecast

For an allowance meter with used share `u` and elapsed share `e` of its window:

```
rate      = (u + k) / (e + k)          k = 0.05
projected = min(1, u + (1 - e) * rate)
unused    = 1 - projected              (0 when the meter carries over)
```

`k` is a pseudo-observation of "on pace for 5% of a window". At `e = 0` it predicts full use; by mid-window it has almost no influence. This removes the divide-by-zero and the wild early swings of the naive `u / e` without a second tuning knob.

A linear, whole-window pace was chosen over a recent-rate estimate on purpose. Usage is bursty (work hours, weekdays), readings may be hours apart, and a model that reacts to the last two samples would flip tiers every time the user goes to lunch. The inspector shows the samples, so a person can see a stall that the average hides.

Value: `price per month × (window length ÷ mean month) × value share × unused`. Yearly prices are divided by 12. A meter's value share defaults to 1 for an account's first allowance meter and 0 for further ones, because sub-limits (a per-model weekly cap inside an all-models cap) overlap and must not be counted twice; presets set it explicitly.

Tiers are evaluated in a fixed order so each meter has exactly one: expired, spent (`u ≥ 0.98`), idle (no window), use-now (reset within the horizon, `≥ 10%` left, `unused ≥ 5%`), hot (`u / e ≥ 1.2`, `e ≥ 0.1`, run-out at least 10% of a window before the reset), fresh (`e < 0.05`), behind (`unused ≥ 15%`), on-pace. The horizon is `clamp(15% of window, 2h, 72h)`.

Tiers were preferred over a single blended score for the default ordering because a person can predict them. A score that trades value against time produces orders nobody can explain; "most value at risk" exists as an explicit alternative ordering instead.

### D5. Reset rules and zone arithmetic

Six rule kinds cover every quota found in research: `rolling`, `interval`, `daily`, `monthly`, `once`, `none`. A weekly cap is an `interval` of 168 hours anchored by its current reset time, which is how providers that report a reset instant behave. Calendar-month quotas are `monthly` on day 1 in UTC.

Wall-clock rules need the UTC instant of "day D, HH:MM in zone Z". This is done with `Intl.DateTimeFormat` (offset at a guess, corrected once), which is available in Node and browsers alike. No date library.

### D6. Windows that move, and what gets recorded

`applyReading` first rolls the meter to now, then resolves the amount, then looks at the reading's reset time: within half a window of the stored one it is a correction; half a window or more later it is a new window, so the old one is closed first. This is what lets a collector that only reports "resets at T" drive the ledger correctly.

A finished cycle is recorded only for allowance meters that have had at least one reading. When several windows pass unobserved, only the first is recorded; the others have no data and inventing "100% wasted" rows would poison the ledger. Confidence is `measured` when the last reading was not stale at the close.

### D7. Persistence: one JSON file, a lock directory, atomic rename

`~/.tokengator/state.json` (or `TOKENGATOR_HOME`). Writers take `state.lock` by `mkdir` (atomic on every platform), re-read the file, apply their change, write a temporary file and rename it over the original. A lock older than ten seconds is treated as abandoned. The service watches the file and announces external changes on the event stream.

*Alternatives:* SQLite through `node:sqlite` (still flagged experimental on Node 22) or a native module (breaks "no native modules"); a server-only store with the CLI and stdio MCP proxying to it (then nothing works unless the service is running, and the status line hook would block on a socket). The state is a few hundred kilobytes at most; a file is enough.

### D8. HTTP without a framework

`node:http` with a small router. Static files are the built bundle. The event stream sends only "changed, revision N"; clients refetch the state. That keeps one serialisation path and makes missed events harmless.

### D9. Security posture

- Bind `127.0.0.1`; refuse a non-loopback bind without `TOKENGATOR_TOKEN`.
- Every request: Host must be a loopback name or the configured host, with the service's port.
- State-changing requests: Origin, when present, must equal the service's own origin; bodies must be `application/json` and at most 256 KB. A cross-site form cannot produce that without a preflight, which the service never approves.
- With a token: bearer header or an HTTP-only, SameSite=Strict cookie minted by `POST /api/session`; comparison with `timingSafeEqual`. See D15 for why the token never travels in a query string.
- The MCP endpoint is mounted inside the HTTP server, behind the same Host, Origin and token checks. The SDK's own rebinding guard is not used: it would need a second copy of the allowed-host list, and one list is easier to keep right than two.
- Credentials are read from the environment (or `~/.tokengator/.env`) inside the collector at call time and never leave that function. The redaction helper used for logs and error messages strips anything that looks like a key or bearer value.

### D10. MCP: stateless HTTP and stdio over the same service

Both transports build the same `McpServer` from the same application service. The HTTP transport runs stateless (a fresh transport per request), so a service restart never strands a client with a dead session id. The stdio transport opens the state file directly, so it works when the dashboard is not running and the dashboard sees its writes through the file watch.

Tools are few and verb-first: `what_to_use`, `list_accounts`, `get_account`, `report_usage`, `quick_update`, `add_account`, `update_account`, `remove_account`, `list_catalog`, `refresh_usage`, `waste_report`, `record_spend`, `get_costs`. Each returns a short text block written for a model to quote and a `structuredContent` object for a model to compute on. Read-only tools are annotated as such; `remove_account` is annotated destructive and needs `confirm: true`.

### D11. Collectors, and agents as the universal adapter

A collector is `{ id, providerId, sourceKind, interval, describe(env), collect(ctx) }` and returns readings keyed by preset meter key. All are opt-in. The scheduler runs them with a timeout, isolates failures and backs off.

Shipped collectors are limited to sources that could be verified (see "Provider sources" below). For everything else the adapter is an agent: the catalog carries each provider's usage-page address and a note on which figures to read, the skill tells the agent to read them, and `report_usage` stores them. This is deliberately not a scraper inside Tokengator: selectors rot, sessions belong to the user's browser, and an agent that can already see the page does the job with no extra credentials.

Overlapping limits get their own treatment. A cap on one model family inside a weekly allowance is not an allowance (nothing is lost with it that is not already counted in the allowance) and not an account-wide gate (the other models keep working). It is modelled as a throttle marked `partial`: it has its own bar and reset, it never produces waste, and reaching it blocks nothing else.

Billing-cycle meters need the subscriber's own renewal day. Presets mark them `anchor: billing`; with a day supplied they become `monthly` rules in the user's zone, and without one they are created as month-long intervals with no anchor, which the forecast reports as "reset time unknown" until a reading or the user supplies it.

The Claude Code status line is a push source rather than a poll: `tokengator statusline` is configured as the status line command, receives the JSON Claude Code already produces, records the rate-limit windows and prints the line. It must never fail or block the terminal, so it writes with a short lock timeout and swallows every error. Configuring the command in Claude Code is the opt-in, so this source has no switch and is not part of the polled registry.

### D12. The interface: no framework, hand-drawn marks

The dashboard is TypeScript against the DOM with a twenty-line element helper, bundled by esbuild into one script. There are a few dozen rows on screen; a virtual DOM would add weight and nothing else. Views re-render from state; a one-second ticker only rewrites countdown text nodes.

Visual language:

- **Ground:** Solarized's hues with the chroma taken down until the base tones read as warm-cool grey rather than teal or cream. Text is lifted above classic Solarized body contrast, which is known to be too low.
- **Colour means state, never identity.** Light blue is quota used and anything informational. Pastel Solarized orange is quota that will expire. Muted green is "used up, nothing wasted". Yellow is "running hot". Red is reserved for blocked and expired. Providers are told apart by name and a two-letter monogram, not by hue, so the eye is free to find the orange.
- **Hatching means forecast, solid means fact.** The expiring segment of a forecast bar is hatched orange because it has not happened yet; the same share in the History view is solid because it did.
- **The forecast bar** is the unit the whole interface is built from: used, projected, expiring, and a tick where an even pace would be. It is drawn the same way in every view at different sizes.
- **Type:** IBM Plex Sans for interface text and figures, IBM Plex Mono only for literals. Both are bundled, so the page makes no font request.
- No gradients, glass, glows or decorative icons. Borders and fills are used by role: the selected row, the inspector and dialogs are surfaces; rows in a list are separated by hairlines, not boxed.

Measured on the shipped tokens (WCAG 2 ratio; colour-blind separation as OKLab distance under Machado protan and deutan simulation, with the data-visualisation validator):

| Check | Light | Dark |
| --- | --- | --- |
| Lowest text contrast on page, surface and selected row | 4.73:1 | 4.74:1 |
| Lowest mark contrast on page, surface and track | 3.08:1 | 5.10:1 |
| Used blue against expiring orange, red-green colour blindness | 19.2 | 17.7 |
| Used blue against expiring orange, full colour vision | 24.1 | 21.5 |

The target for separation is 8 and the floor is 6, so the one pair the product depends on is safe by a wide margin. Two deliberate deviations: the dark-theme marks are lighter than the validator's band for categorical series, because the brief asks for pastel light blue and pastel orange and the pair still clears every separation and contrast check; and the status hues (orange, yellow, green, raspberry) are not separable from each other by hue under colour blindness, which is why every state also has its own shape and its label, and why yellow and orange never touch inside one bar.

Type: labels are sentence case at one size, with no tracked capitals. Figures use the text face, whose digits are tabular; the monospace face is kept for text a person copies or types (commands, configuration, keys).

View modes are projections of one ordered list of meter views, so sort and filter state lives in one place and applies everywhere.

### D13. Sample-data mode is the same code

`src/core/demo.ts` builds a plausible state relative to the current time. The browser's data layer has two backends with one interface, HTTP and in-memory; the in-memory one is used when `?demo` is present or the service cannot be reached. `npm run build:demo` emits a single self-contained HTML file with that backend, which doubles as a shareable preview.

### D14. Quick entry is a small grammar in the core

```
entry   := account [meter] amount [reset]
amount  := N% [used|left] | N [used|left] | N/M
reset   := "resets" when | "in" duration
when    := duration | weekday [clock] | "tomorrow" [clock] | clock | ISO date[time]
```

Account and meter are matched by token prefix against labels, provider ids and meter keys; the longest unambiguous match wins and ambiguity is an error with candidates. A bare amount means "used", and the preview always spells out both used and left so a wrong guess is caught before saving. The same parser backs the dashboard field, `tokengator set` and the `quick_update` tool.

### D15. The HTTP contract

All bodies are JSON. Errors are `{ "error": { "code", "message", "field"?, "candidates"? } }` with 400 (validation), 401 (token), 403 (Host or Origin), 404, 409 (ambiguous name), 413, 415 and 500. Meter ids contain a colon and are percent-encoded in paths. Every API response carries `Cache-Control: no-store`.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /healthz` | | `{ status, service, version }` (no token needed) |
| `GET /api/state` | | `{ state, now, timeZone, version, demo, collectors, warnings }` |
| `GET /api/snapshot` | | the machine-readable queue (same as `what_to_use`) |
| `GET /api/brief` | | Markdown |
| `GET /api/catalog` | | `{ checked, providers }` |
| `GET /api/events` | | server-sent events: `change` with `{ revision }`, a comment every 25 s |
| `POST /api/accounts` | an account, or `{ preset: { provider, plan?, label?, price? } }` | 201 `{ account }` |
| `PATCH /api/accounts/:id` | fields to change | `{ account }` |
| `DELETE /api/accounts/:id` | | 204 |
| `POST /api/accounts/:id/meters` | a meter | 201 `{ meter }` |
| `PATCH /api/meters/:id` | fields to change | `{ meter }` |
| `DELETE /api/meters/:id` | | 204 |
| `POST /api/meters/:id/readings` | a reading | `{ account, meter }` |
| `POST /api/quick` | `{ text, dryRun? }` | `{ preview, accountId, meterId, saved }` |
| `POST /api/spend` | a spend source | 201 `{ source }` |
| `PATCH /api/spend/:id` | fields to change | `{ source }` |
| `DELETE /api/spend/:id` | | 204 |
| `POST /api/spend/:id/entries` | `{ date?, amount, mode? }` | `{ source }` |
| `PATCH /api/settings` | fields to change | `{ settings }` |
| `GET /api/export` | | the state document |
| `POST /api/import` | a state document | `{ state }` |
| `GET /api/collectors` | | `{ collectors }` |
| `PATCH /api/collectors/:id` | `{ enabled }` | `{ collector }` |
| `POST /api/refresh` | `{ ids? }` | `{ collectors }` |
| `POST /api/session` | `{ token }` | 204 and the session cookie |
| `* /mcp` | MCP Streamable HTTP | |

The token is never accepted in a query string, where it would end up in history and logs. The dashboard reads it from the address fragment (`/#token=…`), which browsers do not send to servers, exchanges it at `/api/session` for the cookie and removes the fragment.

### D16. Reminders reach the person outside the tab

Quota expires when nobody is looking at the dashboard, so a browser notification from an open tab is the weakest possible reminder. The research pass ranked the routes a loopback-only service has (see `research.md`), and four are built:

- **A notification on this computer**, raised by the service through the operating system's own command: `notify-send` on Linux and the BSDs, `osascript` on macOS, Windows PowerShell 5.1 and WinRT on Windows. No native module and no extra dependency. The text travels as arguments (Linux, macOS) or environment variables (Windows) to a fixed command; nothing a user typed is ever part of a command line or a script. On Windows the toast borrows PowerShell's application identity, which Windows already knows, so it is shown and kept in the notification centre at the price of being attributed to PowerShell; registering an identity of our own needs a Start-menu shortcut, which is an installer's job.
- **A message to an address of the user's own** (`TOKENGATOR_NOTIFY_URL`): plain text with a `Title` header, which is ntfy's format and reaches a phone, or the JSON Slack and Discord webhooks take. The address is a credential and is handled like one (environment only, HTTPS, host-only errors, no redirects). Remote messages carry no link: a loopback address means nothing on a phone, and the useful action is at the provider anyway.
- **A calendar of resets** as iCalendar, from the API and the CLI. It is the only route that still fires when the computer is off. Entries say what resets and not how much is left, because a calendar copy is always older than the dashboard. Subscribing to a loopback address works only in calendar programs on the same computer, so the panel offers both the address and the file.
- **The agent's status line**, which already exists (D11): it names the most urgent quota in the place where quota gets spent.

The rule is the same on every route and lives in the core: one reminder per meter per window, at the moment the meter becomes `use-now`. That moment is 15% of the window before its reset (D5), which is about a day for a weekly limit and three days for a monthly one, the lead times the research found workable. Decisions that follow from "a chatty reminder gets switched off":

- No reminders for windows shorter than two days. A session or daily limit would ring several times a day; the dashboard and the status line cover those.
- No second or third stage, no escalation, no "urgent" flags. Several quotas due at once are folded into one message.
- A window is identified by its reset time with thirty minutes of tolerance, because sources that derive it from "seconds remaining" report it slightly differently each time.
- A reminder counts as raised once any channel took it. When none did it stays due and the service backs off for fifteen minutes.
- Evaluation is from state on a one-minute tick, never from timers, so a laptop that slept catches up on the next tick and a window that ended in the meantime raises nothing.
- The first check waits 45 seconds after a start, so collectors can bring fresh numbers first.
- A stale reading still earns a reminder, worded as a prompt to check the real number: an unattended manual meter is exactly the one that expires unnoticed.
- No quiet hours. The operating system and the phone already have Do Not Disturb, and a second schedule would only make it unclear why a reminder did not arrive.
- Sample data never reaches a real notification centre or somebody's phone.

Desktop reminders are a setting (`desktopReminders`, off by default) because they are a property of the installation that the dashboard should be able to switch; the webhook is switched on by the presence of its address. `tokengator notify` runs one check and exits, for people who would rather let cron or Task Scheduler do it than keep the service running. What was raised is kept in `reminders.json` next to the state file: keys only, pruned as windows end.

Not built: Web Push (it would add an internet round trip to reach the same screen, and a phone cannot subscribe to a loopback origin), an installer for starting at login (the documentation gives the three per-system recipes instead), and per-account work hours.

## Provider sources

What each shipped collector reads, and how sure the research pass was of it. `research.md` in this change has the sources and the verification verdicts.

| Collector | Reads | Standing |
| --- | --- | --- |
| `claude-statusline` | The JSON Claude Code pipes to its status line command: `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` and `resets_at` (Unix seconds). | Documented by Anthropic. Present only for subscription sign-ins, and only after the first response of a session. |
| `antigravity-statusline` | The JSON the Antigravity CLI pipes to its status line command: `quota.<bucket>.remaining_fraction` and `reset_time`. | Documented by Google. Buckets are created as they appear, since their names are per model family. |
| `codex-sessions` | The newest `payload.rate_limits` snapshot in `~/.codex/sessions/**/rollout-*.jsonl`: `primary` and `secondary`, each with `used_percent`, `window_minutes` and `resets_at`. | A local file format, not a contract. Windows are classified by their length, never by position, because plans differ in which window comes first. |
| `elevenlabs` | `GET /v1/user/subscription`: `character_count`, `character_limit`, `next_character_count_reset_unix`. | Documented. The reset field is optional, so a missing one leaves the schedule as it was. |
| `openrouter` | `GET /api/v1/credits`: `total_credits`, `total_usage`. | Documented. Needs a key allowed to read credits. |
| `openai-costs` | `GET /v1/organization/costs` in daily buckets. | Documented. Needs an organisation admin key. |
| `anthropic-costs` | `GET /v1/organizations/cost_report` in daily buckets. | Documented. Needs an organisation admin key; data ends at the last UTC midnight. |
| `copilot` | `GET /copilot_internal/user`: `quota_snapshots.premium_interactions` and `quota_reset_at`. | Undocumented and labelled so. The editor uses it; GitHub may change it without notice. |

Everything else in the catalog has no source that could be verified and that a third party may call with the user's own key: the provider's usage page is the source, and an agent or the user reads it. Session-cookie endpoints (ChatGPT, Cursor, Suno, Midjourney and others) are deliberately not used: they need browser credentials Tokengator must never hold.

## Risks / Trade-offs

- [Undocumented endpoints change or disappear] → They are opt-in, labelled, isolated per collector, and never the only way to update a meter.
- [A linear forecast is wrong for bursty users] → Tiers use generous thresholds, the inspector shows real samples, and "stale" is surfaced so old data is not trusted.
- [Manual meters go stale and the dashboard cries wolf] → Staleness is shown on the bar and in every summary; the queue separates "use now" from "needs an update".
- [Two processes writing one file] → Lock directory plus read-modify-write inside the lock; covered by a concurrency test.
- [Local web servers are a classic rebinding target] → Host and Origin checks on every route, JSON-only writes, optional token; the MCP endpoint sits behind the same checks.
- [Catalog prices and limits drift] → Presets are a starting point and every field is editable; the catalog records the date it was checked.
- [Reminders become noise and get switched off] → One per quota per window, none for windows under two days, several folded into one.
- [A notification command could be made to run something] → Text is passed as arguments or environment variables to a fixed command, never through a shell; covered by a test with hostile names.
- [The skill could push agents to burn quota for its own sake] → The skill forbids it in so many words and the spec has a requirement for it.

## Migration Plan

New package; nothing to migrate. Rollback is deleting `tokengator/`, the CI job and the ESLint ignore entry. The state file carries a `version` field so later changes can migrate it.

## Open Questions

- Whether to offer a system-tray companion. It would not change any spec here and can be added on top of the HTTP API.
- Whether to add an installer for starting at login. The recipes are documented; an installer has to be tested on each system it writes to.
