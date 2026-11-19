// One place that puts a meter's state into words. The dashboard, the CLI and the MCP server all call these,
// which is what keeps a person and an agent reading the same sentence about the same quota.

import { TIER_ORDER, type MeterView, type Money, type Summary, type Tier, type ThrottleState } from './forecast.js';
import type { ExpiryOutlook, TierCounts } from './insights.js';
import { formatAmount, formatMoney, formatMoneyTotals, formatMultiple, formatNumber, formatPercent } from './format.js';
import { DAY, HOUR, formatAge, formatDuration, formatMoment } from './time.js';

export const TIER_LABEL: Record<Tier, string> = {
  'use-now': 'Use now',
  behind: 'Behind pace',
  hot: 'Running hot',
  'on-pace': 'On pace',
  fresh: 'New window',
  idle: 'Not running',
  balance: 'Balance',
  spent: 'Used up',
  expired: 'Expired'
};

/** What the tier means, for headings and legends. */
export const TIER_HINT: Record<Tier, string> = {
  'use-now': 'Resets soon, and at this pace part of it will expire. Use it or it is gone.',
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
  // "Not running" would be wrong for a quota that is being used and only lacks its reset time.
  if (view.tier === 'idle' && view.needsReset) return 'Reset time unknown';
  if (view.tier !== null) return TIER_LABEL[view.tier];
  return THROTTLE_LABEL[view.throttle ?? 'idle'];
}

export function leftText(view: MeterView): string {
  if (view.meter.unit === 'percent') return `${formatPercent(view.remainingFraction)} left`;
  return `${formatAmount(view.meter, view.remaining)} left`;
}

export function usedText(view: MeterView): string {
  if (view.meter.unit === 'percent') return `${formatPercent(view.usedFraction)} used`;
  // Dollars keep their sign on both figures; counted units name the unit once: "120 of 300 requests used".
  if (view.meter.unit === 'usd') return `${formatAmount(view.meter, view.used)} of ${formatAmount(view.meter, view.limit)} used`;
  return `${formatNumber(view.used)} of ${formatAmount(view.meter, view.limit)} used`;
}

export function resetText(view: MeterView): string {
  if (view.msLeft === null) return '';
  if (view.msLeft <= 0) return 'resetting';
  return `resets in ${formatDuration(view.msLeft)}`;
}

/**
 * The money a meter is expected to lose, as text: "$7.39" for a share of the plan fee, "$66.92 in credits"
 * for a credit counted in dollars. Empty when there is no price or nothing at risk.
 */
export function riskMoney(view: MeterView): string {
  if (view.valueAtRisk === null || view.currency === null || view.valueAtRisk < 0.005) return '';
  const amount = formatMoney(view.valueAtRisk, view.currency);
  return view.valueBasis === 'credit' ? `${amount} in credits` : amount;
}

/**
 * Plan money and dollar credits side by side, never summed: "$13.41", "$13.41, plus $66.92 in credits",
 * "$66.92 in credits". `tail` follows the plan figure, or the credits when there is no plan figure.
 */
export function moneyPair(plan: Money, credits: Money, preferredCurrency?: string, tail = ''): string {
  const planText = formatMoneyTotals(plan, preferredCurrency);
  const creditText = formatMoneyTotals(credits, preferredCurrency);
  const suffix = tail ? ` ${tail}` : '';
  if (planText && creditText) return `${planText}${suffix}, plus ${creditText} in credits`;
  if (planText) return `${planText}${suffix}`;
  if (creditText) return `${creditText} in credits${suffix}`;
  return '';
}

/**
 * Money that expired in one finished window, or over several windows of the same meter: "$17.25" for
 * plan money, "$70.00 in credits" for a credit counted in dollars. Empty when there is none.
 */
export function expiredMoney(amount: number | null, currency: string | null, unit: string): string {
  if (amount === null || currency === null || amount < 0.005) return '';
  const text = formatMoney(amount, currency);
  return unit === 'usd' ? `${text} in credits` : text;
}

/** What a plan-share figure is, for tooltips: people read a dollar sign as a charge unless told otherwise. */
export const PLAN_VALUE_NOTE = 'Your plan fee spread over this window. An estimate for comparing quotas, not a charge or a refund.';
export const CREDIT_VALUE_NOTE = 'The face value of this credit. It can only be spent where the provider accepts it.';

/**
 * Money that expired, for display: to the cent when every window behind it was observed, and "about" with
 * whole units when part of it is an estimate. An estimate given to the cent claims a precision it lacks.
 */
export function lostMoney(totals: Money, currency: string, estimate: boolean): string {
  if (!estimate) return formatMoneyTotals(totals, currency, formatMoney(0, currency));
  const whole = Object.fromEntries(Object.entries(totals).map(([code, amount]) => [code, Math.round(amount)]));
  return `about ${formatMoneyTotals(whole, currency, formatMoney(0, currency)).replace(/\.00\b/g, '')}`;
}

/** One short line: the state and the two numbers that matter for it. */
export function headline(view: MeterView, nowMs: number, tz?: string): string {
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
        ? `Running hot: runs out ${formatMoment(view.runsOutAtMs, nowMs, tz)}, ${resetText(view)}`
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
export function explain(view: MeterView, nowMs: number, tz?: string): string {
  const parts: string[] = [];
  const m = view.meter;

  if (view.tier === null) {
    if (view.throttle === 'blocked') {
      parts.push(`${m.label} is at its limit, so this account cannot be used right now.`);
      if (view.resetsAtMs !== null) parts.push(`It reopens ${formatMoment(view.resetsAtMs, nowMs, tz)}.`);
    } else if (view.throttle === 'open') {
      parts.push(`${usedText(view)} in the current window. This is a rate limit, not an allowance: nothing is lost when it resets.`);
      if (view.needsReset) parts.push('Its reset time is not known yet.');
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
        `At this pace it runs out ${formatMoment(view.runsOutAtMs, nowMs, tz)}, ${formatDuration(view.resetsAtMs - view.runsOutAtMs)} before the reset. Nothing will be wasted, but it may need rationing.`
      );
    } else if (view.tier === 'on-pace' && m.rollover !== 'carries') {
      parts.push('On track to be used up around the reset.');
    } else if (view.tier === 'spent') {
      parts.push('Fully used, so nothing expires.');
    } else if (view.tier === 'fresh') {
      parts.push('The window has only just started, so there is no forecast yet.');
    } else if (view.tier === 'idle' && view.needsReset) {
      parts.push('Set the reset time to get a forecast.');
    }
    if (m.rollover === 'carries') parts.push('Unused quota carries over to the next window, so nothing is lost at the reset.');
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

/**
 * The headline with the share left always in it. On a row the bar beside the headline shows what is left;
 * a line that travels alone (a clipboard, a status bar, a tool answer) has to say it.
 */
function headlineWithLeft(view: MeterView, nowMs: number, tz?: string): string {
  const text = headline(view, nowMs, tz);
  if (view.tier !== 'behind' && !(view.tier === 'hot' && view.runsOutAtMs !== null)) return text;
  const at = text.indexOf(': ') + 2;
  return `${text.slice(0, at)}${leftText(view)}, ${text.slice(at)}`;
}

/** One line for clipboards, status bars and logs: who, the state, the share left, the reset, the money. */
export function statusLine(view: MeterView, nowMs: number, tz?: string): string {
  const name = `${view.account.label}, ${view.meter.label}`;
  const money = riskMoney(view);
  const tail: string[] = [];
  if (money && (view.tier === 'use-now' || view.tier === 'behind')) tail.push(`${money} at risk`);
  // A meter that was never read is stale too, and its numbers are assumptions: say so, or "0% used" on an
  // untouched preset reads as a fact.
  if (view.stale) tail.push(view.ageMs !== null ? `updated ${formatAge(view.ageMs)}` : 'no reading yet');
  return `${name}: ${headlineWithLeft(view, nowMs, tz)}${tail.length ? ` (${tail.join(', ')})` : ''}`;
}

/** What an agent or a person should do about it, in one sentence. */
export function recommend(view: MeterView, nowMs: number, _tz?: string): string {
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
  if (summary.useNow > 0) {
    const noun = summary.useNow === 1 ? 'quota needs' : 'quotas need';
    const now = moneyPair(summary.atRiskNow, summary.creditsAtRiskNow, preferredCurrency, 'at risk');
    return `${summary.useNow} ${noun} using now${now ? `, ${now}` : ''}.`;
  }
  if (summary.behind > 0) {
    const noun = summary.behind === 1 ? 'quota is' : 'quotas are';
    const money = moneyPair(summary.atRisk, summary.creditsAtRisk, preferredCurrency, 'at risk');
    return `Nothing expires in the next hours, but ${summary.behind} ${noun} behind pace${money ? ` (${money})` : ''}.`;
  }
  if (summary.hot > 0) return 'Nothing is going to waste. Some quotas are running hot.';
  return 'Nothing is going to waste right now.';
}

// ---------------------------------------------------------------------------
// Figures shared by the Overview, the brief, the command line and the MCP server
// ---------------------------------------------------------------------------

/** The names of the figures, so a person reading the dashboard and an agent reading a tool see the same label. */
export const FIGURE_LABEL = {
  atRiskNow: 'At risk now',
  atRisk: 'At risk, all windows',
  nextWeek: 'Next 7 days',
  lost30: 'Expired unused, last 30 days',
  used30: 'Used, last 30 days'
} as const;

/**
 * Money that expired, plan money and dollar credits side by side and never summed, each "about" a whole
 * amount when estimated windows contribute: "about $39, plus $52.00 in credits". "$0.00" when nothing did.
 */
export function lostText(lost: Money, creditsLost: Money, currency: string, estimate: boolean, creditsEstimate = estimate): string {
  const has = (money: Money): boolean => Object.values(money).some((amount) => amount > 0.004);
  const plan = has(lost) ? lostMoney(lost, currency, estimate) : '';
  const credits = has(creditsLost) ? lostMoney(creditsLost, currency, creditsEstimate) : '';
  if (plan && credits) return `${plan}, plus ${credits} in credits`;
  if (plan) return plan;
  if (credits) return `${credits} in credits`;
  return formatMoney(0, currency);
}

/** The share of each window used, averaged: "80% used on average over 15 windows". */
export function utilisationText(fraction: number | null, windows: number): string {
  if (fraction === null || windows === 0) return 'No finished windows yet';
  return `${formatPercent(fraction)} used on average over ${windows === 1 ? '1 window' : `${windows} windows`}`;
}

export type Trend = 'up' | 'down' | 'flat' | null;

/**
 * How the money expired in the last 30 days compares with the 30 days before, in the preferred currency:
 * "down about $11 on the 30 days before". A change under a tenth (and under one unit) reads as the same.
 */
export function trendText(current: Money, previous: Money, currency: string, estimate: boolean, previousWindows: number): { text: string; trend: Trend } {
  if (previousWindows === 0) return { text: 'No windows closed in the 30 days before.', trend: null };
  const now = current[currency] ?? 0;
  const before = previous[currency] ?? 0;
  const diff = now - before;
  if (Math.abs(diff) < Math.max(1, 0.1 * before)) return { text: 'About the same as the 30 days before.', trend: 'flat' };
  const amount = formatMoney(Math.round(Math.abs(diff)), currency).replace(/\.00\b/, '');
  return { text: `${diff > 0 ? 'Up' : 'Down'} ${estimate ? 'about ' : ''}${amount} on the 30 days before.`, trend: diff > 0 ? 'up' : 'down' };
}

/** A rate in a meter's unit with a decimal where it matters: "2.7%", "45 credits", "$1.20". */
function rateAmount(view: MeterView, amount: number): string {
  if (view.meter.unit === 'percent') return amount < 9.95 ? `${(Math.round(amount * 10) / 10).toString()}%` : `${Math.round(amount)}%`;
  if (view.meter.unit === 'usd') return formatAmount(view.meter, amount);
  // Counted units: a decimal only where the figure is small enough for it to matter.
  return formatAmount(view.meter, amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10);
}

/**
 * How hard a quota has to be used to finish it before the reset: "About 2.7% an hour uses it up by tomorrow
 * 07:42." The time a closed session limit keeps the account shut does not count. No name: the caller adds
 * one, so it can be hidden on a shared screen. Null for a quota that is not short of use.
 */
export function finishLine(view: MeterView, nowMs: number, tz?: string): string | null {
  if (view.tier !== 'use-now' && view.tier !== 'behind') return null;
  if (view.resetsAtMs === null || view.resetsAtMs <= nowMs || view.remaining <= 0) return null;
  const opens = view.blockedUntilMs !== null && view.blockedUntilMs > nowMs ? view.blockedUntilMs : nowMs;
  const available = view.resetsAtMs - opens;
  const left = view.meter.unit === 'percent' ? view.remainingFraction * 100 : view.remaining;
  const blocked = opens > nowMs ? ` once it reopens ${formatMoment(opens, nowMs, tz)}` : '';
  if (available <= 0) return `It reopens only at the reset, so what is left expires.`;
  if (available < DAY) return `About ${rateAmount(view, left / (available / HOUR))} an hour${blocked} uses it up by ${formatMoment(view.resetsAtMs, nowMs, tz)}.`;
  return `About ${rateAmount(view, left / (available / DAY))} a day${blocked} uses it up by ${formatMoment(view.resetsAtMs, nowMs, tz)}.`;
}

/** When a quota now behind pace will enter its "use now" stretch: "needs using from Wed 25 Nov 21:30". */
export function nextUseNowLine(atMs: number, nowMs: number, tz?: string): string {
  return `needs using from ${formatMoment(atMs, nowMs, tz)} if it is still behind pace`;
}

/** How old a reading is: "updated 4d ago", "no reading yet", or that the reset time is unknown. */
export function readingAge(view: MeterView): string {
  if (view.ageMs === null) return 'no reading yet';
  if (view.needsReset && !view.stale) return `reset time unknown, updated ${formatAge(view.ageMs)}`;
  return `updated ${formatAge(view.ageMs)}`;
}

/** The sentences under the expiry chart, in a fixed order. */
export function expiryCaption(outlook: ExpiryOutlook, currency: string, nowMs: number, tz?: string, noPrices = false): string {
  const parts: string[] = [];
  parts.push(noPrices ? 'No prices are set, so the chart counts the quotas that lose at least 5%. Add a plan price to see what is at stake.' : 'Hatched: expected to expire at the current pace.');
  const later = moneyPair(outlook.later.plan, outlook.later.credits, currency);
  if (later && outlook.later.firstMs !== null) parts.push(`Resetting after ${outlook.days.length} days: ${later}, the first ${formatMoment(outlook.later.firstMs, nowMs, tz)}.`);
  if (!noPrices && outlook.unvalued > 0) parts.push(`${outlook.unvalued === 1 ? '1 more quota expires' : `${outlook.unvalued} more quotas expire`} with no price set.`);
  const others = Object.entries(outlook.days.reduce<Money>((sum, day) => {
    for (const [code, amount] of Object.entries(day.plan)) if (code !== currency) sum[code] = (sum[code] ?? 0) + amount;
    return sum;
  }, {}));
  if (others.length > 0) parts.push(`Plus ${formatMoneyTotals(Object.fromEntries(others))} in other currencies, listed in the table.`);
  if (outlook.stale > 0) parts.push(`Includes ${outlook.stale === 1 ? '1 stale reading' : `${outlook.stale} stale readings`}.`);
  if (outlook.snoozed > 0) parts.push(`${outlook.snoozed === 1 ? '1 snoozed quota is' : `${outlook.snoozed} snoozed quotas are`} not counted.`);
  return parts.join(' ');
}

/** What the even-pace chart holds, in words: the counts per state and what it leaves out. */
export function paceCaption(counts: TierCounts, throttles: number): string {
  const tiers = TIER_ORDER.filter((tier) => (counts.tiers[tier] ?? 0) > 0).map((tier) => `${counts.tiers[tier]} ${TIER_LABEL[tier].toLowerCase()}`);
  const parts = [counts.plotted === 0 ? 'No quota has a running window.' : `Of ${counts.plotted === 1 ? '1 quota' : `${counts.plotted} quotas`} with a running window: ${tiers.join(', ')}.`];
  parts.push('Across: share of the window gone, not time; up: share used.');
  const left: string[] = [];
  if (counts.unplotted > 0) left.push(counts.unplotted === 1 ? '1 quota without a running window' : `${counts.unplotted} quotas without a running window`);
  if (counts.snoozed > 0) left.push(counts.snoozed === 1 ? '1 snoozed quota' : `${counts.snoozed} snoozed quotas`);
  if (throttles > 0) left.push(throttles === 1 ? '1 rate limit' : `${throttles} rate limits`);
  if (left.length > 0) parts.push(`Not shown: ${left.join(', ')}.`);
  return parts.join(' ');
}
