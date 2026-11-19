// Text renderings of the current situation: the Markdown brief behind "copy brief" and the MCP resource,
// per-meter Markdown, the agent prompt, and the plain records agents receive as structured content.

import type { MeterView, Summary } from './forecast.js';
import { TIER_ORDER, allowanceQueue, summarise, viewState } from './forecast.js';
import { formatMoney, formatMoneyTotals, formatPercent } from './format.js';
import { TIER_LABEL, explain, headline, leftText, recommend, stateLabel, statusLine, summaryLine, usedText } from './wording.js';
import type { State } from './types.js';
import { summariseSpend } from './spend.js';
import { formatAge, formatDuration, formatMoment, iso, localZone } from './time.js';

/** Agents have no clock, so every agent-facing text says what time it was written. */
export function stamp(nowMs: number, tz: string = localZone()): string {
  return `${formatMoment(nowMs, nowMs, tz).replace('today ', '')} ${tz} (${iso(nowMs)})`;
}

function resetCell(view: MeterView, nowMs: number, tz?: string): string {
  if (view.msLeft === null || view.resetsAtMs === null) return 'n/a';
  if (view.msLeft <= 0) return 'now';
  return `${formatDuration(view.msLeft)} (${formatMoment(view.resetsAtMs, nowMs, tz)})`;
}

function riskCell(view: MeterView): string {
  if (view.valueAtRisk === null || view.currency === null || view.valueAtRisk < 0.005) return '';
  return formatMoney(view.valueAtRisk, view.currency);
}

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
  const lost = formatMoneyTotals(summary.lost30, currency);
  if (lost) {
    lines.push('');
    lines.push(`Expired unused in the last 30 days: ${summary.lostIsEstimate ? 'about ' : ''}${lost}.`);
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
        `| ${escapeCell(view.account.label)} | ${escapeCell(view.meter.label)}${flags ? ` (${flags})` : ''} | ${leftText(view).replace(' left', '')} | ${resetCell(view, nowMs, tz)} | ${view.projectedUnused >= 0.005 ? formatPercent(view.projectedUnused) : ''} | ${riskCell(view)} |`
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
    lines.push(`**Next:** ${recommend(first, nowMs)}`);
  }
  return lines.join('\n');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** One meter as Markdown. */
export function meterMarkdown(view: MeterView, nowMs: number, tz: string = localZone()): string {
  const lines: string[] = [];
  lines.push(`### ${view.account.label} · ${view.meter.label}`);
  lines.push('');
  lines.push(`**${headline(view, nowMs)}**`);
  lines.push('');
  lines.push(`- Used: ${usedText(view)}`);
  if (view.tier !== null) lines.push(`- Left: ${leftText(view).replace(' left', '')}`);
  if (view.resetsAtMs !== null && view.msLeft !== null && view.msLeft > 0) {
    lines.push(`- Resets: ${formatMoment(view.resetsAtMs, nowMs, tz)} (in ${formatDuration(view.msLeft)})`);
  }
  if (view.projectedFraction !== null && view.tier !== null) {
    lines.push(`- Forecast: ${formatPercent(view.projectedFraction)} used by the reset, ${formatPercent(view.projectedUnused)} expires`);
  }
  const risk = riskCell(view);
  if (risk) lines.push(`- At risk: ${risk}`);
  if (view.account.plan) lines.push(`- Plan: ${view.account.plan}`);
  lines.push(`- Updated: ${view.ageMs === null ? 'never' : formatAge(view.ageMs)}${view.stale ? ' (stale)' : ''}`);
  lines.push('');
  lines.push(explain(view, nowMs));
  return lines.join('\n');
}

/** A prompt that hands the decision to an agent together with the facts it needs. */
export function agentPrompt(view: MeterView, nowMs: number, tz: string = localZone()): string {
  const lines: string[] = [];
  lines.push(`It is ${stamp(nowMs, tz)}.`);
  lines.push(`${statusLine(view, nowMs)}.`);
  lines.push(explain(view, nowMs));
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

export function meterRecord(view: MeterView, nowMs: number): MeterRecord {
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
    requiredPaceMultiple: view.requiredMultiple === null ? null : round(view.requiredMultiple),
    blockedBy: view.blockedBy,
    blockedUntil: view.blockedUntilMs === null ? null : iso(view.blockedUntilMs),
    stale: view.stale,
    updatedAt: view.meter.updatedAt,
    source: view.meter.source.id ? `${view.meter.source.kind}:${view.meter.source.id}` : view.meter.source.kind,
    estimated: view.meter.estimated,
    snoozed: view.snoozed,
    headline: headline(view, nowMs),
    recommendation: recommend(view, nowMs)
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
    atRisk: Summary['atRisk'];
    lost30: Summary['lost30'];
    utilisation30Percent: number | null;
    nextReset: { meter: string; account: string; resetsAt: string } | null;
  };
  /** Allowance meters in "use first" order. */
  queue: MeterRecord[];
  /** Rate-limit windows, for context. */
  throttles: MeterRecord[];
}

/** The machine-readable twin of the brief: what `what_to_use` and `status --json` return. */
export function snapshot(state: State, nowMs: number, tz: string = localZone()): Snapshot {
  const summary = summarise(state, nowMs);
  const all = viewState(state, nowMs);
  const queue = allowanceQueue(state, nowMs).map((view) => meterRecord(view, nowMs));
  const throttles = all.filter((view) => view.tier === null).map((view) => meterRecord(view, nowMs));
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
      atRisk: summary.atRisk,
      lost30: summary.lost30,
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

/** A terse plain-text queue for tool output: one line per meter, most urgent first. */
export function queueText(state: State, nowMs: number, tz: string = localZone(), limit = 20): string {
  const queue = allowanceQueue(state, nowMs).filter((view) => !view.snoozed);
  const summary = summarise(state, nowMs);
  const lines = [`As of ${stamp(nowMs, tz)}.`, summaryLine(summary, state.settings.currency), ''];
  if (queue.length === 0) lines.push('No subscriptions are tracked yet. Add one with add_account.');
  queue.slice(0, limit).forEach((view, index) => {
    lines.push(`${index + 1}. ${statusLine(view, nowMs)}`);
    if (view.tier === 'use-now' || view.tier === 'behind' || view.tier === 'hot') lines.push(`   ${recommend(view, nowMs)}`);
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
