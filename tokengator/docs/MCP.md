# Tokengator MCP server

The MCP server gives an agent the same quota picture a person sees in the dashboard, and a way to keep it
current: which subscription to spend first, what is about to expire, and tools to record fresher numbers.
It reads and changes Tokengator's records and does nothing else (see [What the tools never do](#what-the-tools-never-do)).

Server name: `tokengator`. 13 tools, 2 resources, 1 prompt.

## Transports

Both transports build the same server on the same stored state (`~/.tokengator/state.json`, or
`TOKENGATOR_HOME`). A reading reported over one is visible over the other and in the dashboard.

| | Streamable HTTP | stdio |
| --- | --- | --- |
| Address | `http://127.0.0.1:4777/mcp` on the local service | `tokengator mcp` |
| Needs the service running | yes | no, it opens the state file itself |
| Use it when | the dashboard is running anyway, several agents share it, or the client speaks HTTP | the client only launches stdio servers, or the service is not running |
| Access control | the service's Host and Origin checks, plus `Authorization: Bearer <token>` when `TOKENGATOR_TOKEN` is set | none needed: no network listener |
| Reporter recorded on a reading | `agent:<client name>` for clients of the 2026-07-28 revision, `agent:mcp` for clients that open with a handshake | `agent:<client name>` |

`tokengator connect` and the dashboard's Connect panel print the exact registration command for each
client. Two typical ones:

```sh
claude mcp add --transport http --scope user tokengator http://127.0.0.1:4777/mcp
```

```json
{ "mcpServers": { "tokengator": { "command": "tokengator", "args": ["mcp"] } } }
```

Details of the HTTP endpoint:

- It is stateless. Every `POST` is answered by a fresh server with plain JSON (no event stream) and no
  session id, so restarting the service never leaves a client holding a dead session.
- `GET` and `DELETE` answer `405` with a JSON-RPC error. Clients treat that as "no server-sent stream, no
  session to end" and carry on.
- A client of the 2026-07-28 revision names itself in every request, so its readings are attributed to
  `agent:<client name>`. An older client names itself once, in a handshake that a stateless endpoint
  does not keep, so its readings over HTTP are attributed to `agent:mcp`.
- The stdio server writes only protocol messages to standard output; logs go to standard error. It ends
  when its standard input closes.

## Tools

| Tool | Read-only | What it does |
| --- | --- | --- |
| `what_to_use` | yes | Allowance meters in "use first" order with tier, share left, time to reset, money at risk, required pace, staleness, blocking rate limit and a recommendation. |
| `list_accounts` | yes | Every account with all of its meters, plan, price and usage-page address. Optional `provider` filter. |
| `get_account` | yes | One account in full: meters with forecasts and explanations, the readings of the current window, recently finished windows, notes. |
| `list_catalog` | yes | Provider presets. With a `provider`: its plans and meters, the address of its usage page and which figures to read there. |
| `waste_report` | yes | What actually expired unused in the last `days` days (default 30): totals, a per-meter breakdown and, with `byWeek`, week by week. |
| `get_costs` | yes | Pay-as-you-go API spend per source: month to date, projection, budget status. |
| `report_usage` | no | Records a reading for one meter: used or remaining, as an amount or a percentage, and optionally the reset time. |
| `quick_update` | no | Records a reading from one quick-entry line such as `claude weekly 62%`. |
| `record_spend` | no | Records one day of API spend against a spend source, optionally creating the source. |
| `add_account` | no | Adds an account from a catalog preset or from a custom definition. |
| `update_account` | no | Changes account fields, snoozes or wakes the account, or changes one meter's settings. Overwrites stored values. |
| `remove_account` | no | Removes an account and its meters. Requires `confirm: true`; without it the call only describes what would be removed. |
| `refresh_usage` | no | Runs the enabled collectors now and reports the outcome per collector. The only tool that may contact provider APIs. |

Annotations: the read-only tools declare `readOnlyHint: true`. `update_account` and `remove_account` declare
`destructiveHint: true`. `refresh_usage` declares `openWorldHint: true`; every other tool works on local
state only.

## Protocol revisions

The server speaks the current revision of MCP, 2026-07-28, and the earlier ones that open with an
`initialize` handshake (2025-11-25 and older), from the same definitions. A client does not have to
choose: one that probes for the newer revision gets it, one that sends `initialize` is answered as
it expects. Over HTTP the endpoint is stateless on both: no session id, a plain JSON answer per
POST, and 405 for GET and DELETE. Clients of the current revision name themselves in every request,
so their readings are attributed by name (`agent:<name>`) over HTTP as well.

## Conventions

**Two forms of every result.** Each tool returns a short text block written to be quoted and a
`structuredContent` object to compute on. Every tool publishes an output schema; the schemas allow
additional fields.

**Time.** Agents have no clock, so every text result that depends on the time starts with
`As of <local time> <zone> (<UTC instant>).` The reading tools whose answer depends on the time also return
`generatedAt` and `timeZone`. All instants in structured content are ISO 8601 in UTC. An instant you send
(`resetsAt`) must carry a zone, for example `2026-11-21T09:00:00Z` or `2026-11-21T10:00:00+01:00`; for a
countdown shown on a page use `resetsInMinutes` instead.

**Naming an account.** `account` accepts the account id (`claude-max`), its label, its provider, or any
words that match exactly one account. A name that matches several is refused with the candidates.

**Naming a meter.** `meter` accepts the meter id (`claude-max:weekly`), its key (`weekly`), its label, or
unambiguous words from them, and is looked up inside the account already found. Omitted, `report_usage`
uses the account's main allowance.

**Meter records.** Wherever a meter appears in structured content it has these fields:

| Field | Meaning |
| --- | --- |
| `id`, `key`, `meter` | Meter id (`<account id>:<key>`), key and label. |
| `accountId`, `account`, `provider`, `plan` | The account it belongs to. |
| `role` | `allowance` (prepaid quota lost at the reset) or `throttle` (a rate window; nothing of value expires). |
| `tier`, `state` | Allowances: `use-now`, `behind`, `hot`, `on-pace`, `fresh`, `idle`, `balance`, `spent` or `expired`. Throttles: `open`, `blocked` or `idle`. `state` is the same as a label. |
| `unit`, `limit`, `used`, `remaining`, `usedPercent`, `remainingPercent` | Amounts in the meter's own unit, and as shares of the limit. |
| `resetsAt`, `resetsInMinutes`, `windowHours` | The current window. `null` when no window is running or the reset time is unknown. |
| `projectedUnusedPercent` | Share of the allowance expected to expire at the current pace. `null` without a forecast. |
| `valueAtRisk`, `currency` | Money that share stands for. `null` when the account has no price. |
| `valueBasis` | `plan`: a share of the plan fee, an estimate. `credit`: the face value of a credit counted in dollars. Say "in credits" for the second; never add the two. |
| `requiredPaceMultiple` | How many times the pace so far is needed to finish the quota. |
| `blockedBy`, `blockedUntil` | A rate limit of the same account that is exhausted right now. |
| `stale`, `updatedAt`, `source`, `estimated` | Age of the reading, who reported it (`manual`, `agent:<name>`, `collector:<id>`, `statusline:<id>`), and whether the numbers are assumed after an unobserved reset. |
| `snoozed` | The account is hidden from the queue and from alerts for now. |
| `headline`, `recommendation` | The same sentences the dashboard shows. |

`null` means unknown or not applicable, never zero.

## Examples

The examples share one starting state, at 12:00 UTC on 19 November 2026: Claude Max at $100 a month (weekly
limit 40% used and resetting in 10 hours, plus a 5-hour session limit), Suno Pro (2,500 credits, no reading
yet), Copilot Pro (185 of 300 premium requests, resets on the 1st), two used-up team seats (Team Alpha,
Team Beta), three finished windows in the last 30 days, and one spend source (OpenRouter, $50 budget).
Each example starts from that state. Results are abbreviated.

### `what_to_use`

<!-- example: what_to_use -->

```json
{}
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
1 quota needs using now, $13.18 at risk.

1. Claude Max, Weekly limit: Use now: 60% left, resets in 10h ($13.18 at risk)
   Prefer Claude Max for work the user wants done now: 60% left and it resets in 10h ($13.18 would expire).
2. Copilot Pro, Premium requests: On pace: 115 requests left, resets in 11d
3. Suno Pro, Credits: Reset time unknown: 2,500 credits left (no reading yet)
4. Team Alpha, Weekly: Used up: resets in 3d
5. Team Beta, Weekly: Used up: resets in 3d
```

The text lists the meters of every account that is not snoozed, up to `limit` (1 to 50, default 10).

Structured content, selected fields. `queue` holds full meter records, most urgent first. Unless
`includeSettled` is true it leaves out meters with nothing left to spend (used up, expired, or a balance
without a reset), and `omitted` counts what was left out. Meters of a snoozed account come last, marked
`snoozed`. `throttles` lists the rate limits for context:

```json
{
  "generatedAt": "2026-11-19T12:00:00.000Z",
  "timeZone": "UTC",
  "summary": { "useNow": 1, "behind": 0, "hot": 0, "stale": 0, "utilisation30Percent": 71.7, "lost30IsEstimate": true, "creditsLost30IsEstimate": false },
  "queue": [
    { "id": "claude-max:weekly", "tier": "use-now", "remainingPercent": 60, "resetsInMinutes": 600, "resetsAt": "2026-11-19T22:00:00.000Z" },
    { "id": "copilot-pro:premium", "tier": "on-pace" },
    { "id": "suno-pro:credits", "tier": "idle" }
  ],
  "throttles": [{ "id": "claude-max:session", "tier": "open" }],
  "omitted": { "settled": 2, "beyondLimit": 0 }
}
```

`summary` also holds what the ledger recorded over the last 30 days: plan money expired in `lost30` and
dollar credits in `creditsLost30`, per currency and never added together. `lost30IsEstimate` is true when
part of `lost30` comes from windows nobody read near their end, and `creditsLost30IsEstimate` says the
same of `creditsLost30`; each flag covers its own total only. `tokengator status --json` prints the same
record.

### `list_accounts`

<!-- example: list_accounts -->

```json
{ "provider": "claude" }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
1 account.

Claude Max (id: claude-max, plan Max, $100 a month) https://claude.example/usage
- Weekly limit [weekly]: Use now: 60% left, resets in 10h
- 5-hour session [session]: Open: 12% used, resets in 3h
```

```json
{
  "accounts": [
    {
      "id": "claude-max",
      "label": "Claude Max",
      "provider": "claude",
      "plan": "Max",
      "price": { "amount": 100, "currency": "USD", "period": "month" },
      "usageUrl": "https://claude.example/usage",
      "meters": [{ "id": "claude-max:weekly" }, { "id": "claude-max:session" }]
    }
  ]
}
```

### `get_account`

<!-- example: get_account -->

```json
{ "account": "copilot" }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Copilot Pro (id: copilot-pro, provider copilot, $10.00 a month)

### Copilot Pro, Premium requests

**On pace: 115 requests left, resets in 11d**

- Used: 185 of 300 requests
- Left: 115 requests
- Resets: Tue 1 Dec 00:00 (in 11d)
...
```

Each meter is a meter record plus `explanation`, `reset` (the rule), `rollover`, `valueShare`, `samples`
(readings of the current window, oldest first) and `cycles` (recently finished windows, oldest first):

```json
{
  "account": { "id": "copilot-pro", "notes": null, "snoozedUntil": null },
  "meters": [
    {
      "id": "copilot-pro:premium",
      "used": 185,
      "remaining": 115,
      "reset": { "kind": "monthly", "day": 1, "time": "00:00", "tz": "UTC" },
      "samples": [{ "t": "2026-11-19T12:00:00.000Z", "used": 185 }],
      "cycles": []
    }
  ]
}
```

### `list_catalog`

<!-- example: list_catalog -->

```json
{ "provider": "elevenlabs" }
```

```text
ElevenLabs (id: elevenlabs, ElevenLabs, voice). Catalog checked 2026-11-19; limits and prices drift, so trust the usage page over the preset.
Usage page: https://elevenlabs.io/app/subscription
What to read there: The subscription page shows credits used out of the monthly quota and the date the quota resets.
Plans:
- starter (Starter, $6.00 a month): unused credits roll over, up to twice the monthly quota
  - Monthly credits [credits]: allowance, 30K credits, renews monthly on the billing day
- creator (Creator, $22.00 a month): unused credits roll over, up to twice the monthly quota
  - Monthly credits [credits]: allowance, 121K credits, renews monthly on the billing day
...
```

```json
{
  "providers": [
    {
      "id": "elevenlabs",
      "name": "ElevenLabs",
      "usageUrl": "https://elevenlabs.io/app/subscription",
      "howToRead": "The subscription page shows credits used out of the monthly quota and the date the quota resets."
    }
  ]
}
```

Without `provider` the result is a compact list (id, name, category, usage page, plan ids and prices) and
`known` lists every provider id. An unknown provider is not an error: `providers` is empty and the text
lists the known ids. Anything the catalog lacks can be tracked with a custom account.

### `report_usage`

<!-- example: report_usage -->

```json
{ "account": "suno", "remaining": 1200, "resetsInMinutes": 12960, "note": "usage page" }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Recorded, reported by agent "claude-code".
Suno Pro, Credits: Behind pace: 1,200 credits left, about 25% will expire, resets in 9d ($2.48 at risk)
1,300 of 2,500 credits used with 30% of the window left. At this pace about 25% expires unused, worth $2.48. Finishing it takes 2.2× the pace so far.
```

```json
{
  "accountId": "suno-pro",
  "meterId": "suno-pro:credits",
  "meter": {
    "id": "suno-pro:credits",
    "used": 1300,
    "remaining": 1200,
    "resetsAt": "2026-11-28T12:00:00.000Z",
    "resetsInMinutes": 12960,
    "source": "agent:claude-code",
    "stale": false
  }
}
```

Arguments: `account` (required), `meter`, at most one amount (`used`, `remaining`, `usedPercent` or
`remainingPercent`; percentages are 0 to 100), `limit`, a reset as `resetsAt` or `resetsInMinutes`, and
`note`. A call needs an amount, a reset, or both. The reading is stored with the reporter and the note,
and the result states the meter's new forecast.

### `quick_update`

<!-- example: quick_update -->

```json
{ "text": "claude weekly 62% resets in 9h" }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Saved: Claude Max, Weekly limit: 62% used, 38% left, resets today 21:00 (in 9h)
Claude Max, Weekly limit: Use now: 38% left, resets in 9h ($7.91 at risk)
62% used with 5% of the window left. At this pace about 34% expires unused, worth $7.91. Finishing it takes 11× the pace so far.
```

```json
{
  "accountId": "claude-max",
  "meterId": "claude-max:weekly",
  "meter": { "usedPercent": 62, "resetsAt": "2026-11-19T21:00:00.000Z", "source": "agent:claude-code" }
}
```

The line is `account [meter] amount [reset]`, the same form as the dashboard's quick entry. A bare amount
means used. `preview` in the structured content repeats how the line was understood.

### `add_account`

From a preset:

<!-- example: add_account -->

```json
{ "provider": "elevenlabs", "plan": "creator" }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Added ElevenLabs Creator (id: elevenlabs-creator), plan Creator, $22.00 a month.
- Monthly credits [credits]: Reset time unknown: 121K credits left (no reading yet)
Usage page: https://elevenlabs.io/app/subscription. What to read there: The subscription page shows credits used out of the monthly quota and the date the quota resets.
No reading yet. Record the current numbers with report_usage.
```

```json
{
  "account": {
    "id": "elevenlabs-creator",
    "provider": "elevenlabs",
    "plan": "Creator",
    "price": { "amount": 22, "currency": "USD", "period": "month" }
  },
  "meters": [{ "id": "elevenlabs-creator:credits", "limit": 121000, "used": 0, "source": "agent:claude-code" }]
}
```

From a custom definition:

<!-- example: add_account -->

```json
{
  "price": { "amount": 30, "currency": "USD", "period": "month" },
  "custom": {
    "label": "Midjourney",
    "usageUrl": "https://www.midjourney.com/account",
    "meters": [
      { "label": "Fast hours", "unit": "hours", "limit": 15, "reset": { "kind": "monthly", "day": 7, "time": "00:00", "tz": "UTC" } }
    ]
  }
}
```

```json
{
  "account": { "id": "midjourney", "provider": "custom", "usageUrl": "https://www.midjourney.com/account" },
  "meters": [{ "id": "midjourney:fast-hours", "unit": "hours", "limit": 15, "resetsAt": "2026-12-07T00:00:00.000Z" }]
}
```

Give exactly one of `provider` or `custom`. `plan` picks the preset's plan by id or name (its first plan
when omitted), `label` renames the account, and `price` overrides the preset price or prices a custom
account (`null` for none). `billingDay` (1 to 31) places a preset's billing-date quota on the day the
subscription renews; without it the first reported reset time sets the schedule. A custom meter takes `label`, `reset` and, optionally, `key`,
`role`, `unit` (default `percent`), `unitLabel`, `limit` (required unless the unit is percent), `used`,
`resetsAt`, `rollover` and `valueShare`. `reset.kind` is one of `rolling` (opens on first use, lasts
`hours`), `interval` (every `hours`; a weekly cap is 168), `daily`, `monthly` (`day`, `time`, `tz`), `once`
or `none`.

### `update_account`

<!-- example: update_account -->

```json
{ "account": "copilot", "snoozeHours": 24, "meter": "premium", "meterPatch": { "limit": 1500 } }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Updated Copilot Pro (id: copilot-pro): snoozeHours, meterPatch.limit.
- Premium requests [premium]: Behind pace: about 78% will expire, resets in 11d
Snoozed until 12:00 UTC (2026-11-20T12:00:00.000Z).
```

```json
{
  "changed": ["snoozeHours", "meterPatch.limit"],
  "account": { "id": "copilot-pro", "snoozedUntil": "2026-11-20T12:00:00.000Z" },
  "meters": [{ "id": "copilot-pro:premium", "limit": 1500, "used": 185, "snoozed": true }]
}
```

Account fields: `label`, `plan`, `price`, `usageUrl`, `notes`, `snoozeHours`. `null` clears `plan`,
`price`, `usageUrl` and `notes`, and wakes a snoozed account. `meterPatch` takes `label`, `limit`, `used`,
`resetsAt`, `reset`, `rollover` and `valueShare`; `meter` may be left out when the account has one meter.
The account and meter changes of one call are checked together before either is saved, so a value that
is refused leaves both untouched.

### `remove_account`

<!-- example: remove_account -->

```json
{ "account": "copilot" }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Not removed. This would stop tracking Copilot Pro (id: copilot-pro) and delete its meter:
- Premium requests [premium]
Finished windows would stay in the waste ledger.
Call remove_account again with confirm: true once the user has agreed.
```

```json
{
  "removed": false,
  "confirmationRequired": true,
  "account": { "id": "copilot-pro", "label": "Copilot Pro" },
  "meters": [{ "id": "copilot-pro:premium", "key": "premium", "label": "Premium requests" }]
}
```

This is a normal result, not an error. The same call with `"confirm": true` removes the account and
answers `"removed": true`.

### `refresh_usage`

<!-- example: refresh_usage -->

```json
{}
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Ran 2 collectors.
- codex-sessions (Codex session logs): ok, updated 2 meters: chatgpt-plus:weekly, chatgpt-plus:session.
- elevenlabs (ElevenLabs API): the credential was rejected. ELEVENLABS_API_KEY was rejected.
```

```json
{
  "available": true,
  "ran": 2,
  "collectors": [
    { "id": "codex-sessions", "ran": true, "outcome": "ok", "updatedMeters": ["chatgpt-plus:weekly", "chatgpt-plus:session"] },
    { "id": "elevenlabs", "ran": true, "outcome": "auth", "message": "ELEVENLABS_API_KEY was rejected.", "updatedMeters": [] }
  ]
}
```

`collectors` limits the run to the given ids. Only collectors the user has enabled are run, also when one
is named. `outcome` is `ok`, `auth` (credential rejected), `unavailable` (nothing to read) or `failed`.
When the process serving MCP has no collectors, the result says so with `"available": false`.

### `waste_report`

<!-- example: waste_report -->

```json
{ "days": 30 }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Last 30 days: 72% used on average over 3 windows; about $18 expired unused.

| Subscription | Meter | Windows | Unused on average | Expired value |
| --- | --- | --- | --- | --- |
| Claude Max | Weekly limit | 2 | 38% | $17.25 |
| Suno Pro | Credits | 1 | 10% | $1.00 |
```

```json
{
  "days": 30,
  "windows": 3,
  "utilisationPercent": 71.7,
  "lost": { "USD": 18.25 },
  "lostIsEstimate": true,
  "creditsLostIsEstimate": false,
  "meters": [
    { "meterId": "claude-max:weekly", "windows": 2, "averageUnusedPercent": 37.5, "lost": { "USD": 17.25 } },
    { "meterId": "suno-pro:credits", "windows": 1, "averageUnusedPercent": 10, "lost": { "USD": 1 } }
  ]
}
```

`days` is 1 to 365, default 30. Money is totalled per currency and never converted. `lost` is plan money
(shares of plan fees); credits counted in dollars that expired are in `creditsLost`, at face value, and
are never part of `lost`. Each meter says which it is in `valueBasis`, and also has `recent`, its last
finished windows inside the period.

`lostIsEstimate` is true when part of `lost`, the plan money, comes from windows nobody read near their
end; `creditsLostIsEstimate` says the same of `creditsLost`. Each flag covers its own total only, so
measured credits beside estimated plan money keep `creditsLostIsEstimate: false`. The text gives an
estimated total as "about" a whole amount, and a measured one to the cent. When no money expired it says
so in words instead of giving an amount: "nothing expired unused", or, when what was left unused has no
price set, that no money is counted.

With `byWeek: true` the answer also carries `weeks`, one entry per Monday-to-Monday week in the user's
time zone, oldest first: every week that holds part of the last `days` days, up to 26 weeks. When `days`
reaches further back than 26 weeks, the entries are the latest 26 and hold fewer windows than the totals.
Each entry has `start`, `windows` closed, how many of those were `estimatedWindows`, plan money `lost`
with its estimated part in `lostEstimated`, dollar credits `creditsLost` with their estimated part in
`creditsLostEstimated`, and `utilisationPercentTrailing30`, the share used over the 30 days ending with
that week. The first week starts on the Monday on or before the start of the period, so it can also hold
windows that closed a few days before it. A week with no closed window has `windows: 0` rather than a
zero amount. The text adds the same weeks as a table under "Week by week:", with estimated amounts
written as "about" a whole amount. It is the record behind the dashboard Overview's "Finished windows"
tile.

### `record_spend`

<!-- example: record_spend -->

```json
{ "source": "openrouter", "amount": 3.2 }
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).
Recorded $3.20 for OpenRouter on 2026-11-19 (set); that day now totals $3.20.
Month to date $19.70, projected $31.11, budget $50.00.
```

```json
{
  "created": false,
  "entry": { "date": "2026-11-19", "amount": 3.2, "mode": "set" },
  "dayTotal": 3.2,
  "source": { "id": "openrouter", "currency": "USD", "monthlyBudget": 50, "monthToDate": 19.7, "overBudget": false }
}
```

`date` is `YYYY-MM-DD` and defaults to today in the user's time zone. `mode` is `set` (replace the day's
total, the default) or `add`. When no source matches, `create: { "label": ..., "currency"?, "monthlyBudget"? }`
creates it first; an existing match is always used as it is.

### `get_costs`

<!-- example: get_costs -->

```json
{}
```

```text
As of 12:00 UTC (2026-11-19T12:00:00.000Z).

| Source | Month to date | Projected | Budget |
| --- | --- | --- | --- |
| OpenRouter | $16.50 | $26.05 | $50.00 |
```

```json
{
  "monthToDate": { "USD": 16.5 },
  "sources": [
    {
      "id": "openrouter",
      "monthToDate": 16.5,
      "monthlyBudget": 50,
      "budgetPercent": 33,
      "overBudget": false,
      "headingOver": false,
      "recentDays": [
        { "date": "2026-11-03", "amount": 12.5 },
        { "date": "2026-11-18", "amount": 4 }
      ]
    }
  ]
}
```

API spend is money spent, not quota. It does not feed tiers, value at risk or the waste ledger.

## Resources

| URI | Media type | Content |
| --- | --- | --- |
| `tokengator://brief` | `text/markdown` | The current situation as Markdown, most urgent first. The same text as the dashboard's "copy brief" and `GET /api/brief`. |
| `tokengator://state` | `application/json` | Everything Tokengator stores: accounts, meters, readings, finished windows, spend and settings. The same document as the export. |

## Prompt

`burn_plan`, with one optional argument `work` (what the user wants to get done). It returns a single user
message that contains the current "use first" queue and asks the model to propose how to spend the quota at
risk on that work, most urgent first, to leave alone quota that nothing useful fits into, and to wait for
the user's choice before starting anything.

## Errors

A call that cannot be carried out returns a normal tool result with `isError: true` and a text that says
what to change. It carries no structured content. A write the tool refused has saved nothing, and its text
says "Nothing was changed."

An account name that matches several accounts:

<!-- example: report_usage error -->

```json
{ "account": "team", "usedPercent": 50 }
```

```text
"team" matches more than one meter. Add a word to tell them apart. Nothing was changed.
Candidates (name one by its id):
- Team Alpha, Weekly (account id: team-alpha, meter id: team-alpha:weekly)
- Team Beta, Weekly (account id: team-beta, meter id: team-beta:weekly)
```

A meter name that matches no meter of the account:

<!-- example: report_usage error -->

```json
{ "account": "claude", "meter": "monthly", "usedPercent": 50 }
```

```text
No meter of Claude Max matches "monthly". Nothing was changed.
Candidates (name one by its id):
- Claude Max, Weekly limit (account id: claude-max, meter id: claude-max:weekly)
- Claude Max, 5-hour session (account id: claude-max, meter id: claude-max:session)
```

A value outside the accepted range, a wrong type or an unknown argument is refused before the tool runs.
That too is a tool result with `isError: true`, and it names the argument:

<!-- example: report_usage error -->

```json
{ "account": "suno", "usedPercent": 140 }
```

```text
Input validation error: Invalid arguments for tool report_usage: usedPercent: must be a percentage from 0 to 100
```

A value the tool itself rejects names the field in parentheses. Errors about a reset time also say what
time it is:

<!-- example: report_usage error -->

```json
{ "account": "suno", "used": 100, "resetsAt": "2026-11-01T00:00:00Z" }
```

```text
Invalid input (resetsAt): resetsAt is in the past. It is now 12:00 UTC (2026-11-19T12:00:00.000Z). Nothing was changed.
```

Unexpected failures answer "Something went wrong inside Tokengator. The service log has the details." The
details stay in the log. `update_account` and `record_spend` with `create` save in two steps; should the
second step fail for a reason of the moment (another process holding the state), the error says that part
of the change was saved.

## What the tools never do

- They never spend quota and never start work. `what_to_use` and the `burn_plan` prompt inform a decision
  that stays with the user; a recommendation to prefer a subscription is not an instruction to use it up.
- They never return credentials, tokens, environment values or the contents of files other than
  Tokengator's own state. Collector messages pass through the same redaction as the logs.
- `remove_account` never removes anything without `confirm: true`, and `refresh_usage` never switches a
  collector on.
- They never convert currencies and never invent a reading: a meter nobody has reported on says "no reading
  yet".
