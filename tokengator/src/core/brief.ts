// Text renderings of the current situation: the Markdown brief behind "copy brief" and the MCP resource,
// per-meter Markdown, the agent prompt, and the plain records agents receive as structured content.

import type { MeterView, Summary } from './forecast.js';
import { TIER_ORDER, allowanceQueue, summarise, viewState } from './forecast.js';
import { formatMoney, formatMoneyTotals, formatPercent } from './format.js';
import type { LedgerWeek } from './insights.js';
import { FIGURE_LABEL, TIER_LABEL, explain, headline, leftText, lostText, recommend, riskMoney, stateLabel, statusLine, summaryLine, usedText, utilisationText } from './wording.js';
import type { State } from './types.js';
import { summariseSpend } from './spend.js';
import { dateKey, formatAge, formatDuration, formatMoment, iso, localZone } from './time.js';

/** Agents have no clock, so every agent-facing text says what time it was written. */
export function stamp(nowMs: number, tz: string = localZone()): string {
  return `${formatMoment(nowMs, nowMs, tz).replace('today ', '')} ${tz} (${iso(nowMs)})`;
}

function resetCell(view: MeterView, nowMs: number, tz?: string): string {
  if (view.msLeft === null || view.resetsAtMs === null) return 'n/a';
  if (view.msLeft <= 0) return 'now';
  return `${formatDuration(view.msLeft)} (${formatMoment(view.resetsAtMs, nowMs, tz)})`;
}

const riskCell = riskMoney;

/** The whole picture as Markdown, most urgent first. */
export function briefMarkdown(state: State, nowMs: number, tz: string = localZone()): string {
  const queue = allowanceQueue(state, nowMs);
  const summary = summarise(state, nowMs);
  const currency = state.settings.currency;
  const lines: string[] = [];
  lines.push('# AI quota brief');
  lines.push('');
  lines.push(`_As of ${stamp(nowMs, tz)}_`);
  lines.push('');
  lines.push(`**${summaryLine(summary, currency)}**`);
  // The same two figures, in the same words, as the Overview's "Finished windows" tile.
  // A line about money only when money expired: "$0.00" in a brief reads as a figure worth reporting.
  if (summary.cycles30 > 0) {
    lines.push('');
    if (hasMoney(summary.lost30) || hasMoney(summary.creditsLost30)) {
      lines.push(`${FIGURE_LABEL.lost30}: ${lostText(summary.lost30, summary.creditsLost30, currency, summary.lostIsEstimate, summary.creditsLostIsEstimate)}.`);
    }
    lines.push(`${FIGURE_LABEL.used30}: ${utilisationText(summary.utilisation30, summary.cycles30)}.`);
  }

  if (queue.length === 0) {
    lines.push('');
    lines.push('No subscriptions are tracked yet.');
    return lines.join('\n');
  }

  for (const tier of TIER_ORDER) {
    const group = queue.filter((view) => view.tier === tier && !view.snoozed);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`## ${TIER_LABEL[tier]}`);
    lines.push('');
    lines.push('| Subscription | Meter | Left | Resets | Will expire | At risk |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const view of group) {
      const flags = [view.stale ? 'stale' : '', view.blockedBy ? 'blocked' : ''].filter(Boolean).join(', ');
      lines.push(
        `| ${escapeCell(view.account.label)} | ${escapeCell(view.meter.label)}${flags ? ` (${flags})` : ''} | ${leftText(view).replace(' left', '')} | ${resetCell(view, nowMs, tz)} | ${hasForecast(view) && view.projectedUnused >= 0.005 ? formatPercent(view.projectedUnused) : ''} | ${riskCell(view)} |`
      );
    }
  }

  const snoozed = queue.filter((view) => view.snoozed);
  if (snoozed.length > 0) {
    lines.push('');
    lines.push(`Snoozed: ${[...new Set(snoozed.map((view) => view.account.label))].join(', ')}.`);
  }

  const first = queue.find((view) => !view.snoozed && (view.tier === 'use-now' || view.tier === 'behind'));
  if (first) {
    lines.push('');
    lines.push(`**Next:** ${recommend(first, nowMs, tz)}`);
  }
  return lines.join('\n');
}

/** A window has a forecast once it has a clock, is past its first few percent, and is not used up. */
function hasForecast(view: MeterView): boolean {
  return view.projectedFraction !== null && view.tier !== 'fresh' && view.tier !== 'spent' && view.tier !== 'idle' && view.tier !== 'expired';
}

/** True when any currency in a total holds a cent or more. */
export function hasMoney(money: Record<string, number>): boolean {
  return Object.values(money).some((amount) => amount > 0.004);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** One meter as Markdown. */
export function meterMarkdown(view: MeterView, nowMs: number, tz: string = localZone()): string {
  const lines: string[] = [];
  lines.push(`### ${view.account.label}, ${view.meter.label}`);
  lines.push('');
  lines.push(`**${headline(view, nowMs, tz)}**`);
  lines.push('');
  lines.push(`- Used: ${usedText(view).replace(/ used$/, '')}`);
  if (view.tier !== null) lines.push(`- Left: ${leftText(view).replace(' left', '')}`);
  if (view.resetsAtMs !== null && view.msLeft !== null && view.msLeft > 0) {
    lines.push(`- Resets: ${formatMoment(view.resetsAtMs, nowMs, tz)} (in ${formatDuration(view.msLeft)})`);
  }
  if (view.tier !== null && hasForecast(view) && view.projectedFraction !== null) {
    lines.push(`- Forecast: ${formatPercent(view.projectedFraction)} used by the reset, ${formatPercent(view.projectedUnused)} expires`);
  }
  const risk = riskCell(view);
  if (risk) lines.push(`- At risk: ${risk}`);
  if (view.account.plan) lines.push(`- Plan: ${view.account.plan}`);
  lines.push(`- Updated: ${view.ageMs === null ? 'never' : formatAge(view.ageMs)}${view.stale ? ' (stale)' : ''}`);
  lines.push('');
  lines.push(explain(view, nowMs, tz));
  return lines.join('\n');
}

/** A prompt that hands the decision to an agent together with the facts it needs. */
export function agentPrompt(view: MeterView, nowMs: number, tz: string = localZone()): string {
  const lines: string[] = [];
  lines.push(`It is ${stamp(nowMs, tz)}.`);
  lines.push(`${statusLine(view, nowMs, tz)}.`);
  lines.push(explain(view, nowMs, tz));
  lines.push('');
  lines.push(
    `I would rather use this ${view.account.label} quota than let it expire. Suggest three concrete, worthwhile things from my current projects that fit in the time left, ordered by value. Do not start any of them until I pick one.`
  );
  return lines.join('\n');
}

/** A compact, stable record for agents and scripts. Absent means unknown, never zero. */
export interface MeterRecord {
  id: string;
  account: string;
  accountId: string;
  provider: string;
  plan: string | null;
  meter: string;
  key: string;
  role: 'allowance' | 'throttle';
  state: string;
  tier: string | null;
  unit: string;
  limit: number;
  used: number;
  remaining: number;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  resetsInMinutes: number | null;
  windowHours: number | null;
  projectedUnusedPercent: number | null;
  valueAtRisk: number | null;
  currency: string | null;
  /** `plan`: a share of the plan fee. `credit`: the face value of a dollar credit. Null without a price. */
  valueBasis: MeterView['valueBasis'];
  requiredPaceMultiple: number | null;
  blockedBy: string | null;
  blockedUntil: string | null;
  stale: boolean;
  updatedAt: string | null;
  source: string;
  estimated: boolean;
  snoozed: boolean;
  headline: string;
  recommendation: string;
}

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function meterRecord(view: MeterView, nowMs: number, tz?: string): MeterRecord {
  return {
    id: view.meter.id,
    account: view.account.label,
    accountId: view.account.id,
    provider: view.account.providerId,
    plan: view.account.plan,
    meter: view.meter.label,
    key: view.meter.key,
    role: view.meter.role,
    state: stateLabel(view),
    tier: view.tier ?? view.throttle,
    unit: view.meter.unit,
    limit: view.limit,
    used: round(view.used, 2),
    remaining: round(view.remaining, 2),
    usedPercent: round(view.usedFraction * 100),
    remainingPercent: round(view.remainingFraction * 100),
    resetsAt: view.resetsAtMs === null ? null : iso(view.resetsAtMs),
    resetsInMinutes: view.msLeft === null ? null : Math.max(0, Math.round(view.msLeft / 60_000)),
    windowHours: view.windowMs === null ? null : round(view.windowMs / 3_600_000),
    projectedUnusedPercent: view.projectedFraction === null ? null : round(view.projectedUnused * 100),
    valueAtRisk: view.valueAtRisk === null ? null : round(view.valueAtRisk, 2),
    currency: view.currency,
    valueBasis: view.valueBasis,
    requiredPaceMultiple: view.requiredMultiple === null ? null : round(view.requiredMultiple),
    blockedBy: view.blockedBy,
    blockedUntil: view.blockedUntilMs === null ? null : iso(view.blockedUntilMs),
    stale: view.stale,
    updatedAt: view.meter.updatedAt,
    source: view.meter.source.id ? `${view.meter.source.kind}:${view.meter.source.id}` : view.meter.source.kind,
    estimated: view.meter.estimated,
    snoozed: view.snoozed,
    headline: headline(view, nowMs, tz),
    recommendation: recommend(view, nowMs, tz)
  };
}

export interface Snapshot {
  generatedAt: string;
  timeZone: string;
  summary: {
    line: string;
    useNow: number;
    behind: number;
    hot: number;
    stale: number;
    /** Plan money expected to expire, per currency: each meter's share of its plan fee. */
    atRisk: Summary['atRisk'];
    /** Dollar credits expected to expire, at face value. Never part of `atRisk`. */
    creditsAtRisk: Summary['creditsAtRisk'];
    lost30: Summary['lost30'];
    creditsLost30: Summary['creditsLost30'];
    /** True when part of `lost30` comes from windows with no reading near their end. */
    lost30IsEstimate: boolean;
    utilisation30Percent: number | null;
    nextReset: { meter: string; account: string; resetsAt: string } | null;
  };
  /** Allowance meters in "use first" order. */
  queue: MeterRecord[];
  /** Rate-limit windows, for context. */
  throttles: MeterRecord[];
}

const cents = (money: Summary['atRisk']): Summary['atRisk'] =>
  Object.fromEntries(Object.entries(money).map(([currency, amount]) => [currency, round(amount, 2)]));

/** The machine-readable twin of the brief: what `what_to_use` and `status --json` return. */
export function snapshot(state: State, nowMs: number, tz: string = localZone()): Snapshot {
  const summary = summarise(state, nowMs);
  const all = viewState(state, nowMs);
  const queue = allowanceQueue(state, nowMs).map((view) => meterRecord(view, nowMs, tz));
  const throttles = all.filter((view) => view.tier === null).map((view) => meterRecord(view, nowMs, tz));
  const next = summary.nextReset;
  return {
    generatedAt: iso(nowMs),
    timeZone: tz,
    summary: {
      line: summaryLine(summary, state.settings.currency),
      useNow: summary.useNow,
      behind: summary.behind,
      hot: summary.hot,
      stale: summary.stale,
      atRisk: cents(summary.atRisk),
      creditsAtRisk: cents(summary.creditsAtRisk),
      lost30: cents(summary.lost30),
      creditsLost30: cents(summary.creditsLost30),
      lost30IsEstimate: summary.lostIsEstimate,
      utilisation30Percent: summary.utilisation30 === null ? null : round(summary.utilisation30 * 100),
      nextReset:
        next && next.resetsAtMs !== null
          ? { meter: next.meter.label, account: next.account.label, resetsAt: iso(next.resetsAtMs) }
          : null
    },
    queue,
    throttles
  };
}

/**
 * What to say when the queue has nothing in it. "Nothing is tracked" is true only when nothing is: said
 * of a snoozed subscription it sends an agent off to add the same one again.
 */
export function emptyQueueNote(state: State, nowMs: number): string {
  if (state.accounts.length === 0) return 'No subscriptions are tracked yet. Add one with add_account.';
  const tracked = `${state.accounts.length} ${state.accounts.length === 1 ? 'subscription is' : 'subscriptions are'} tracked`;
  const snoozed = [...new Set(allowanceQueue(state, nowMs).filter((view) => view.snoozed).map((view) => view.account.label))];
  if (snoozed.length > 0) {
    return `Nothing to list: ${snoozed.join(', ')} ${snoozed.length === 1 ? 'is' : 'are'} snoozed. ${tracked}; do not add ${state.accounts.length === 1 ? 'it' : 'them'} again.`;
  }
  return `Nothing to list: ${tracked}, with rate limits only, and nothing of value expires with a rate limit.`;
}

/** A terse plain-text queue for tool output: one line per meter, most urgent first. */
export function queueText(state: State, nowMs: number, tz: string = localZone(), limit = 20): string {
  const queue = allowanceQueue(state, nowMs).filter((view) => !view.snoozed);
  const summary = summarise(state, nowMs);
  const lines = [`As of ${stamp(nowMs, tz)}.`, summaryLine(summary, state.settings.currency), ''];
  if (queue.length === 0) lines.push(emptyQueueNote(state, nowMs));
  queue.slice(0, limit).forEach((view, index) => {
    lines.push(`${index + 1}. ${statusLine(view, nowMs, tz)}`);
    if (view.tier === 'use-now' || view.tier === 'behind' || view.tier === 'hot') lines.push(`   ${recommend(view, nowMs, tz)}`);
  });
  if (queue.length > limit) lines.push(`(${queue.length - limit} more not shown)`);
  return lines.join('\n');
}

export function costsMarkdown(state: State, nowMs: number, tz?: string): string {
  if (state.spend.length === 0) return 'No API spend sources are tracked.';
  const lines = ['| Source | Month to date | Projected | Budget |', '| --- | --- | --- | --- |'];
  for (const source of state.spend) {
    const s = summariseSpend(source, nowMs, tz);
    const budget = source.monthlyBudget
      ? `${formatMoney(source.monthlyBudget, source.currency)}${s.overBudget ? ' (over)' : s.headingOver ? ' (heading over)' : ''}`
      : '';
    lines.push(
      `| ${escapeCell(source.label)} | ${formatMoney(s.monthToDate, source.currency)} | ${formatMoney(s.projected, source.currency)} | ${budget} |`
    );
  }
  return lines.join('\n');
}

/** The weekly record of finished windows as a Markdown table, for the dashboard's copy action and `waste_report`. */
export function weeksMarkdown(weeks: readonly LedgerWeek[], currency: string, tz?: string): string {
  const lines = ['| Week of | Windows | Expired | Of which estimated | Credits expired | Used, trailing 30 days |', '| --- | --- | --- | --- | --- | --- |'];
  for (const week of weeks) {
    const day = dateKey(week.startMs, tz);
    if (week.windows === 0) {
      lines.push(`| ${day} | 0 | no window closed | | | ${week.trailingUtilisation === null ? '' : formatPercent(week.trailingUtilisation)} |`);
      continue;
    }
    lines.push(
      `| ${day} | ${week.windows} | ${formatMoneyTotals(week.lost, currency, formatMoney(0, currency))} | ${formatMoneyTotals(week.lostEstimated, currency)} | ${formatMoneyTotals(week.creditsLost, currency)} | ${week.trailingUtilisation === null ? '' : formatPercent(week.trailingUtilisation)} |`
    );
  }
  return lines.join('\n');
}
