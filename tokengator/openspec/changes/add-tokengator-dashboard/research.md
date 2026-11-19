# Research

Carried out on 2026-11-19 for this change. Nine research passes ran in parallel (two on competing tools, six on providers and their data sources, one on visual design). Every provider pass was then handed to a second, sceptical pass that re-checked each endpoint, field name, reset rule and price against sources it fetched itself. A final pass looked for what the sweep had missed.

The numbers and names below were read from live pages on that day. Plans and limits in this category change monthly; the catalog records the date it was checked and every preset is editable.

## Competing tools

51 tools were read (READMEs, docs and, where available, source). The ones that matter for positioning:

| Tool | Kind | Platforms | Does it address unused quota before a reset? |
| --- | --- | --- | --- |
| [CodexBar](https://github.com/steipete/CodexBar) | menubar app + CLI + local… | macOS 14+ (full app). Linux: Qt 6 desktop app + CLI… | Partially. Since 0.83.0 (2026-10-31): 'Codex: optionally warn 24 hours and 1 hour before a weekly reset when quota remains' and reset-credit expiry reminders at 1 day and 1 hour (both opt-in, Codex only). Pace shows '% in… |
| [OpenUsage](https://github.com/robinebers/openusage) | menubar app + read-only CLI | macOS 15 (Sequoia)+ only, Apple Silicon and Intel. (0.7.x… | Yes, the strongest GUI implementation. docs/dashboard.md: 'Use It or Lose It lists ... an unpinned limit that resets within 24 hours with over 50% left ... Only windows longer than a day count, never the 5-hour session or a… |
| [aiuse](https://github.com/djbclark/aiuse) | CLI + TUI (`aiuse watch`) +… | macOS and POSIX (Python 3.11+, pipx/Homebrew tap). Windows… | Yes, it is the whole product. README: 'Your AI subscriptions reset unused capacity you already paid for ... whatever you don't burn by the reset is just gone.' Burn classification, projected waste fraction, value at risk in USD,… |
| [claude-quota-tracker](https://github.com/cooco119/claude-quota-tracker) | CLI + local web dashboard +… | macOS, Node 22.5+ | Yes, explicitly: README says windows "quietly reset whether or not you used them"; forecasts fill-vs-waste and nudges on under-use, plus a queue to burn leftover quota overnight. Claude only. |
| [GenAIUsageWidget](https://github.com/m8i-51/GenAIUsageWidget) | tray app + desktop widget | Windows (.exe), Linux (AppImage, .deb) | Yes: explicit unused-quota reminder before weekly/monthly reset with a pace check. Notification-only and not shown as a persistent ranking. |
| [Tokenkarma](https://tokenkarma.app/) | SaaS (desktop app + browser… | macOS 13+ Apple Silicon, Windows 10/11 | Yes, but only as a paid top-tier alert. |
| [claude-quota-mcp](https://github.com/PavolKum/claude-quota-mcp) | other (MCP server + hook +… | Python; Windows path documented, any MCP host | Yes, for agents: "Unused quota expires at reset, so it nudges the agent to front-load heavy work." Limited to the 5-hour session window opportunity and to Claude/Codex. |
| [ClaudeBar](https://github.com/tddworks/ClaudeBar) | menubar app (also notch,… | macOS 15+ only. | No. 'Room to spare' is a healthy state; forecast only answers 'will it last until it resets'. No unused-quota warning, no money value. |
| [Quotio](https://github.com/nguyenphutrong/quotio) | menubar/desktop app + CLI +… | macOS 14+ app; Rust CLI for macOS and Linux x64 ('Windows… | No. Alerts are for low quota and cooling periods. The 'Fill First' routing strategy drains one account before the next, which is about failover, not expiry. |
| [CodeBurn](https://github.com/getagentseal/codeburn) | desktop app + tray/menubar +… | macOS, Windows (Microsoft Store or .exe), Linux… | Only at plan level. FAQ 'Is my plan the right size, or am I paying for capacity I never use?': after two or three cycles, 'consistently under a quarter of the plan means you are buying capacity you do not use'. No reset… |
| [Win-CodexBar](https://github.com/Finesssee/Win-CodexBar) | Windows tray app + CLI (port… | Windows only (Tauri 2 + React over shared Rust provider… | Not that I could confirm. README describes pace and low/out/reset hooks only. |
| [OpenQuota](https://github.com/deviffyy/OpenQuota) | tray app / floating dashboard | Windows x64/ARM64, macOS 11+ (universal), Linux x64/ARM64… | No. Pacing is 'likely to last until the next reset'. |
| [ccusage](https://github.com/ccusage/ccusage) | CLI | macOS, Linux, Windows (npm/bun/Nix) | No. It shows time left in the current 5-hour block and a burn rate, but never says quota is going unused. No pacing-to-reset or under-use concept. |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | TUI | macOS, Linux, Windows (uv/pip/pipx/conda) | No. It forecasts when you will run out and exits non-zero near the limit; it does not warn about unused quota. |
| [tokscale](https://github.com/junhoyeo/tokscale) | TUI | macOS, Linux, Windows (npm/bun, Rust core) | No. It displays percent left and reset time per window but draws no conclusion from them. |
| [Splitrail](https://github.com/Piebald-AI/splitrail) | CLI | Cross-platform Rust binaries (Linux, macOS, Windows) | No. |
| [vibeusage](https://github.com/joshuadavidthomas/vibeusage) | CLI | Go binary; macOS, Linux, WSL, Windows | No. Pace math exists but under-use is treated as healthy. |
| [@metyatech/ai-quota](https://github.com/metyatech/ai-quota) | CLI | Node 18+ | No. |
| [CostGoat](https://costgoat.com/monitor/elevenlabs-credits) | other (desktop app) | macOS, Windows, Linux | No. Alerts are about running out. |

### What the survey showed

- The field splits into four camps that barely overlap: token and cost analysers that read local logs (ccusage, tokscale, Splitrail), live quota meters (CodexBar, OpenUsage and many tray apps), leaderboards that reward burning more, and API cost observability services.
- Pace features are almost everywhere one-sided. They warn about running out, and they draw quota left over as green "headroom", "reserve" or "room to spare". For this product that is the alarm state.
- Unused quota appears as a secondary notification in a handful of tools (OpenUsage, CodexBar for Codex only, GenAIUsageWidget, Tokenkarma behind a paid tier) and as the main idea in two small ones (`aiuse`, a CLI; `claude-quota-tracker`, macOS and Claude only). None combines a waste-first ranking, money at risk, a history of what expired, a graphical interface on all three desktop systems, and an MCP server.
- Creative and consumer subscriptions are essentially untracked. ElevenLabs appears in two tools; no tool was found that tracks Suno, Midjourney or Runway.
- Most quota meters read undocumented endpoints with credentials taken from another tool. Several READMEs describe the Claude one as aggressively rate limited and as a grey area under the terms of service. Documented sources exist for the most important cases and are used here instead (see Provider sources in `design.md`).
- MCP coverage of quota is thin: small read-only servers for one or two coding providers. None lets an agent record what it reads.

### Ideas taken from others, with credit

- An even-pace marker on every bar (OpenUsage, usage-monitor-for-claude), and a projected-at-reset figure (claude-usage, AIUsageTracker). Here the remainder of that projection is the headline.
- A daily amount that would finish the quota on time (CodexBar, claude-pace).
- Countdown as the largest unit plus the next one down (OpenUsage).
- A click that flips used and left everywhere, and countdown and clock time (OpenUsage, CodexBar).
- Hiding names while a screen is shared (OpenUsage, CodexBar).
- Source and age on every number, and never failing silently into a wrong one (claude-quota-mcp, Claude-Code-Usage-Monitor, Quotio).
- The current time in every agent-facing answer, because agents have no clock (claude-quota-mcp).
- An exit code for scripts when something is actionable (aiuse, CodexBar `guard`).
- Loopback by default, a token for anything else, and no token in a query string (CodexBar `serve`).
- A note per subscription for what to spend it on, so an alert comes with something to do (claude-quota-tracker).

## Providers

### Claude

- Current consumer plan lineup and prices (2026-11-19): Free $0; Pro $20/month or $17/month billed annually ($200 up front); Max $100/month; Ultra $200/month; Max and Ultra are monthly-only. ([source](https://claude.com/pricing))
- Max 20x was renamed Ultra; Ultra gives 10x Pro weekly usage and has no five-hour limit for verified accounts. ([source](https://support.claude.com/en/articles/17728952))
- The 5-hour limit starts at the first message and resets in full five hours later. ([source](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work))
- Weekly limits reset at a fixed day and time per account, not on a rolling 7 days from first use. ([source](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work))
- Fable models are capped at 50% of the weekly limit on Max, Ultra and Team Premium seats, and are usage-credits-only on Pro and Team Standard seats. ([source](https://support.claude.com/en/articles/15424964))
- Max, Ultra and Team plans include monthly Claude API credits that do not roll over: $100 (Max), $200 (Ultra), $20 per Standard seat and $100 per Premium seat pooled and capped at $500/month (Team). ([source](https://support.claude.com/en/articles/17154008))
- Usage credits (formerly 'extra usage') are prepaid pay-as-you-go at standard API rates; purchases on or after 2026-12-07 expire 12 months after purchase. ([source](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans))
- Limit resets are occasional grants (five-hour reset, weekly reset, Fable reset) that expire if unused. ([source](https://support.claude.com/en/articles/17506494))
- The Claude Code statusline JSON includes a rate_limits object with exact fields rate_limits.five_hour.used_percentage, rate_limits.five_hour.resets_at, rate_limits.seven_day.used_percentage, rate_limits.seven_day.resets_at. ([source](https://code.claude.com/docs/en/statusline))
- Sending /usage as a prompt in print/SDK mode returns a structured usage_report (SDKUsageReport) on the assistant message. ([source](https://code.claude.com/docs/en/agent-sdk/typescript))
- /usage is the single Claude Code usage command; /cost and /stats are aliases, and the plan-usage endpoint behind it is rate limited. ([source](https://code.claude.com/docs/en/costs))
- Claude Code credentials live in ~/.claude/.credentials.json on Linux (mode 0600), %USERPROFILE%\.claude\.credentials.json on Windows, and the macOS Keychain on macOS (file fallback when the Keychain rejects the write). ([source](https://code.claude.com/docs/en/authentication))
- Local transcripts carry per-message token usage but no rate-limit or quota information. ([source](https://code.claude.com/docs/en/claude-directory))
- Admin API legacy reports: GET /v1/organizations/usage_report/messages (1m/1h/1d buckets) and GET /v1/organizations/cost_report (daily only), authenticated with an Admin API key (sk-ant-admin01-...). ([source](https://platform.claude.com/docs/en/manage-claude/usage-cost-api))
- The newer Usage and Cost Analytics API (/v1/organizations/analytics/usage and /analytics/cost) is the recommended replacement and requires the beta header analytics-usage-cost-2026-08-24. ([source](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api))
- The Admin API is not available to individual Claude Console accounts or to claude.ai Team-plan organizations. ([source](https://platform.claude.com/docs/en/manage-claude/usage-cost-api))

### ChatGPT and Codex

- Plus and Business Standard have a 5-hour window plus a weekly window; Pro plans have no 5-hour limit. ([source](https://learn.chatgpt.com/docs/pricing))
- Resets shift the schedule, so only the server-reported reset timestamp is reliable. ([source](https://help.openai.com/en/articles/20001498))
- Starting December 2026, Plus, Pro and Business allowance is shared across ChatGPT and Codex. ([source](https://help.openai.com/en/articles/20001625-understanding-chatgpt-and-codex-usage-limits))
- Current prices: Free $0, Go $8, Plus $20, Pro $100/$200/$500, Business $20 per user per month annual or $25 monthly. ([source](https://learn.chatgpt.com/docs/pricing))
- Pro and Business subscriptions include monthly API credits that expire at the end of each billing cycle. ([source](https://developers.openai.com/api/docs/guides/chatgpt-api-credits))
- Purchased ChatGPT credits expire 12 months after purchase and are used only after included limits are exhausted. ([source](https://help.openai.com/en/articles/12642688))
- Session-log rate-limit schema is primary/secondary with used_percent, window_minutes, resets_at; there is no resets_in_seconds. ([source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs))
- Rollout files live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl and cold files are zstd-compressed after 7 days. ([source](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/compression.rs))
- The CLI reads limits from GET {chatgpt base}/backend-api/wham/usage with Bearer token and ChatGPT-Account-Id header. ([source](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs))
- primary and secondary are positional; the window type must be derived from its length. ([source](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/rate_limits.rs))
- `codex app-server` exposes account/rateLimits/read, account/usage/read and account/rateLimits/updated over JSON-RPC on stdio. ([source](https://learn.chatgpt.com/docs/app-server))
- There is no non-interactive Codex CLI command that prints limits. ([source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs))
- Codex credentials are in $CODEX_HOME/auth.json unless the user configured keyring storage; a tracker should not refresh tokens. ([source](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs))
- The API Costs endpoint is GET /v1/organization/costs with an Admin key and daily buckets only. ([source](https://developers.openai.com/api/reference/resources/organization/subresources/audit_logs/methods/get_costs))
- API prepaid credits expire 1 year after purchase and OpenAI documents no balance API. ([source](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing))

### GitHub Copilot and other coding tools

- Copilot replaced premium requests with GitHub AI Credits on 2026-06-01 for all plans. ([source](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/))
- 1 AI credit = $0.01 USD. ([source](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals))
- Copilot AI credits reset at 00:00:00 UTC on the 1st of each calendar month, regardless of billing date, and unused credits are forfeited. ([source](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals))
- Copilot monthly AI credit allowances per plan. ([source](https://docs.github.com/en/copilot/get-started/plans))
- Legacy premium requests survive only for Pro/Pro+ subscribers on an existing annual plan. ([source](https://docs.github.com/en/copilot/concepts/billing/copilot-requests))
- The copilot_internal/user response gained AI-credit fields beyond the commonly cited premium_interactions shape. ([source](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/defaultAccount.ts))
- VS Code's entitlement URL is https://api.github.com/copilot_internal/user and it is called with only an Authorization header. ([source](https://github.com/microsoft/vscode/blob/main/product.json))
- copilot_plan and access_type_sku values map to plans. ([source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/chat/common/chatEntitlementService.ts))
- Org-managed Copilot seats may expose usage with no denominator. ([source](https://github.com/steipete/CodexBar/blob/main/docs/copilot.md))
- Official REST endpoints exist for both AI credit and premium request usage, for users and organizations. ([source](https://docs.github.com/en/rest/billing/usage))
- Zed Pro includes $5 of monthly token credit that resets on the billing date. ([source](https://zed.dev/docs/ai/plans-and-usage.md))
- Amp's included usage resets each billing period with no rollover. ([source](https://ampcode.com/docs/pricing))
- CodexBar is the closest competitor reference and documents data sources for all these providers. ([source](https://github.com/steipete/CodexBar/blob/main/docs/providers.md))

### Google

- Gemini app limits are compute-based with a 5-hour refresh and a weekly cap; fixed prompts/day numbers no longer exist. ([source](https://support.google.com/gemini/answer/16275805))
- Monthly plan credits are now 'Google Flow credits' and they reset at the start of the billing cycle with no rollover. ([source](https://support.google.com/flow/answer/16526234))
- The old monthly 'AI credits' grant (1,000 for Pro / 25,000 for Ultra, usable in Antigravity) was removed; AI credits are now purchase-only overage. ([source](https://discuss.ai.google.dev/t/arent-the-ai-credits-supposed-to-refill-monthly/179106))
- AI credit balance, next refresh date and usage history are only available on a web page: one.google.com/ai/activity (purchase at one.google.com/ai/credits). ([source](https://support.google.com/googleone/answer/17103110))
- Gemini CLI and Gemini Code Assist stopped serving free individual, Google AI Pro and Google AI Ultra accounts on 2026-06-18; consumers moved to Antigravity CLI. ([source](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/README.md))
- cloudcode-pa v1internal:retrieveUserQuota request/response shape (verbatim from Gemini CLI source). ([source](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/code_assist/types.ts))
- Gemini CLI OAuth credentials live at ~/.gemini/oauth_creds.json (GEMINI_CLI_HOME overrides home); Antigravity CLI instead stores tokens in the OS keyring. ([source](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/storage.ts))
- Antigravity quota model: per model group, a 5-hour quota plus a weekly limit for Pro/Ultra; weekly-only for everyone else. ([source](https://antigravity.google/docs/plans/))
- Antigravity CLI has an officially documented statusline hook that exposes quota as JSON. ([source](https://antigravity.google/docs/cli/statusline/))
- Accessing Antigravity quota with its OAuth client from third-party software is a Terms-of-Service risk; there is no official quota API. ([source](https://antigravity.google/docs/faq/))
- Remote Antigravity quota endpoints used by CodexBar (undocumented). ([source](https://raw.githubusercontent.com/steipete/CodexBar/main/Sources/CodexBarCore/Providers/Antigravity/AntigravityRemoteUsageFetcher.swift))
- Gemini app usage can be read from an undocumented cookie-authenticated GraphQL endpoint. ([source](https://raw.githubusercontent.com/steipete/CodexBar/main/Sources/CodexBarCore/Resources/Plugins/gemini-web.ts))
- Gemini API daily quotas reset at midnight Pacific time and apply per project. ([source](https://aistudio.google.com/docs/rate-limits))
- Gemini API Prepay credits expire 12 months after purchase and are non-refundable. ([source](https://aistudio.google.com/docs/billing))
- Gemini Notebook (the renamed NotebookLM) also uses 5-hour + weekly compute-based limits. ([source](https://support.google.com/gemininotebook/answer/17670842))
- Jules is being shut down: read-only since 2026-11-11, wind-down 2026-12-31. ([source](https://jules.google/docs/changelog/))
- Local Antigravity language-server probe details (fallback data source). ([source](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/antigravity.md))

### Voice, music, image and video

- ElevenLabs paid plans roll over unused credits, capped at 2x the monthly quota (max balance 3x); Free has no rollover. ([source](https://elevenlabs.io/docs/help-center/account/general/how-does-credit-rollover-work))
- GET https://api.elevenlabs.io/v1/user/subscription returns character_count, character_limit and next_character_count_reset_unix; auth is the xi-api-key header. ([source](https://api.elevenlabs.io/openapi.json))
- Suno subscription credits never roll over; top-up credits never expire but need an active subscription. ([source](https://suno.com/pricing))
- Midjourney Fast time does not roll over; purchased hours expire after 60 days. ([source](https://docs.midjourney.com/hc/en-us/articles/27870521824653-Subscription-Fast-Time-Expiration))
- Runway: Standard (625), Pro/Unlimited (2,250) credits expire on the billing date; Max (9,500) and Team (6,900/seat) roll over up to one month; purchased credits never expire. ([source](https://help.runwayml.com/hc/en-us/articles/15124877443219-How-do-credits-work))
- A few meters reset on a fixed clock rather than the billing date. ([source](https://docs.lovable.dev/introduction/plans-and-credits))
- Higgsfield annual plans reset credits every 30 days, not on the calendar anniversary, so the reset day drifts. ([source](https://higgsfield.ai/creator-hub/help-center/plans/when-does-my-subscription-renew))
- Kling membership credits are valid one month from distribution and purchased credits two years; shortest-validity credits are spent first. ([source](https://kling.ai/docs/point-policy))
- No-rollover is confirmed from official text for Udio, Luma, Pika, Krea individual plans, Ideogram, Descript and Replit Core. ([source](https://docs.replit.com/help/pricing-and-plans.md))
- Runway and Midjourney help pages block normal fetches (HTTP 403) but are readable through the public Zendesk Help Center JSON API. ([source](https://help.runwayml.com/api/v2/help_center/en-us/articles/15124877443219.json))

### API spend and prepaid credits

- OpenRouter's GET /api/v1/credits now requires a management key; a regular inference key gets 403. ([source](https://openrouter.ai/docs/api/api-reference/credits/get-credits))
- OpenRouter's GET /api/v1/key works with an ordinary key and returns spend, cap, remaining and reset information. ([source](https://openrouter.ai/docs/api-reference/api-keys/get-current-key))
- OpenRouter may expire unused credits one year after purchase and charges a 5.5% (min $0.80) purchase fee. ([source](https://openrouter.ai/docs/faq))
- Anthropic has a new beta Usage and Cost Analytics API; the older cost_report endpoint is marked Legacy. ([source](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api))
- Anthropic's Admin API (and therefore any cost endpoint) is unavailable to individual Claude Console accounts. ([source](https://platform.claude.com/docs/en/manage-claude/admin-api-keys))
- Anthropic API credits expire one year from purchase and are non-refundable. ([source](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage))
- OpenAI exposes daily spend through GET /v1/organization/costs with an Admin key, but no supported balance endpoint. ([source](https://developers.openai.com/api/reference/resources/organization/subresources/audit_logs/methods/get_costs))
- Gemini API prepay credits expire after 12 months and there is no API for balance or spend. ([source](https://aistudio.google.com/docs/billing))
- Google Cloud has no direct actual-cost API; BigQuery billing export or Budget Pub/Sub notifications are the routes. ([source](https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications))
- Google AI Pro/Ultra subscribers get monthly Google Cloud credits usable on the Gemini API, each valid for 12 months. ([source](https://blog.google/innovation-and-ai/technology/developers-tools/google-cloud-credits-gdp-ai-studio/))
- xAI exposes prepaid balance, invoice preview and spending limits through a separate Management API. ([source](https://docs.x.ai/docs/management-api/billing))
- DeepSeek's GET /user/balance returns granted and topped-up balances as strings, per currency. ([source](https://api-docs.deepseek.com/api/get-user-balance))
- Groq has no billing or usage API and bills postpaid, so there is no expiring balance. ([source](https://console.groq.com/docs/billing-faqs))
- Together AI credits do not currently expire; its billing usage API is beta and gated per organization. ([source](https://docs.together.ai/reference/billing-usage))
- Fireworks moved all self-serve accounts to prepaid billing on 2026-07-01 and offers spend endpoints but no balance endpoint. ([source](https://docs.fireworks.ai/accounts/exporting-usage-and-costs))
- Replicate prepaid credit is valid for 1 year from purchase and there is no balance or spend API. ([source](https://replicate.com/docs/topics/billing/prepaid-credit))
- fal.ai has a documented balance endpoint, and purchased credits expire after 365 days. ([source](https://fal.ai/docs/platform-apis/v1/account/billing))
- ElevenLabs' subscription endpoint gives used, limit and exact reset time; the character-stats usage endpoint is deprecated. ([source](https://elevenlabs.io/docs/api-reference/usage/get))
- Moonshot/Kimi exposes GET /v1/users/me/balance with available, voucher and cash balances. ([source](https://platform.kimi.ai/docs/api/balance))
- Cerebras purchased credits expire one year after purchase, free $5 credits after 30 days, and there is no billing API. ([source](https://support.cerebras.net/articles/5041581099-cerebras-self-serve-paygo-faq))
- Vercel AI Gateway has a simple credits endpoint usable with the normal gateway key. ([source](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api))

## Verification

| Pass | Confirmed | Partly correct | Refuted | Could not verify |
| --- | ---: | ---: | ---: | ---: |
| anthropic-api, claude | 19 | 9 | 0 | 0 |

Corrections that changed something in this change:

CORRECTIONS_PLACEHOLDER

## Visual design

The design pass arrived at the same direction independently and audited the stylesheet that already existed. Its measured findings were applied:

- Classic Solarized fails contrast as it stands (body text 4.13:1 on the light base, comments 2.79:1 on the dark one), so the base tones were greyed and the text lifted.
- The light meter track was lightened so the expiring orange keeps 3:1 against it; the caution and blocked hues were replaced with steps that hold 3:1 on every surface.
- The dark-theme marks were mid-tone; they are now the pastel light blue and pastel orange the brief asks for.
- Tracked capitals on labels and monospace figures are named tells of generated interfaces. Labels are sentence case; figures use the text face, whose digits are tabular.
- Orange against caution yellow, and green against the blocked hue, collapse under red-green colour blindness, so no state relies on hue: each has its own shape and its label.

Tells of generated interfaces that the design avoids:

- Indigo or violet accents and blue-to-purple gradients. The purple default traces to Tailwind UI's bg-indigo-500 examples saturating training data (prg.sh, Oct 2025); Krebs calls it 'VibeCode Purple'. No gradients anywhere,…
- Warm cream background with a terracotta accent, and near-black with one acid accent. Anthropic's frontend-design skill lists both as defaults that appear regardless of subject; impeccable.style calls the first 'AI beige'. This…
- Inter, Roboto, Space Grotesk, Instrument Serif or Geist as an unexamined default, and an italic serif accent word in a headline.
- A coloured bar down the left or top edge of a card or row. Krebs: 'almost as reliable a sign of AI-generated design as em-dashes for text'. Identity goes in a monogram tile, state goes in the bar and its label.
- Glassmorphism and backdrop blur, coloured glows, coloured box-shadows, and the thin-border-plus-wide-soft-shadow card.
- A grid of identical rounded cards, each with an icon on top; cards inside cards; every element given the same weight. The default view is a ranked list where the first row is visibly the most important.
- Emoji as icons in navigation, status or empty states. Use one 16px 1.5px-stroke icon set, and only where an icon carries meaning.
- Tracked-out all-caps eyebrow labels, a badge above the title, numbered 01/02/03 section markers, stat-banner rows, middle-dot meta strings and arrows appended to links. Write captions as short sentences with commas ('38% left,…
- Monospace used as decoration for data labels. Mono is for text a person copies.
- Status-chip soup and pulsing dots. One state word per row, coloured only when it asks for action.
- Entrance animations on every section, hover-lift on every card, spring overshoot, numbers that count up on load. Motion only when data changes: bar width 180ms ease-out, figure cross-fade 120ms, nothing under…
- Dark mode with low-contrast grey body text, which is also classic Solarized's own flaw (base0 on base03 is 4.75:1 and APCA Lc 40; comments 2.79:1). Dark is designed separately, not flipped.
- A donut, ring or gauge per provider. Few designed the bullet graph to replace them. One ring at most, and only for time.
- Traffic-light green for 'plenty left'. Here plenty left near a reset is the problem. CodexBar colours behind-pace green ('reserve'); we do the reverse.

