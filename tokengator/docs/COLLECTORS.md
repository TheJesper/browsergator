# Automatic sources

A collector fills meters without typing. Each one reads a single source, and each is **off until
you switch it on**: in the dashboard under menu > Automatic sources, or with
`tokengator collectors enable <id>`.

Where a provider has no dependable source, there is no collector. An agent with a browser reads the
usage page and calls the MCP tool `report_usage` instead (the catalog carries each provider's usage
page and what to read there), or you type the number.

## What ships

| Id | Provider | Source | Kind | Needs | Every |
| --- | --- | --- | --- | --- | --- |
| `claude-statusline` | Claude | JSON that Claude Code pipes to its status line command | pushed | nothing | each turn |
| `antigravity-statusline` | Antigravity | JSON that the Antigravity CLI pipes to its status line command | pushed | nothing | each turn |
| `codex-sessions` | ChatGPT / Codex | `~/.codex/sessions/**/rollout-*.jsonl` | local file | nothing | 5 min |
| `elevenlabs` | ElevenLabs | `GET api.elevenlabs.io/v1/user/subscription` | documented API | `ELEVENLABS_API_KEY` | 30 min |
| `openrouter` | OpenRouter | `GET openrouter.ai/api/v1/credits` | documented API | `OPENROUTER_API_KEY` | 30 min |
| `openai-costs` | OpenAI API | `GET api.openai.com/v1/organization/costs` | documented API | `OPENAI_ADMIN_KEY` | 60 min |
| `anthropic-costs` | Claude API | `GET api.anthropic.com/v1/organizations/cost_report` | documented API | `ANTHROPIC_ADMIN_KEY` | 60 min |
| `copilot` | GitHub Copilot | `GET api.github.com/copilot_internal/user` | **undocumented** | `TOKENGATOR_GITHUB_TOKEN` | 30 min |

### Claude Code status line (`claude-statusline`)

Claude Code runs a status line command after every turn and pipes it a JSON document. For
subscribers that document includes `rate_limits.five_hour` and `rate_limits.seven_day`, each with
`used_percentage` (0 to 100) and `resets_at` (Unix seconds). `tokengator statusline` records both
and prints a line such as:

```
5h 36% left 2h 9m · week 38% left 14h 11m (use now, $7.39 at risk)
```

(The money is there because this account is on Claude Max at $100 a month. The status line does
not say which plan you have, so an account it creates has none until you set it.)

Set it up in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "tokengator statusline" } }
```

This is the documented status line interface; nothing is read from Claude's credentials and nothing
is sent anywhere. Setting the command is the opt-in, so this source has no switch. The windows are
absent before the first response of a session and on plans without them, and the per-model weekly
limit is not part of the payload: track that meter by hand or through an agent. The command always
exits 0 and always prints a line, so it cannot break a terminal.

### Antigravity status line (`antigravity-statusline`)

The Antigravity CLI (`agy`) has the same hook. Its payload carries a `quota` object keyed by bucket
(`gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`), each with `remaining_fraction` (0 to 1) and
`reset_time` (ISO 8601). The same command reads both tools' input and tells them apart, so the
setting is identical, in `~/.gemini/antigravity-cli/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "tokengator statusline" } }
```

The payload also contains the account's email address and plan tier; Tokengator stores neither.

### Codex session logs (`codex-sessions`)

Codex writes a `token_count` event with a `rate_limits` object into its session logs:
`primary` and `secondary` windows, each with `used_percent`, `window_minutes` and `resets_at`
(Unix seconds). The collector reads the tail of the newest few logs under `$CODEX_HOME/sessions`
(default `~/.codex`), takes the newest snapshot, and ignores windows that have already ended.
Windows are told apart by length: hours are the session cap, a week is the weekly allowance.

No network, no credentials. The snapshot is only as fresh as your last Codex turn on this machine
and does not see usage from other devices or from ChatGPT on the web.

### ElevenLabs (`elevenlabs`)

Reads `character_count`, `character_limit`, `next_character_count_reset_unix` and `tier`. The key
needs the **User: read** permission. Paid plans roll unused credits over (up to twice the monthly
quota), so the catalog marks those meters as carrying over and they are never counted as waste.

### OpenRouter (`openrouter`)

Reads `data.total_credits` and `data.total_usage`. A balance, not a window: it has no reset.
OpenRouter may expire unused credits a year after purchase; if yours carry a date, set it on the
meter and it is tracked like any other expiry.

The credits endpoint needs a **management key**. An ordinary inference key, which is what
`OPENROUTER_API_KEY` usually holds, is refused, and the collector says so. A management key can
create and delete keys, so decide whether you want one in an environment file before using this
collector; entering the balance by hand works without it.

### OpenAI and Claude API costs (`openai-costs`, `anthropic-costs`)

Daily spend for the last 31 days, shown in the Costs view. Both need an **organisation admin key**,
not a normal project key. Anthropic reports amounts in cents as decimal strings and only up to the
last UTC midnight. Costs never feed the waste figures.

### GitHub Copilot (`copilot`)

Reads the monthly allowance snapshot (`quota_snapshots.premium_interactions`) that the editors use.
The endpoint is **not documented by GitHub**; its shape has changed before and it may stop working.
The collector tolerates both the token-billing shape (`entitlement` as a string, `quota_remaining`)
and the older request-based one. Copilot's allowance resets at 00:00 UTC on the 1st of each month,
so the meter stays correct by the calendar even when this source fails.

## Credentials

- Read from the process environment, or from `~/.tokengator/.env` (`KEY=value` lines; real
  environment variables win), at the moment a collector runs.
- Never written to the state file, never logged, never returned by the HTTP API, the MCP server or
  the command line. `tokengator doctor` and the dashboard show only whether a variable is set.
- Sent only to the collector's own provider host, over HTTPS. Collectors do not follow redirects.

## Behaviour

- Enabled collectors run when the service starts, then on their own interval, and on demand
  (`tokengator collectors run`, the dashboard's "Run now", the MCP tool `refresh_usage`).
- Each run has a time limit. A collector that fails or hangs does not hold up the others.
- After a failure the wait before the next attempt doubles, up to one hour; a success resets it.
- On its first success a source creates the account if there is none. When the source says which
  plan it is (Codex logs and the ElevenLabs and Copilot APIs do), the account is the catalog's preset
  for that plan, price included. When it does not (the status lines do not), the account gets the
  provider's name, the meters that were reported and **no plan and no price**, with a note saying so:
  nothing on it is valued in money until you edit the subscription and set them. Adding the
  subscription from the catalog first avoids that step.
- Meters a source does not report are left alone.
- When a window closes without a single reading from an automatic source, the ledger records that
  window as unused and marks it estimated: for a source that reports by itself, silence means the
  quota sat idle. Hand-kept meters are never assumed to be unused.

## Sources that were considered and left out

| Source | Why not |
| --- | --- |
| Claude OAuth usage endpoint (`api.anthropic.com/api/oauth/usage`) | Undocumented, needs the Claude Code OAuth token, rate limited. The status line gives the same windows through a documented interface. |
| ChatGPT backend usage endpoint (`chatgpt.com/backend-api/wham/usage`) | Undocumented and needs the token from `~/.codex/auth.json`. The session logs carry the same snapshot with no credential. |
| claude.ai, chatgpt.com, suno.com session cookies | Tokengator does not read browser cookies. |
| Gemini CLI quota endpoint | Stopped serving consumer plans in June 2026. |

## Adding one

A collector is an object in `src/server/collectors/sources.ts`:

```ts
export const example: Collector = {
  id: 'example',
  providerId: 'example',            // a catalog provider id
  title: 'Example credits',
  description: 'What is read and from where, in one or two sentences.',
  sourceKind: 'documented-api',     // or local-file, undocumented-api, push
  allowedHosts: ['api.example.com'],
  env: ['EXAMPLE_API_KEY'],
  intervalMinutes: 30,
  available: (context) => Promise.resolve(context.env['EXAMPLE_API_KEY'] ? { ok: true } : { ok: false, reason: 'Set EXAMPLE_API_KEY to switch this on.' }),
  async collect(context) {
    const body = await context.fetchJson('https://api.example.com/v1/usage', { headers: { Authorization: `Bearer ${context.env['EXAMPLE_API_KEY']}` } });
    return { accounts: [{ providerId: 'example', meters: [{ key: 'credits', reading: { used: 1, limit: 100 } }] }], spend: [] };
  }
};
```

`context.fetchJson` is the only network access a collector has: HTTPS, the listed hosts, no
redirects, a time limit. Add it to `BUILT_IN_COLLECTORS`, add a test with a mocked response and an
authorisation failure, and add a row to the table above.
