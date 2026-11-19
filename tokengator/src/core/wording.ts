// One place that puts a meter's state into words. The dashboard, the CLI and the MCP server all call these,
// which is what keeps a person and an agent reading the same sentence about the same quota.

import type { MeterView, Summary, Tier, ThrottleState } from './forecast.js';
import { formatAmount, formatMoney, formatMoneyTotals, formatMultiple, formatPercent } from './format.js';
import { formatAge, formatDuration, formatMoment } from './time.js';

export const TIER_LABEL: Record<Tier, string> = {
  'use-now': 'Use now',
  behind: 'Behind pace',
  hot: 'Running hot',
  'on-pace': 'On pace',
  fresh: 'New window',
  idle: 'Not started',
  balance: 'Balance',
  spent: 'Used up',
  expired: 'Expired'
};

/** What the tier means, for headings and legends. */
export const TIER_HINT: Record<Tier, string> = {
  'use-now': 'Resets soon with quota still left. Use it or it is gone.',
  behind: 'At the current pace part of this will expire unused.',
  hot: 'Burning faster than the window allows. It will run out before the reset.',
  'on-pace': 'On track to be used up around the reset.',
  fresh: 'The window just started. Too early to forecast.',
  idle: 'No window is running, or the reset time is not known yet.',
  balance: 'A balance without a reset.',
  spent: 'Fully used. Nothing will be wasted.',
  expired: 'Past its expiry.'
};

export const THROTTLE_LABEL: Record<ThrottleState, string> = {
  open: 'Open',
  blocked: 'Blocked',
  idle: 'Idle'
};

/** The label of whichever state a view has. */
export function stateLabel(view: MeterView): string {
  if (view.tier !== null) return TIER_LABEL[view.tier];
  return THROTTLE_LABEL[view.throttle ?? 'idle'];
}

export function leftText(view: MeterView): string {
  if (view.meter.unit === 'percent') return `${formatPercent(view.remainingFraction)} left`;
  return `${formatAmount(view.meter, view.remaining)} left`;
}

export function usedText(view: MeterView): string {
  if (view.meter.unit === 'percent') return `${formatPercent(view.usedFraction)} used`;
  return `${formatAmount(view.meter, view.used)} of ${formatAmount(view.meter, view.limit)} used`;
}

export function resetText(view: MeterView): string {
  if (view.msLeft === null) return '';
  if (view.msLeft <= 0) return 'resetting';
  return `resets in ${formatDuration(view.msLeft)}`;
}

function riskMoney(view: MeterView): string {
  if (view.valueAtRisk === null || view.currency === null || view.valueAtRisk < 0.005) return '';
  return formatMoney(view.valueAtRisk, view.currency);
}

/** One short line: the state and the two numbers that matter for it. */
export function headline(view: MeterView, nowMs: number): string {
  if (view.tier === null) {
    switch (view.throttle) {
      case 'blocked':
        return view.msLeft !== null && view.msLeft > 0
          ? `Blocked: reopens in ${formatDuration(view.msLeft)}`
          : 'Blocked: limit reached';
      case 'open':
        return view.msLeft !== null
          ? `Open: ${formatPercent(view.usedFraction)} used, ${resetText(view)}`
          : `Open: ${formatPercent(view.usedFraction)} used`;
      default:
        return 'Idle: opens on first use';
    }
  }
  switch (view.tier) {
    case 'use-now':
      return `Use now: ${leftText(view)}, ${resetText(view)}`;
    case 'behind':
      return `Behind pace: about ${formatPercent(view.projectedUnused)} will expire, ${resetText(view)}`;
    case 'hot':
      return view.runsOutAtMs !== null
        ? `Running hot: runs out ${formatMoment(view.runsOutAtMs, nowMs)}, ${resetText(view)}`
        : `Running hot: ${leftText(view)}, ${resetText(view)}`;
    case 'on-pace':
      return `On pace: ${leftText(view)}, ${resetText(view)}`;
    case 'fresh':
      return `New window: ${leftText(view)}, ${resetText(view)}`;
    case 'spent':
      return view.msLeft !== null && view.msLeft > 0 ? `Used up: ${resetText(view)}` : 'Used up';
    case 'expired':
      return view.remainingFraction > 0.005
        ? `Expired with ${formatPercent(view.remainingFraction)} unused`
        : 'Expired, fully used';
    case 'balance':
      return `Balance: ${leftText(view)}`;
    default:
      if (view.needsReset) return `Reset time unknown: ${leftText(view)}`;
      return view.meter.reset.kind === 'rolling'
        ? `Not started: the ${formatWindow(view)} window opens on first use`
        : `No active window: ${leftText(view)}`;
  }
}

function formatWindow(view: MeterView): string {
  const rule = view.meter.reset;
  if (rule.kind !== 'rolling' && rule.kind !== 'interval') return '';
  if (rule.hours % 24 === 0 && rule.hours >= 24) {
    const days = rule.hours / 24;
    return days === 7 ? 'weekly' : `${days}-day`;
  }
  return `${rule.hours}-hour`;
}

/** Two or three plain sentences explaining the forecast and what would fix it. */
export function explain(view: MeterView, nowMs: number): string {
  const parts: string[] = [];
  const m = view.meter;

  if (view.tier === null) {
    if (view.throttle === 'blocked') {
      parts.push(`${m.label} is at its limit, so this account cannot be used right now.`);
      if (view.resetsAtMs !== null) parts.push(`It reopens ${formatMoment(view.resetsAtMs, nowMs)}.`);
    } else if (view.throttle === 'open') {
      parts.push(`${usedText(view)} in the current window. This is a rate limit, not an allowance: nothing is lost when it resets.`);
    } else {
      parts.push('No window is running. One opens the next time the account is used.');
    }
  } else {
    if (view.elapsedFraction !== null && view.msLeft !== null && view.msLeft > 0) {
      parts.push(`${usedText(view)} with ${formatPercent(1 - view.elapsedFraction)} of the window left.`);
    } else {
      parts.push(`${usedText(view)}.`);
    }
    if (view.tier === 'use-now' || view.tier === 'behind') {
      const money = riskMoney(view);
      parts.push(
        `At this pace about ${formatPercent(view.projectedUnused)} expires unused${money ? `, worth ${money}` : ''}.`
      );
      if (view.requiredMultiple !== null && view.requiredMultiple > 1.05) {
        parts.push(`Finishing it takes ${formatMultiple(view.requiredMultiple)} the pace so far.`);
      } else if (view.perDayToFinish !== null && view.msLeft !== null) {
        const perDay =
          view.msLeft < 86_400_000
            ? `all ${formatAmount(m, view.remaining)} before the reset`
            : `about ${formatAmount(m, view.perDayToFinish)} a day`;
        parts.push(`Finishing it takes ${perDay}.`);
      }
    } else if (view.tier === 'hot' && view.runsOutAtMs !== null && view.resetsAtMs !== null) {
      parts.push(
        `At this pace it runs out ${formatMoment(view.runsOutAtMs, nowMs)}, ${formatDuration(view.resetsAtMs - view.runsOutAtMs)} before the reset. Nothing will be wasted, but it may need rationing.`
      );
    } else if (view.tier === 'on-pace') {
      parts.push('On track to be used up around the reset.');
    } else if (view.tier === 'spent') {
      parts.push('Fully used, so nothing expires.');
    } else if (view.tier === 'fresh') {
      parts.push('The window has only just started, so there is no forecast yet.');
    } else if (view.tier === 'idle' && view.needsReset) {
      parts.push('Set the reset time to get a forecast.');
    }
    if (m.rollover === 'carries') parts.push('Unused quota carries over, so it is not counted as waste.');
    if (view.blockedBy !== null && (view.tier === 'use-now' || view.tier === 'behind')) {
      parts.push(
        view.blockedUntilMs !== null && view.blockedUntilMs > nowMs
          ? `Blocked by ${view.blockedBy} for ${formatDuration(view.blockedUntilMs - nowMs)}.`
          : `Blocked by ${view.blockedBy}.`
      );
    }
  }

  if (m.estimated) parts.push('The window rolled over since the last reading, so these numbers are assumed.');
  else if (view.ageMs === null) parts.push('No reading yet.');
  else if (view.stale) parts.push(`Last updated ${formatAge(view.ageMs)}; refresh before acting on it.`);
  if (view.snoozed) parts.push('Snoozed.');
  return parts.join(' ');
}

/** One line for clipboards, status bars and logs. */
export function statusLine(view: MeterView, nowMs: number): string {
  const name = `${view.account.label} · ${view.meter.label}`;
  const money = riskMoney(view);
  const tail: string[] = [];
  if (money && (view.tier === 'use-now' || view.tier === 'behind')) tail.push(`${money} at risk`);
  if (view.stale && view.ageMs !== null) tail.push(`updated ${formatAge(view.ageMs)}`);
  return `${name}: ${headline(view, nowMs)}${tail.length ? ` (${tail.join(', ')})` : ''}`;
}

/** What an agent or a person should do about it, in one sentence. */
export function recommend(view: MeterView, nowMs: number): string {
  const name = view.account.label;
  const blocked =
    view.blockedBy !== null
      ? view.blockedUntilMs !== null && view.blockedUntilMs > nowMs
        ? ` It is blocked by ${view.blockedBy} for another ${formatDuration(view.blockedUntilMs - nowMs)}.`
        : ` It is currently blocked by ${view.blockedBy}.`
      : '';
  const refresh = view.stale ? ' The reading is stale, so check the usage page first.' : '';
  switch (view.tier) {
    case 'use-now': {
      const money = riskMoney(view);
      return `Prefer ${name} for work the user wants done now: ${leftText(view)} and it ${resetText(view)}${money ? ` (${money} would expire)` : ''}.${blocked}${refresh}`;
    }
    case 'behind':
      return `${name} is behind pace; route suitable work to it before it ${resetText(view)}.${blocked}${refresh}`;
    case 'hot':
      return `Go easy on ${name}: at this pace it runs out before its reset.${refresh}`;
    case 'spent':
      return `${name} is used up until its reset; use something else.`;
    case 'idle':
      return view.needsReset
        ? `${name} has no reset time on record; ask the user or read its usage page.`
        : `${name} has no window running; using it starts one.`;
    case 'expired':
      return `${name} has expired.`;
    default:
      return `${name} needs no action.${refresh}`;
  }
}

/** The sentence at the top of the dashboard and of every brief. */
export function summaryLine(summary: Summary, preferredCurrency?: string): string {
  const money = formatMoneyTotals(summary.atRisk, preferredCurrency);
  if (summary.useNow > 0) {
    const noun = summary.useNow === 1 ? 'quota needs' : 'quotas need';
    const now = formatMoneyTotals(summary.atRiskNow, preferredCurrency);
    return `${summary.useNow} ${noun} using now${now ? `, ${now} at risk` : ''}.`;
  }
  if (summary.behind > 0) {
    const noun = summary.behind === 1 ? 'quota is' : 'quotas are';
    return `Nothing expires in the next hours, but ${summary.behind} ${noun} behind pace${money ? ` (${money} at risk)` : ''}.`;
  }
  if (summary.hot > 0) return 'Nothing is going to waste. Some quotas are running hot.';
  return 'Nothing is going to waste right now.';
}
