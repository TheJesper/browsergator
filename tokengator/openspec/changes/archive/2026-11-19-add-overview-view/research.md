# Research: an Overview (box) view

Competitors and analogues, read on 2026-11-19. Builds on the research of the change that introduced the
package (`openspec/changes/archive/2026-11-19-add-tokengator-dashboard/research.md`) and does not repeat it.

Every source was opened unless it is marked *(search summary only)*.

## Key findings

1. **Board already gives one card per subscription, so a box view should be built from tiles that cut across subscriptions.** The strongest GUI competitor, OpenUsage, made the same move. Next to its per-provider cards ("All Usage") it added a triaged **Priority** tab with these sections: Pinned, Running Out, Use It or Lose It, All Clear, Needs Attention, Used Up. Tiles that repeat Board, each with a logo on top, are the "grid of identical cards" tell that design.md already bans.
2. **Every consumer quota interface treats leftover quota as the good state.** Examples: ClaudeBar's "Room to spare", data-plan apps colouring under-pace green, Headroom's green tray icon, CodexBar's green/red pace bars. Only a few kinds of interface treat under-use as the alarm: cloud-commitment reports (AWS RI utilization: yellow under target, red for no use), PTO forfeiture notices, and gift-card or points expiry trackers. Tokengator should take its tile vocabulary and structure from those, not from AI trackers.
3. **Provider usage pages show "used" and "resets at". None shows what will expire, and none forecasts.** A Codex user asked OpenAI for exactly that forecast, and OpenAI support answered "No timeline to share". So a forecast is not a commodity feature.
4. **Overview pages in the log analysers answer a different question** (spend and tokens): ccusage, tokscale, Splitrail, CodeBurn and claude-quota-tracker. They use KPI tiles with period-over-period deltas, a stacked trend, a weekday×hour heatmap and rankings. Tokengator cannot build those heatmaps: `Meter.samples` holds only the current window, and tokens per prompt are a non-goal.
5. **Three devices map directly onto the goal of not letting quota expire.**
   - A **target line on a utilization chart** (AWS).
   - **Two durations side by side**: how long the remainder lasts at this pace against how long until renewal (FirstSales "Credit Runway"; data apps' "N days left at this rate").
   - An **expiry inventory sorted by date** (AwardWallet, Vantage Commitments, gift-card wallets).
6. **Tile anatomy that holds up:** one value, one comparison (target, previous period or deadline), one date label, an optional small trend, at most about five decision metrics per screen. Avoid rings and gauges, colour used for magnitude, and repeating the summary strip.

---

## 1. AI usage and quota trackers: what their overviews contain

| Product | Overview form | Tiles / charts shown | Good for "don't let it expire" | Wrong for it |
| --- | --- | --- | --- | --- |
| **OpenUsage** ([docs/dashboard.md](https://github.com/robinebers/openusage/blob/main/docs/dashboard.md)) | Two tabs: **Priority** and **All Usage** | Priority sections in order: Pinned; Running Out (default "Warning" at ≤30% left; "Burning Fast" shows "Out in 1h 8m" and stays until pace drops to 90%); **Use It or Lose It** (resets within 24h with >50% left; excludes 5-hour and dollar caps; only windows longer than a day; "Resets in 18h"); All Clear; Needs Attention with a **Fix** action; Used Up (always last). All Usage: one card per provider with bars and countdowns (largest unit plus the next one down, refreshed every 30 s); optional Pace Marks (hidden before 1% of the window). The footer copies the tab as a PNG with emails omitted. | Triage by state, not by provider; positive "All Clear" empty state; "Needs Attention" with an action | Use It or Lose It is a fixed 24 h, off by default and ranked below Running Out. No money. No history. |
| **CodexBar** ([README](https://github.com/steipete/CodexBar), [widgets](https://github.com/steipete/CodexBar/blob/main/docs/widgets.md), [CHANGELOG](https://github.com/steipete/CodexBar/blob/main/CHANGELOG.md)) | Menu cards plus 8 WidgetKit widgets | Switcher (one tile per provider showing its "most constrained" quota); Usage ("Weekly 93% left", "Resets in 1 minute"); Accounts (up to 4 or 8 rows, header shows the **age of the oldest measurement**, "+N more"); History chart; **Metric** (one figure: "Credits left", today's cost, or Cost); **Burn Down** (one window) and **Burn Down (Combined)** (two lanes, "No data" when one is missing). Changelog: "Plan Usage now shows the recorded remaining-quota burndown … with capture age" (#4085); "monthly allowances show a daily target (what's left divided by the days until reset)" (#4677); a six-day work week option for weekly pace (#4548); "weekly-reset confetti". | Burndown chart; daily target; freshness in the tile header | Celebrates the reset with confetti, which is the moment leftover quota is lost. Pace bars are green/red with under-use as green. |
| **ClaudeBar** ([README](https://github.com/tddworks/ClaudeBar), [status colours](https://github.com/tddworks/ClaudeBar/blob/main/docs/features/quota/status-colors/README.md)) | "All providers" page | Each provider's tightest quota as **rings**, or every quota as bars. Levels: Healthy ≥50% left, Warning 20–<50%, Critical >0–<20%, Depleted 0. With pace on: "Running hot", "On track" / "Room to spare"; within 5 points of pace counts as on track. | High-contrast palette option | Leftover quota is "Healthy … however little is left". Uses rings. |
| **Headroom** ([README](https://github.com/allandecastro/headroom)) | Popover of quota cards | **7-day burndown sparkline** per quota; "On track · ~N% by reset"; "On track to exceed · full in Xd"; "rough (history gap)" when history has holes; tray colour green/amber/red from the worst quota | Projection-at-reset wording; marks history gaps honestly | Under-use is green. |
| **Tokenkarma** ([site](https://tokenkarma.app/)) | Two concentric rings | Outer ring "Claude · 5 hours 90%", inner ring "Claude · 7 days 78%"; alerts at 75/90/100%; under-used plan alert only on the €9/$9-a-month Expert tier | Under-use alert exists | Rings; the waste alert is behind a paywall. |
| **CodeBurn** ([README](https://github.com/getagentseal/codeburn)) | Overview / Spend / Plans pages plus a "Capacity Dock" | Overview: today's spend, projected month, last 30 days by day, top 5 sessions, "One-shot", cost per commit. Plans: "Live quota" card per plan ("42% used · resets in 3h 20m"), "On track" or "on pace to exceed". Dock: **one ring per provider**. FAQ: consistently under a quarter of the plan means you are buying capacity you do not use. | Right-sizing idea | Values in "API-equivalent" dollars (D17 rejects these); rings; about overspend. |
| **Splitrail** ([README](https://github.com/Piebald-AI/splitrail)) | `splitrail web` Overview tab | Tiles: estimated cost, total tokens, replies, session count, cache share, **each against the previous period**; stacked trend (cost/tokens/replies by model, tool or project); last-24 h hourly trend; rankings; **weekday/hour heatmap**; largest sessions | Clean KPI-plus-delta tile pattern | No quota or expiry concept. |
| **tokscale** ([README](https://github.com/junhoyeo/tokscale)) | TUI with 10 views; web contribution graph | Overview (chart plus top models), Usage tab ("Session 85% left [====] resets in 2h 15m"), Stats contribution graph; web 2D/3D contribution graph, stats panel (total cost, tokens, active days, streaks), leaderboard, "Wrapped" | n/a | Streaks and leaderboards reward burning tokens. That is the wrong incentive, and the data is absent here anyway. |
| **claude-quota-tracker** ([README](https://github.com/cooco119/claude-quota-tracker)) | Local web dashboard, inline SVG | 5 h and weekly gauges; per-model token charts; GitHub-style heatmap; estimate-vs-actual accuracy; night-queue state; forecast "Week (all models): 59% → ~72% by reset" | "X% → ~Y% by reset" is a strong compact sentence | Gauges and heatmap; Claude only; interface in Korean. |
| **aiuse** ([README](https://github.com/djbclark/aiuse)) | `aiuse watch` text board | Columns POOL, SCOPE, PACE, 5H, WEEK, MONTH, `##` score; cell `12u/88l/3h7m -68%`; score bands empty (0) / slow (25–49) / mid (50–74) / **use** (75–99); green = "use" (capacity to burn now); Burn / Conserve / On pace (Burn at `waste_alert_fraction` 0.30) | Waste-first ranking | Green means "go burn", which clashes with our green = used up. Dense notation. |
| **OpenQuota** ([README](https://github.com/deviffyy/OpenQuota)) | Floating panel | Today / yesterday / 30 days of tokens and estimated spend; used/left toggle; reorder and hide rows | Today against yesterday | Pace means only "likely to last". |
| **ccusage** ([live monitoring](https://ccusage.com/guide/live-monitoring)) | Live monitor (**removed in v18.0.0**) | v17: session progress bar, burn rate in tokens/min, time left in the 5-hour block, cost projection | n/a | The tool dropped its live dashboard. |
| **Claude-Code-Usage-Monitor** ([README](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)) | Realtime TUI | Progress bars, burn rate, model distribution bar; provenance labels `official` / `local_estimate` / `experimental` / `unknown` | Provenance on every figure | About running out. |
| **Quotio** ([README](https://github.com/nguyenphutrong/quotio)) | Dashboard | Only the screenshot alt text: "local proxy status and quota summaries" | n/a | Could not verify more. |
| **CostGoat** ([ElevenLabs page](https://costgoat.com/monitor/elevenlabs-credits)) | Desktop app | Live credit balance, low-credit alerts, usage history, refresh date and amount | Refresh date and amount | Alerts are only about running low. |

### The providers' own usage pages

- **Claude, Settings > Usage** ([Claude docs, government accounts](https://claude.com/docs/government/account/usage); consumer: [support article](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)).
  - Shows "Current session" (5 h) and "Weekly limit · All models".
  - State lines: "Resets …", "**Starts when a message is sent**", "**Resets on next request**" ("you are not actually limited in this state even if the bar looks full").
  - The page does not refresh itself; there is a refresh icon next to "Last updated", and a dot on the Usage tab when a limit is full.
  - Worth copying: the two idle-window states are exact, human wording for `rolling` meters.
- **ChatGPT / Codex.**
  - A user lists the separate limits (5 h, weekly, plan-included, purchased credits) and says it is "difficult to understand how these limits interact": the 5 h view showed full availability while the weekly limit blocked use ([forum](https://community.openai.com/t/feature-request-clearer-codex-usage-and-credit-dashboard/1397605)).
  - Another user reports that the reset time moved behind "More". They asked for a burn-rate forecast; support answered "No timeline to share" ([forum](https://community.openai.com/t/restore-usage-reset-visibility-and-add-a-burn-rate-forecast/1391275)).
  - I could not open OpenAI's help centre (HTTP 403).
- **GitHub Copilot.**
  - The Individual "AI usage" page shows included credits used, additional usage, a model chart, and a model breakdown with credits and cost. Business shows a "Usage this cycle" card such as "450 / 1,000 AI credits used" ([docs](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage)).
  - The allowance has two layers. **Base credits are used first, then the flex allotment**: Pro 1,000 + 500, Pro+ 3,900 + 3,100, Max 10,000 + 10,000. It resets at 00:00 UTC on the 1st and unused credits "are forfeited" ([docs](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals)).
- **ElevenLabs** usage analytics: credit usage and latency metrics, grouped by voice, product or API key, with selectable period and granularity. The page shows no remaining balance or rollover ([docs](https://elevenlabs.io/docs/overview/administration/usage-analytics), [help](https://elevenlabs.io/docs/help-center/account/general/how-can-i-see-information-about-credit-usage-for-my-account)).
- **Anthropic Console** ([support](https://support.claude.com/en/articles/9534590-cost-and-usage-reporting-in-console)).
  - Usage page: a bar chart by model, date and API key; input/output token chart; rate-limit charts plotted against the ITPM/OTPM limit.
  - Cost page: daily cost chart.
  - No credit balance or expiry is shown.
- **OpenAI API usage dashboard:** separate Cost and Activity tabs; data in UTC *(search summary only: [help 20001072](https://help.openai.com/en/articles/20001072))*.
- **Cursor:** Included Usage is shown per model to one decimal place and the summary card in whole percent. One user read "0.1%" for nine days while their token count doubled. Dollar costs were removed from the Usage page on 2026-07-31 ([forum](https://forum.cursor.com/t/measuring-a-quota-through-a-gauge-that-only-shows-tenths-of-a-percent/170206)).

**What the providers' pages teach:**
- Precision has to match the decision. A rounded percentage that never moves at low usage hides real use.
- Interacting limits need one sentence that says which limit is the binding one.
- Nobody shows the expiry consequence.

---

## 2. Analogues outside AI

### Cloud commitments (the closest match: prepaid capacity, lost if unused in its period)

- **AWS RI utilization report** ([AWS docs](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-default-reports.html)).
  - A user-defined **utilization target** is drawn as a **dotted line** on the chart.
  - Each row in the table below carries a status bar: **red = no hours used, yellow = under target, green = met target, grey = not using reservations**.
  - Daily chart covers 3 months; monthly chart covers 12 months.
  - Columns: RI hours purchased / used / unused, Net savings, Potential savings, **"RI Cost For Unused Hours"**.
  - The coverage report mirrors this with a coverage target.
- **AWS Savings Plans:** summary figures "Savings Plans spend", "On-Demand spend equivalent", "Total net savings" ([AWS docs](https://docs.aws.amazon.com/savingsplans/latest/userguide/ce-sp-pr-metrics.html)).
- **Azure reservations.**
  - The list shows each reservation's **last known utilization %**, and clicking it opens the history ([MS Learn](https://learn.microsoft.com/en-us/azure/cost-management-billing/reservations/reservation-utilization)).
  - Alerts fire when utilization is below a target (example 95%), averaged over the **last 7 or 30 days**. Microsoft avoids 1-day averages because "last day reservation utilization is subject to change". The email lists the **top five** under-used reservations ([MS Learn](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/reservation-utilization-alerts)).
  - Pre-purchase plans are excluded because they "can be fully utilized at any time during the coverage period". This is the same split as Tokengator's per-window allowance versus `once` credits.
- **Google CUD analysis** ([GCP docs](https://docs.cloud.google.com/billing/docs/how-to/cud-analysis-spend-based)).
  - Summary cards: **Active commitments, CUD savings, CUD coverage, CUD utilization, Potential savings**.
  - Coverage is a stacked bar chart: commitment-covered cost (blue or green) against "Eligible cost not covered" (grey).
  - Utilization is a % graph over time. Savings go negative when commitments are under-used.
- **Vantage** ([KPI widgets](https://www.vantage.sh/blog/kpi-dashboard-widgets), [Commitments](https://docs.vantage.sh/commitments)).
  - A KPI widget is exactly "the primary value, a period-over-period change badge, and a date range label".
  - Budget KPIs carry an under / over / **at risk** badge.
  - Empty data shows "No Data Available".
  - The Commitments screen is an inventory with an **Expiration Date** column, sorted by status.
- **Kubecost:** "Cluster Efficiency" (cost of used resources ÷ total) sits in the upper right of the Overview *(search summary only: [docs](https://docs.kubecost.com/using-kubecost/navigating-the-kubecost-ui/efficiency-dashboard))*.
- **FinOps:** commitment **utilization** = used ÷ purchased; **coverage** = covered ÷ eligible; ESR combines them (example "90% utilization × 100% coverage × 50% discount = 45%"). This is a secondary source quoting the FinOps playbook ([Finout](https://www.finout.io/blog/effective-savings-rate-measure-commitment-savings)).
- **Prepaid-credit billing.**
  - Metronome's embeddable dashboard shows remaining and historical balance, grant/deduction history, and "when credits expire" ([announcement](https://metronome.launchnotes.io/announcements/ann_9OECq4lzyK2vP)).
  - FirstSales "**Credit Runway**" shows days of credit at the current rate **next to the renewal countdown**: "if your runway is shorter than your countdown to renewal, you're on track to run out" ([changelog](https://firstsales.io/changelog/see-your-credit-runway/)). Tokengator needs the inverse: a runway longer than the countdown means quota will expire.

### Mobile data plans (a remaining allowance, days left, rollover)

- **Data Widget** ([App Store](https://apps.apple.com/app/id915632592)): the headline is **remaining**, with days left beside it. Wording: "about N days left at this rate", "12% ahead of pace", "on track to run out 9/24" / "enough to last the cycle". Time and usage share one bar; a pace arrow is green under pace and red over. Daily bars. A carry-over setting.
- **InternetTracker** ([App Store](https://apps.apple.com/pg/app/internet-data-tracker-manager/id1100091837)): the widget reads "**Remaining / Days Left / Per Day** plus Today & Yesterday"; a within / near / over banner; a bar per billing period.
- **AT&T Rollover Data:** monthly plan data is used first and rollover after; rollover "expires after one bill period or with a plan change" ([AT&T](https://www.att.com/support/article/wireless/KM1008648/)). Same layered order as Copilot base then flex.
- **Android data usage:** a grey warning line and a red limit line on the usage chart *(search summary only, Verizon Pixel guides)*.

Polarity note: in data plans under-use is good, so they colour it green. That is the opposite of Tokengator. Borrow their **"per day" and "days left at this rate"** wording, not their colours.

### PTO "use it or lose it"

- **BambooHR:** an accrual calculator in the Home "Time Off" widget projects the balance to a chosen date and shows when carry-over is applied or lost *(search summary only: [help](https://bamboohr.screenstepslive.com/m/61968/l/587398-calculate-future-time-off-balances))*. Carry-over balances can have expiry dates ([product update](https://www.bamboohr.com/product-updates/set-expiration-dates-for-carryover-time-off-balances)).
- **Justworks:** a carry-over limit of zero forfeits the whole balance at cycle end ([help](https://help.justworks.com/hc/en-us/articles/360039394232)).
- **Indiana University:** the system precalculates the hours over the carry-over cap and states the hours forfeited *(search summary only: [IU HR](https://hr.iu.edu/relations/year-end.html))*.
- Pattern: a **projected balance on a date**, shown as two figures: what carries over and what is lost.

### Gift cards and loyalty points

- **AwardWallet Plus** ($49.99/yr): "all your reward expirations on a single page"; alerts at 90, 60 and 30 days plus daily in the final 7; calendar sync ([perks](https://awardwallet.com/features/awardwallet-plus-perks/), [calendar](https://awardwallet.com/features/add-calendar-reminders-points-expire/)). The free tier reportedly lost expiry alerts on 2026-10-01 *(search summary only)*.
- **Gift Card Wallet Manager:** reminders 6 months to 1 day before expiry; list sortable by expiry date ([App Store](https://apps.apple.com/app/id6748056861)).
- Pattern: an **inventory sorted by expiry date**, with the face value next to each date.

### Vocabulary people already understand

| Term | Known from | Use in Tokengator | Recommendation |
| --- | --- | --- | --- |
| Utilization | AWS / Azure / GCP, FinOps | Share of what reset that was used (History already says "Utilisation, 30 days") | Keep; pair with a **target** |
| Target (utilization target) | AWS dotted line, Azure alert threshold | A line on the utilization trend; a tick on plan-fit bars | Adopt; default 90%, editable |
| Unused commitment / "cost for unused hours" | AWS, GCP | Tokengator's "expired unused" | Keep "expired unused"; avoid "savings" (it implies money comes back) |
| Potential savings | AWS, GCP, Kubecost | n/a | Avoid; it contradicts D17's "not a refund" |
| Coverage | AWS, GCP | Pay-as-you-go spend next to expiring credits (idea 10) | Use only there, never as a headline |
| Per day / daily allowance / daily target | Data apps, CodexBar | `perDayToFinish` | Adopt: "about 4% a day to finish" |
| Days left at this rate / runway | Data Widget, FirstSales | `requiredMultiple × msLeft` (see idea 2) | Adopt as "would last" |
| Burn-down | CodexBar, Headroom, Scrum | `burnUp` in `charts.ts` already | Fine to name it in alt text and captions |
| Use it or lose it / forfeited | OpenUsage, aiuse, PTO, Copilot docs | Section or tile titles | Adopt as the lead tile's eyebrow-free title |
| Expiring soon / expiry date | Gift cards, AwardWallet, Vantage | Credits wallet | Adopt |
| Rollover / carry-over cap | AT&T, PTO | `rollover: 'carries'` | Keep; caps remain a D18 limit |

---

## 3. Design references for a calm small dashboard

- **One task, one screen.**
  - Dashboards communicate "critical information" for "a single task" ([NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)).
  - Few's first pitfall is "Exceeding the boundaries of a single screen". The rest of his 13 include inadequate context, excessive precision, meaningless variety, poor arrangement, ineffective highlighting, useless decoration and over-used colour ([part 1](https://www.thedataschool.co.uk/anh-vu/are-you-making-these-13-dashboard-design-mistakes/), [part 2](https://www.thedataschool.co.uk/anh-vu/are-you-making-these-13-dashboard-design-mistakes-part-2)).
- **Encoding.**
  - Length and 2D position read best. Colour "should not be used to communicate … magnitude" and should "reinforce information that is already communicated in a different way".
  - Avoid pie, donut and treemap; gauges waste space; **bullet charts** are the better alternative ([NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)).
  - Few's bullet-graph spec has a featured bar, a comparative marker and qualitative ranges, and was designed to replace gauges ([PDF](https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf)). I could not extract the PDF text; this is from general knowledge.
- **Hierarchy.**
  - "The most important data should have the highest contrast and occupy the largest area"; top-left first; same layout, spacing and legend position in every chart; consistent colours per data set ([Carbon dashboards](https://carbondesignsystem.com/data-visualization/dashboards/)).
- **Tile size and density** ([Apple HIG, Widgets](https://developer.apple.com/design/human-interface-guidelines/widgets)).
  - "Small widgets use their limited space to typically show a single piece of information while larger sizes support additional layers … Avoid expanding a smaller widget's content to simply fill a larger area."
  - "Balance information density. Sparse layouts can make the widget seem unnecessary, while overly dense layouts are less glanceable … essential information at a glance and … additional details by taking a longer look."
  - Content that never appears to change gets demoted.
- **KPI tile anatomy** ([Tabular Editor](https://tabulareditor.com/blog/kpi-card-best-practices-dashboard-design)).
  - Value (largest, rounded), target, **variance** (the most important element), trend sparkline, short label.
  - "Five or fewer metrics that drive decisions"; working memory holds about 3–4 chunks.
  - "Format the gap, not the value"; blue/orange beats red/green.
  - The action test: would a 20% change make someone act? A bare number is the most common mistake.
  - Vantage's version: value + period-over-period badge + date label.
- **Sparklines:** "small intense, simple, word-sized graphic with typographic resolution"; mark the endpoints; a grey normal band ([Tufte](https://www.edwardtufte.com/notebook/sparkline-theory-and-practice-edward-tufte/)).
- **Empty states** ([Carbon](https://carbondesignsystem.com/patterns/empty-states-pattern/)).
  - Three kinds: no data, user action, error.
  - A short positive title ("Start by adding…"), one primary action, no dead ends.
  - Replace the empty element rather than showing an empty table to screen readers.
- **Calm technology:** "require the smallest possible amount of attention", "make use of the periphery", "communicate, but doesn't need to speak", "work even when it fails" ([calmtech.com](https://calmtech.com/)).

**Common failures seen in this sweep:**
- One ring per provider (Tokenkarma, ClaudeBar, the CodeBurn dock).
- Green for leftover quota.
- Confetti at reset (CodexBar).
- Streaks and leaderboards (tokscale).
- KPI rows that repeat the header.
- Over-precise percentages that never move (Cursor).
- Hidden reset times (Codex).
- Limits that interact without explanation (Codex).
- Gauges (claude-quota-tracker).

---

## 4. What Tokengator can already feed into tiles

From `src/core/forecast.ts`:
- **`Summary`**: `useNow`, `behind`, `hot`, `stale`, `atRisk` / `atRiskNow` (plan money), `creditsAtRisk` / `creditsAtRiskNow` (credits), `nextReset`, `lost30` / `creditsLost30`, `utilisation30`, `cycles30`, `lostIsEstimate`.
- **`MeterView`**: `remainingFraction`, `projectedFraction`, `projectedUnused`, `perDayToFinish`, `requiredMultiple`, `runsOutAtMs`, `msLeft`, `horizonMs`, `valueAtRisk`, `valueBasis`, `tier`, `throttle`, `blockedUntilMs`, `blockedBy`, `stale`, `ageMs`, `needsReset`.
- **`cyclesOf()`** and `ledgerTotals()`.

From the other modules:
- `ClosedCycle`: `wastedFraction`, `wastedValue`, `endedAt`, `confidence`.
- `SpendSummary` (`src/core/spend.ts`): `monthToDate`, `projected`, `budgetFraction`, `series`, `previousMonth`.
- Chart helpers in `src/web/charts.ts`: `burnUp`, `cycleColumns` and `dailyBars` already exist.

Not extractable today:
- Usage by hour or weekday, and window "shapes" from past windows. `Meter.samples` is "Readings inside the current window" and `ClosedCycle` stores no curve.
- Model or token breakdowns (a non-goal).

The weekday×hour heatmaps in Splitrail and claude-quota-tracker are therefore off the table without a state change.

---

## 5. Ranked tile and chart ideas

Two notes on the list:
- The page header already shows the "N quotas need using now" sentence plus three KPIs (At risk now, At risk all windows, Expired last 30 days). Tiles must not repeat them, per the five-or-fewer rule.
- For every tile: colour means state; a forecast is drawn as an outline or hatching; the chart sits in a `<figure>` with a one-sentence `<figcaption>` built in `src/core/wording.ts` plus a visually hidden table; names go through the existing hide-names path; a tile is a button that opens the inspector for the meter it names.

1. **"Use it before it resets" lead tile.** Full width; the only large tile.
   - Content: the most urgent `use-now` meter (up to 3 more as compact rows), with the countdown as the largest figure. One sentence such as "38% left, about 2.7% an hour finishes it before Fri 09:00". Use `perDayToFinish`, switching to per hour when `msLeft` is under 1 day. The existing `burnUp` chart (even-pace diagonal, dashed projection, hatched expiring end). The account's note ("what to spend it on"), usage link and unattended options as the one action.
   - Empty state: "Nothing expires in the next 72 hours. Next reset: Copilot, 1 Dec 00:00."
   - Credit: OpenUsage Use It or Lose It, CodexBar daily target and burndown, InternetTracker "Per Day", Carbon hierarchy.
   - Why: this is the "I must go in and use up Claude credits before reset" moment, stated once and with something to do.
2. **Runway against reset (bullet bars).**
   - Content: per allowance meter with `projectedUnused ≥ 5%` (up to 5 rows), a neutral track the length of time until reset. An **outline-blue** bar shows how long the remainder lasts at the current pace, `runway = requiredMultiple × msLeft` (no new maths). The part past the reset is **hatched orange**. Hot meters show a runway shorter than the track and use the yellow state with "runs out Thu 14:00".
   - Text: "At this pace the Claude weekly limit would last 2.9 days; it resets in 14 h."
   - Credit: FirstSales Credit Runway (inverted), Data Widget "N days left at this rate", Few's bullet graph.
   - Why: turns "behind pace" into a felt comparison of two durations that anyone can read.
3. **Credits wallet (expiry inventory).**
   - Content: only `valueBasis: 'credit'` meters (bundled API credits, prepaid balances), sorted by `resetsAtMs`. Each row: face value left, "expires in 9 d", hatched-orange projected-to-expire amount. Header figure: credits expiring in the next 30 days, per currency.
   - Plan money never appears here, so D17 holds by construction.
   - Credit: AwardWallet single expiry page, Vantage Expiration Date column, gift-card wallets sorted by expiry, Metronome balances plus expirations.
   - Why: dollar credits expire on long, quiet clocks that are easy to forget.
4. **Utilisation trend with a target line.**
   - Content: 12 weekly columns of mean utilisation across closed allowance cycles. Utilisation is unitless, so meters combine without adding money. Solid blue for used, solid orange for the expired share (facts, as in History), outlined columns for `confidence: 'estimated'`, and a dashed neutral **target** line (default 90%, a new setting).
   - Text: "Used 80% of what reset in the last 30 days, across 15 windows. Target 90%."
   - New pure function: `utilisationByWeek(cycles, nowMs, weeks = 12)` in core.
   - Credit: AWS RI utilization report (dotted target, daily and monthly views), Azure 7/30-day averaging.
   - Why: shows whether the habit is improving, which the per-quota History cannot.
5. **Plan fit (right-size).**
   - Content: one bar per subscription with at least 3 closed cycles: mean utilisation over its last N cycles (from `cyclesOf`) with a target tick. Under 25% is flagged as "used on average", never as "cancel".
   - Text: "Suno Pro: 55% used on average over 3 months."
   - Credit: the AWS per-reservation status bar (red no use / yellow under target / green met; for Tokengator orange and green with shapes), CodeBurn's "under a quarter of the plan", GCP negative savings.
   - Why: the cheapest unused quota is quota you stopped buying.
6. **Blocked and out-of-date.**
   - Content: blocked throttles with reopen times and stale or `needsReset` meters, with "Update" (quick entry) as the action. Example: "ChatGPT Plus is blocked for 47 m by the 5-hour limit; its weekly limit still has 12% left."
   - Empty state: "Every reading is fresh."
   - Credit: OpenUsage Needs Attention, CodexBar oldest-measurement age, Claude "Last updated", Headroom "rough (history gap)", the Codex forum complaint about interacting limits.
   - Why: a stale manual meter is the one that expires unnoticed, and a blocked session explains why the weekly allowance cannot be used right now.
7. **Expired unused, with period comparison.**
   - Content: plan money and credits as two separate figures, each with a change badge against the previous 30 days (wording such as "down 12 from the 30 days before"), and a 12-week sparkline of expired plan money in solid orange (fact).
   - Needs `ledgerTotals` to accept an `until` bound.
   - Credit: Vantage KPI (value + change badge + date label), Tabular Editor variance.
   - Merge with idea 4 if space is short.
8. **This week's resets (7-day strip).**
   - Content: seven day columns; each reset is a mark carrying its state shape (hatched orange where `projectedUnused > 5%`, green where spent), linking to Timeline.
   - Credit: AwardWallet calendar, PTO year-end notices.
   - Why: weekly resets that do not fit the work week are loss mode #2 in research.md. Lower rank because Timeline already covers most of it.
9. **Daily allowance table.**
   - Content: per at-risk meter, "per day to finish" against "your pace so far per day" (used ÷ elapsed days) and the multiple.
   - Credit: data apps' Per Day, CodexBar daily target.
   - Numbers only, which is robust at 320 px. A natural fold-in for idea 2 on narrow screens.
10. **Pay-as-you-go next to expiring credits (the "coverage" analogue).**
    - Content: where a spend source and a credit meter share a `providerId`, show them side by side. Example: "OpenAI API: 42 spent this month; 19 of prepaid credits expire in 40 d." Never summed.
    - Credit: GCP covered against uncovered bars, FinOps coverage.
    - Lower confidence: whether a bundled credit can pay a given API bill differs per provider, so the tile must say so or only appear when a preset says the pool is the same.
11. **Work-week pace (optional).**
    - Content: per-day figures counted over working days ("3 working days left before Friday's reset").
    - Credit: CodexBar six-day work week.
    - Deviates from D4's linear model, so it would be a display option only.
12. **Window-shape history (needs new data).**
    - Content: small multiples of how past windows were used (the burn-up of each closed cycle).
    - Requires storing roughly 10 sampled points per `ClosedCycle` (for example `curve: number[]`).
    - Listed so that nobody fakes it from the current window.

**Layout suggestion.**
- At ≥1024 px: a 12-column grid; lead tile 12; runway 7 + blocked 5; credits wallet 6 + utilisation 6; plan fit 6 + expired 6.
- At ≤640 px: one column in rank order with charts at full width; at 320 px, runway collapses to the allowance numbers.
- Keep the first four tiles above the fold at 1280×800 (Few's single screen).
- Name the tab "Overview", as tokscale and Splitrail do (CodexBar uses "Overview" for its provider switcher), rather than "Box". Board already means cards.

**Do not borrow:** rings or gauges per provider; green for leftover quota; confetti at reset; streaks, leaderboards or contribution heatmaps; API-equivalent dollars; a KPI row that repeats the header; percentages more precise than the decision needs; logo-topped identical cards.
