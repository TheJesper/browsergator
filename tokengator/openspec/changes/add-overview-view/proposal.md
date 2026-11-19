# Add an Overview view

## Why

The six views each answer one question from one angle: the Queue ranks quotas, the Board groups them by
subscription, the Timeline places resets on an axis, History looks back. Nothing puts the answers side by
side. People asked for a "box view, more like a dashboard": one screen of tiles that says what to use now,
how much value is about to expire and when, whether the habit is improving, and which numbers to refresh
before trusting them.

Research for this change (summarised in `design.md`, sources in `research.md`) found:

- AI usage trackers that have an overview (OpenUsage, CodexBar, ClaudeBar, Headroom, CodeBurn, Splitrail,
  tokscale) treat leftover quota as the good state, draw rings and gauges, and answer "am I about to run
  out" or "what did I spend". None forecasts what will expire, and none keeps a record of what did.
- The closest analogues are prepaid cloud commitments (AWS Reserved Instances and Savings Plans utilisation
  reports, "unused commitment"), mobile data plans ("N days left at this pace", a daily allowance to
  finish) and expiry trackers for points and gift cards (an inventory sorted by date). Their devices map
  directly onto this product: utilisation over time, two durations side by side, and expiry by date.
- Everything an overview needs can be derived from today's state: per-meter forecasts, future resets from
  each rule, the ledger of finished windows, and spend days. No new data has to be captured.

## What changes

- A seventh view, **Overview**, first among the tabs and reached with the key `0`. The Queue stays the
  first screen on a first visit; the last view used is restored as before.
- Seven tiles in a responsive grid, each answering one question:
  1. **Use before the reset**: the quotas to use now, as queue rows, with the rate that uses the first one
     up before its reset.
  2. **What expires, and when**: the money expected to expire at each reset over the next 30 days, hatched
     as a forecast, plan money and dollar credits on separate lanes.
  3. **Finished windows**: money expired in the last 30 days against the 30 days before, the share used,
     and both week by week for twelve weeks.
  4. **Needs attention**: stale readings, quotas without a reset time, and closed rate limits.
  5. **Every quota against an even pace**: each running quota at its share of the window gone and its
     share used, beside the even-pace diagonal.
  6. **Plan fit, last 90 days**: subscriptions by the share of their windows used, with the money left.
  7. **API spend this month**: spend against budget, when spend sources exist.
- Tiles other than the first two can be hidden from a Tiles menu; the choice is remembered.
- On the Overview the summary strip keeps its sentence and leaves the figures that a tile states.
- New pure functions in `src/core/insights.ts` (expiry outlook, weekly ledger totals, totals per
  subscription, refresh list, tier counts, when a quota next needs using) and shared wording in
  `src/core/wording.ts`. The brief, `tokengator status` and the MCP `waste_report` use the same wording for
  the money expired and the share used, and `waste_report` can return the weekly totals.
- The sample data gains finished windows of bundled API credits, so the credits paths are shown and tested.

## Impact

- Specs: `usage-dashboard` (ADDED and MODIFIED), `waste-ledger` (ADDED and MODIFIED), `mcp-server` (MODIFIED).
- Code: `src/core/insights.ts` (new), `src/core/wording.ts`, `src/core/brief.ts`, `src/core/demo.ts`,
  `src/core/reminders.ts`, `src/cli/render.ts`, `src/server/mcp.ts`, `src/web/overview.ts` (new),
  `src/web/charts.ts`, `src/web/app.ts`, `src/web/main.ts`, `src/web/ui.ts`, `src/web/views.ts`,
  `public/app.css`.
- Tests and checks: new unit tests for the core functions and wording, browser checks for the view.
- Docs: README view list and keys, `docs/MCP.md` for `waste_report`.
