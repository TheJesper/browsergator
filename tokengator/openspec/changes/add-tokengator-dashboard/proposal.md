# Proposal

## Why

AI subscriptions are sold as quota that expires: a 5-hour session window, a weekly cap, a monthly pile of premium requests, characters or credits. Whatever is left when the window resets is gone, and it is paid for either way. Someone running Claude, Codex, Copilot, Gemini, ElevenLabs and Suno side by side has a dozen independent clocks and no single place that says "go use this one now, it resets in 14 hours and 38% of it is still there".

Existing tools mostly answer a different question. The category is dominated by macOS menu-bar apps for coding plans (CodexBar, OpenUsage, ClaudeBar, Quotio and a dozen more) and by token-cost analysers (ccusage, tokscale, Splitrail). They are built around the fear of running out: quota left over is drawn green and called headroom or reserve. A few have started to notice the opposite problem: OpenUsage has a "Use It or Lose It" section for windows that reset within a day, CodexBar and GenAIUsageWidget have opt-in reminders before a reset, Tokenkarma sells an under-use alert in its top tier, and two small projects (`aiuse`, a CLI, and `claude-quota-tracker`, macOS and Claude only) are built around the idea. In the larger tools it is a secondary notification, and the research found no tool that:

- makes expiring quota the primary view and ranks every subscription by it,
- puts a money value on the loss where a person sees it at a glance, and keeps a record of what actually expired (one small CLI, `aiuse`, computes a value at risk; no dashboard shows one),
- runs the same on Windows, macOS and Linux (most are macOS only),
- covers plans with no API at all: Suno, Midjourney, Runway and most creative tools are tracked by nobody,
- lets a subscription be declared by hand in seconds and kept current by an agent that can see the usage page,
- gives agents a tool that answers "which plan should this task spend" and a way to report what they read (the quota MCP servers that exist are read-only, cover one or two coding providers, and at most nudge about the 5-hour window).

See `research.md` for the survey and its sources.

Tokengator turns the problem around: every quota is a deadline, and the product's one job is to make sure nothing reaches its deadline unused.

## What Changes

- Add a new self-contained package, `tokengator/`, to this repository: a local web dashboard, an HTTP API, an MCP server (Streamable HTTP and stdio), a CLI and an agent skill. Nothing in the Browsergator gateway changes.
- Model any subscription as an account with meters. A meter has an amount, a limit, a unit and a reset rule (rolling window, fixed interval, daily or monthly wall-clock boundary, one-off expiry, or no clock). A built-in catalog pre-fills the plans people actually have; anything else can be added by hand.
- Forecast waste for every meter: pace against the clock, projected unused share at reset, the money that share represents, and how much faster than usual the quota would have to be burned to finish it.
- Rank quotas by what needs using first, in plain urgency tiers (use now, behind pace, running hot, on pace, used up), with alternative orderings (soonest reset, most left, most value at risk, name, stalest).
- Keep a waste ledger: each finished window is recorded with what was actually left, so the dashboard can show money lost over the last 30 days and whether utilisation is improving.
- Offer several view modes over the same data: a ranked queue with an inspector, a card board, a reset timeline, a dense table, API costs, and history.
- Put a copy affordance on every item (status line, Markdown, JSON, agent prompt), a "copy brief" for the whole picture, and copyable connection snippets for MCP clients.
- Make updating a number take seconds: a quick-entry line that understands `claude weekly 62%` or `suno 1200 left resets in 9d`, available in the dashboard, the CLI and over MCP.
- Collect readings automatically where a trustworthy source exists (Claude Code status line data, Codex session logs, ElevenLabs and OpenRouter APIs, OpenAI and Anthropic cost APIs, GitHub Copilot), and let any agent with a browser act as the universal adapter for the rest through the MCP `report_usage` tool.
- Reach the person when the dashboard is closed, since that is when quota expires: one reminder per quota per window, as a notification on the computer, a message to an address of their own (an ntfy topic, a Slack or Discord webhook), and a calendar of upcoming resets.
- Optionally track pay-as-you-go API spend per provider against a monthly budget.
- Ship a skill that teaches agents to check Tokengator before starting heavy work, to prefer the subscription with the most quota at risk, and to refresh stale numbers from the providers' usage pages.

## Capabilities

### New Capabilities

- `quota-tracking`: accounts, meters, units, reset rules, readings, automatic window roll-over, and the provider catalog.
- `waste-forecast`: pace, projection, value at risk, urgency tiers, staleness, and the orderings built on them.
- `waste-ledger`: the record of finished windows and the totals derived from it.
- `usage-dashboard`: the web interface: view modes, sorting and filtering, the inspector, quick entry, copy actions, themes, notifications, keyboard use, and sample-data mode.
- `mcp-server`: the tools, resources and prompts agents use to read and update quota state, over Streamable HTTP and stdio.
- `usage-collectors`: automatic readings from local files and provider APIs, their scheduling, and how credentials are handled.
- `api-cost-tracking`: optional pay-as-you-go spend sources, daily entries and monthly budgets.
- `local-service`: the local HTTP API, persistence, network exposure and request validation, and the command-line interface.
- `agent-skill`: the skill that tells agents when and how to use Tokengator.
- `reminders`: which quotas earn a reminder and when, the desktop and webhook channels, the record of what was raised, and the calendar of resets.

### Modified Capabilities

None. This is the first OpenSpec change in the package; the Browsergator gateway's behaviour is unchanged.

## Impact

- **New code**: `tokengator/` (TypeScript, Node 22+). Runtime dependencies are the MCP server SDK (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`) and `zod` only; the browser bundle has none.
- **Repository**: the root ESLint config ignores `tokengator/` (the package lints itself), CI gains a job that lints, type-checks, tests, builds and audits the package, and the root README links to it.
- **Local machine**: a state file under `~/.tokengator/` (override with `TOKENGATOR_HOME`), and a loopback HTTP listener on port 4777 while the dashboard is running.
- **Outbound**: nothing leaves the machine unless the user switches on a collector or sets a reminder address; desktop reminders run the operating system's notification command.
- **Security**: loopback by default, Host and Origin validation, an optional bearer token that becomes mandatory off loopback. Provider credentials are read from the environment at call time and are never stored, logged or returned by any interface.
- **Browsergator**: no coupling. The skill mentions that an agent with a browser can read a provider's usage page and report the numbers; it does not require Browsergator and does not touch its gateway, CDP target or profile.
