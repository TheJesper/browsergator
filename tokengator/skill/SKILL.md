---
name: tokengator
description: "Check which AI subscription quota is about to expire unused, and keep Tokengator's numbers fresh. Use before starting heavy or long-running work when more than one subscription (Claude, ChatGPT/Codex, Copilot, Gemini, and others) could do it; when the user asks what to use up, what resets soon, or how much quota is left; and whenever a provider's usage page or a rate-limit message is in front of you."
triggers:
  - "/tokengator"
  - "what should I use up"
  - "what resets soon"
  - "how much quota is left"
  - "which subscription should I use"
---

# tokengator: use quota before it resets

AI subscriptions are sold as quota that expires. A 5-hour session, a weekly cap, a monthly pile of
credits: whatever is left at the reset is gone, and it is paid for either way. **Tokengator** tracks
every one of those clocks for this user and answers one question: *what should be used first so
nothing is wasted?*

You help in two ways: you ask it before choosing where to spend, and you tell it what you see.

## The one rule that overrides everything else

**Never spend quota on your own initiative.** Do not start work, generate content, run "burn"
tasks or buy anything just because quota is about to expire. Your job is to *say* that it is
expiring and to *suggest* uses. The user decides. If nothing has been asked for, report and stop.

## Reaching Tokengator

Prefer the MCP tools (server name `tokengator`). If they are not connected, use the command line,
which reads the same state:

| You want to | MCP tool | Command line |
| --- | --- | --- |
| See what to use first | `what_to_use` | `tokengator status --json` |
| Report a number you read | `report_usage` | `tokengator set <account> <meter> <amount> [resets <when>]` |
| Report in one line | `quick_update` | same |
| Find a provider's usage page | `list_catalog` | `tokengator add --list <provider>` |
| Refresh automatic sources | `refresh_usage` | `tokengator collectors run` |
| Put the resets in a calendar | none | `tokengator calendar --output resets.ics` |

If neither is available, say so once and carry on; do not guess numbers.

## Reading `what_to_use`

Meters come back most urgent first. Each has a state:

- **Use now**: resets soon with quota left. Prefer this subscription for work the user wants done.
- **Behind pace**: at the current pace part of it expires. Route suitable work here when you can.
- **Running hot**: it will run out *before* its reset. Go easy; prefer something else.
- **On pace**, **New window**: nothing to do.
- **Used up**: fully used until the reset. Use something else. This is the good outcome, not a problem.
- `blockedBy`: a session limit is closed. The quota cannot be used until `blockedUntil`.
- `stale: true`: the reading is old. Refresh it before relying on it (see below).

Every answer carries the current time. Trust it over your own sense of time.

## Choosing where work runs

When the user asks for something substantial and more than one subscription could do it:

1. Call `what_to_use`.
2. If a suitable subscription is **Use now** or **Behind pace** and not blocked, tell the user in one
   line and prefer it: "Claude's weekly limit resets in 14h with 38% left, so I'll run this there."
3. If the obvious choice is **Running hot** or **Used up**, say so and suggest the alternative.
4. If the choice is not yours to make (you cannot switch model or tool), still mention it once.

Mention quota once per session, and again only when something changes state. Do not nag.

When quota is about to expire and the user asks what to do with it, `list_catalog` for that provider
lists the ways the provider itself documents for using a plan unattended (cloud sessions, scheduled
tasks), with links. Suggest them. Starting one is the user's call.

If the user wants to be reminded and you have a calendar tool, offer to add the next reset as an
event that starts a day before it (three days for a monthly quota). Offer; do not add it unasked.

## Keeping the numbers fresh

Tokengator is only as good as its last reading. Report what you see:

- **You hit or see a rate-limit message** ("limit reached, resets 3pm", "12% of weekly limit left").
  Report it straight away.
- **A meter is stale and you have a browser tool.** `list_catalog` gives each provider's usage page
  and which figures to read. Open it in a tab you created, read the numbers, report them. Never use
  or take over the user's personal browser windows, and never enter credentials.
- **The user tells you a number.** Report it for them.

When reporting:

- Mind the direction. Some pages show percent **used** (Claude), others percent **left** (Codex).
  Use `usedPercent` or `remainingPercent` accordingly, or `used` / `remaining` for counted units.
- Include the reset. Use `resetsInMinutes` when the page says "resets in 3h 20m" (that is 200).
  Use `resetsAt` only with a zone (`2026-11-21T09:00:00Z` or `+01:00`); a time without one is refused.
- Name the meter when an account has several: `meter: "weekly"`, `"session"`, `"credits"`.
- If the name is ambiguous the tool returns candidates with ids. Retry with the id.

```json
{ "name": "report_usage",
  "arguments": { "account": "claude", "meter": "weekly", "usedPercent": 62, "resetsInMinutes": 852 } }
```

```json
{ "name": "quick_update", "arguments": { "text": "suno 1200 left resets in 9d" } }
```

## What not to do

- Do not invent, estimate or round-trip numbers you did not read.
- Do not remove accounts or change prices unless the user asks; `remove_account` needs `confirm`.
- Do not put tokens, cookies or API keys anywhere in a call. Tokengator never needs them from you.
- Do not treat "used up" as an error, or "behind pace" as an instruction to start work.
