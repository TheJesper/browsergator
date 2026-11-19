# Tasks

## 1. Package scaffold

- [ ] 1.1 Create the `tokengator/` package (package.json, tsconfig, ESLint with core/web import boundaries, Vitest) and verify `npm ci` installs with zero audit findings in production dependencies
- [ ] 1.2 Exclude `tokengator/` from the root ESLint run and verify the root `npm run lint` still passes
- [ ] 1.3 Add `scripts/build.mjs` (tsc for server and CLI, esbuild bundle for the dashboard, static copy, single-file sample build) and verify `npm run build` produces `dist/cli/main.js` and `dist/public/index.html`

## 2. Quota model (quota-tracking)

- [ ] 2.1 Define the state types and zone-aware time helpers; verify with unit tests for `zonedTimeToUtc` across DST changes and month-length clamping
- [ ] 2.2 Implement reset rules, window anchoring and automatic roll-over; verify with tests for every scenario under "Reset rules" and "Windows roll over automatically"
- [ ] 2.3 Implement readings, including window moves and rolling-window starts; verify with tests for "Readings update a meter" and "Readings can move the window"
- [ ] 2.4 Implement account, meter and settings transitions with shared validation; verify rejected inputs name their field
- [ ] 2.5 Implement export and strict import; verify an export imports back to an identical state and an invalid document leaves state untouched
- [ ] 2.6 Write the provider catalog from the verified research and verify every preset builds a valid account (test iterates the whole catalog)

## 3. Forecast and wording (waste-forecast)

- [ ] 3.1 Implement projection, value at risk, tiers, action horizon, required pace, throttle state and staleness; verify each spec scenario with a unit test using the scenario's own numbers
- [ ] 3.2 Implement orderings and the summary; verify "use first" order and snooze placement with tests
- [ ] 3.3 Implement shared wording, the Markdown brief, the machine snapshot and the agent prompt; verify the dashboard, CLI and MCP outputs contain the same headline for the same meter

## 4. Ledger (waste-ledger)

- [ ] 4.1 Record finished cycles with value and confidence, including the unobserved-window rules; verify with tests for every ledger scenario
- [ ] 4.2 Compute trailing totals and per-meter history, cap the ledger at 2,000 entries; verify totals per currency and the cap with tests

## 5. Quick entry

- [ ] 5.1 Implement the quick-entry grammar and "when" expressions; verify with a table-driven test covering percentages, amounts, ratios, durations, weekdays, clocks and dates
- [ ] 5.2 Implement loose account and meter resolution with candidates on ambiguity; verify exact ids, prefixes and ambiguous names with tests

## 6. Local service (local-service)

- [ ] 6.1 Implement the file store with lock directory, atomic replace, corrupt-file handling and change detection; verify with a test that runs two concurrent writers and one that starts from a corrupt file
- [ ] 6.2 Implement the application service on top of the store; verify with tests using the in-memory store and an injected clock
- [ ] 6.3 Implement the HTTP server: routing, JSON bodies with a 256 KB cap, static files, server-sent events; verify every row of the D15 contract with an integration test on an ephemeral port
- [ ] 6.4 Implement Host and Origin validation, the optional token with bearer and session cookie, and the non-loopback start guard; verify each "Request validation" and "Optional access token" scenario
- [ ] 6.5 Document the service in `tokengator/README.md` (start, configuration, security model) and verify the documented commands run as written

## 7. MCP server (mcp-server)

- [ ] 7.1 Build the MCP server with the tools, resources and prompt in D10; verify with an in-memory client that lists and calls each tool
- [ ] 7.2 Mount it statelessly at `/mcp` behind the service's request validation and add the stdio entry point; verify an HTTP round trip and a stdio round trip
- [ ] 7.3 Verify error behaviour: invalid percentage, ambiguous account, unknown meter, removal without confirmation
- [ ] 7.4 Document the tools in `tokengator/docs/MCP.md` with one example call each and verify the examples against the tests

## 8. Collectors (usage-collectors)

- [ ] 8.1 Implement the collector contract, the restricted fetch (same host, HTTPS, no cross-host redirect, timeout) and the runner with opt-in, scheduling, isolation and backoff; verify with fake collectors
- [ ] 8.2 Implement the Claude Code status line command; verify with recorded sample input and with input lacking rate limits
- [ ] 8.3 Implement the Codex session-log collector; verify against fixture logs including stale-only logs
- [ ] 8.4 Implement the documented-API collectors (ElevenLabs, OpenRouter, OpenAI costs, Anthropic costs); verify each with a mocked response and an authorisation failure
- [ ] 8.5 Implement the opt-in undocumented-API collectors that the research verified; verify each with a mocked response and confirm they are labelled as undocumented
- [ ] 8.6 Verify no credential reaches state, logs, API output or error messages (test scans all outputs for the fixture secrets)
- [ ] 8.7 Document every collector in `tokengator/docs/COLLECTORS.md` (source, what is read, variables, stability)

## 9. Command line

- [ ] 9.1 Implement `serve`, `status` (text and JSON), `set`, `add`, `mcp`, `statusline`, `collectors`, `connect`, `doctor`; verify each with a CLI test against a temporary home
- [ ] 9.2 Implement `skill install` with dry-run and uninstall, writing only its own files and managed blocks; verify idempotence and that surrounding text is untouched

## 10. Dashboard (usage-dashboard, api-cost-tracking)

- [ ] 10.1 Define the design tokens for both themes and validate chart colours with the palette validator; verify contrast targets with a scripted check
- [ ] 10.2 Build the data layer with HTTP and in-memory backends and live updates; verify the in-memory backend with unit tests
- [ ] 10.3 Build the forecast bar, summary strip and Queue view with inspector; verify in a browser at 1280 and 400 pixels in both themes
- [ ] 10.4 Build the Board, Timeline, Table, Costs and History views over the shared ordering and filters; verify each renders the sample data and switches by key
- [ ] 10.5 Build quick entry, add and edit dialogs, delete confirmation, snooze, and the Connect panel; verify each flow end to end in a browser test
- [ ] 10.6 Build copy actions with visible confirmation and the manual-copy fallback; verify clipboard contents in a browser test
- [ ] 10.7 Add keyboard shortcuts, focus management, reduced motion, notifications opt-in and the title badge; verify with a keyboard-only browser test
- [ ] 10.8 Add spend sources, daily entries and the month projection to the core and the Costs view; verify the projection scenario with a unit test
- [ ] 10.9 Build the single-file sample page and verify it runs with no network access

## 11. Agent skill (agent-skill)

- [ ] 11.1 Write the skill, including the rule that agents never spend quota on their own initiative; verify the installer test finds that rule in the installed text
- [ ] 11.2 Add the skill and MCP setup to the README and verify the snippets match what `tokengator connect` prints

## 12. Reminders (reminders)

- [ ] 12.1 Implement the reminder rule in the core (due, wording, digest, remembered keys with tolerance); verify every scenario under "One reminder per quota per window" and "Reminder wording" with unit tests
- [ ] 12.2 Implement the calendar feed in the core; verify the weekly, monthly, exclusion, first-use and escaping scenarios, and the 75-octet line limit
- [ ] 12.3 Implement the desktop channel per platform and the webhook channel; verify that hostile text stays data, that the address is validated and never echoed, and the Slack and Discord shapes
- [ ] 12.4 Implement the runner (setting, record file, any-channel rule, backoff, sample-data guard); verify with fake channels and a temporary home, including a restart and a damaged record
- [ ] 12.5 Add the status, test and calendar routes to the HTTP API and the `desktopReminders` setting; verify with integration tests, including the token and sample-data cases
- [ ] 12.6 Add `tokengator notify` (with `--dry-run` and `--test`) and `tokengator calendar`; verify with CLI tests against a temporary home
- [ ] 12.7 Build the Reminders panel in the dashboard and route browser notifications through the shared rule; verify in the browser check
- [ ] 12.8 Document reminders in `tokengator/docs/REMINDERS.md` (channels, rules, starting at login, privacy) and link it from the README

## 13. Integration

- [ ] 13.1 Add a CI job that lints, type-checks, tests, builds and audits `tokengator/` on the existing OS and Node matrix
- [ ] 13.2 Run an end-to-end pass: start the service on a temporary home, add accounts over HTTP, report over MCP, confirm the dashboard updates live
- [ ] 13.3 Run an independent review of correctness, security and the interface, and resolve what it finds
- [ ] 13.4 Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` in both the root and `tokengator/`, and `openspec validate --all --strict`

## Workflow follow-up

- Archive the change with `openspec archive add-tokengator-dashboard` once every task is checked and the review findings are resolved.
- Verify the archived specs under `openspec/specs/` validate with `openspec validate --all --strict`.
