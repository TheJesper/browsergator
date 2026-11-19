// Sample data for the "try it" mode and the single-file preview. Built relative to the current time so
// the picture always shows the full range: something to use now, something behind pace, something running
// hot, something used up, a blocked session, and a few weeks of history.

import { addAccount } from './accounts.js';
import { CATALOG } from './catalog.js';
import { findPlan, findProvider, presetAccountInput } from './catalog-types.js';
import { windowValue } from './reset.js';
import { addSpendSource } from './spend.js';
import { DAY, HOUR, MINUTE, dateKey, iso } from './time.js';
import { emptyState, type Account, type ClosedCycle, type Meter, type State } from './types.js';

/** Small deterministic generator: the same sample data on every load, no Math.random flicker. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface MeterShape {
  /** Share of the limit used right now. */
  used: number;
  /** Time until the window resets; null leaves a rolling window idle. */
  resetsIn: number | null;
  /** Window length. */
  window: number;
  /** Minutes since the last reading. */
  ageMinutes?: number;
}

function shapeMeter(meter: Meter, shape: MeterShape, nowMs: number, random: () => number): Meter {
  if (shape.resetsIn === null) return { ...meter, source: { kind: 'demo' } };
  const end = nowMs + shape.resetsIn;
  const start = end - shape.window;
  const used = meter.limit * shape.used;
  const last = nowMs - (shape.ageMinutes ?? 6) * MINUTE;
  // A plausible climb: bursts during working hours, flat overnight.
  const samples: Meter['samples'] = [];
  const steps = Math.max(4, Math.min(28, Math.round((last - start) / (shape.window / 30))));
  let level = 0;
  const weights: number[] = [];
  for (let i = 0; i < steps; i += 1) weights.push(0.25 + random() * (random() > 0.35 ? 1.6 : 0.1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < steps; i += 1) {
    level += ((weights[i] ?? 0) / total) * used;
    samples.push({ t: iso(start + ((i + 1) / steps) * (last - start)), used: Math.round(level * 100) / 100 });
  }
  return {
    ...meter,
    used,
    windowStartedAt: iso(start),
    resetsAt: iso(end),
    updatedAt: iso(last),
    samples,
    source: { kind: 'demo' },
    estimated: false
  };
}

function build(
  state: State,
  providerId: string,
  planId: string,
  nowMs: number,
  shapes: Record<string, MeterShape>,
  seed: number,
  options: { label?: string; billingDay?: number; notes?: string; limits?: Record<string, number> } = {}
): State {
  const provider = findProvider(CATALOG, providerId);
  const plan = provider ? findPlan(provider, planId) : null;
  if (!provider || !plan) return state;
  const input = presetAccountInput(provider, plan, options.label, options.billingDay);
  if (options.notes) input.notes = options.notes;
  const added = addAccount(state, input, nowMs, { kind: 'demo' });
  const random = seeded(seed);
  const account: Account = {
    ...added.account,
    meters: added.account.meters.map((meter) => {
      const limit = options.limits?.[meter.key];
      const sized = limit ? { ...meter, limit } : meter;
      const shape = shapes[meter.key];
      return shape ? shapeMeter(sized, shape, nowMs, random) : { ...sized, source: { kind: 'demo' as const } };
    })
  };
  return { ...added.state, accounts: added.state.accounts.map((candidate) => (candidate.id === account.id ? account : candidate)) };
}

function history(state: State, meterId: string, nowMs: number, usedShares: number[], seed: number): ClosedCycle[] {
  const account = state.accounts.find((candidate) => candidate.meters.some((meter) => meter.id === meterId));
  const meter = account?.meters.find((candidate) => candidate.id === meterId);
  if (!account || !meter || !meter.windowStartedAt || !meter.resetsAt) return [];
  const windowMs = Date.parse(meter.resetsAt) - Date.parse(meter.windowStartedAt);
  const value = windowValue(account, meter, windowMs);
  const random = seeded(seed);
  const out: ClosedCycle[] = [];
  let end = Date.parse(meter.windowStartedAt);
  for (let i = usedShares.length - 1; i >= 0; i -= 1) {
    const usedShare = usedShares[i] ?? 1;
    const wastedFraction = Math.max(0, 1 - usedShare);
    out.unshift({
      id: `${meter.id}:${iso(end)}:demo`,
      accountId: account.id,
      meterId: meter.id,
      providerId: account.providerId,
      accountLabel: account.label,
      meterLabel: meter.label,
      unit: meter.unit,
      startedAt: iso(end - windowMs),
      endedAt: iso(end),
      limit: meter.limit,
      used: meter.limit * usedShare,
      wastedFraction,
      wastedValue: value === null ? null : value * wastedFraction,
      currency: meter.unit === 'usd' ? 'USD' : (account.price?.currency ?? null),
      confidence: random() > 0.25 ? 'measured' : 'estimated'
    });
    end -= windowMs;
    if (nowMs - end > 120 * DAY) break;
  }
  return out;
}

export function demoState(nowMs: number): State {
  let state = emptyState();
  const week = 7 * DAY;
  const month = 30 * DAY;

  // Use now: the week is nearly over and more than a third is still there.
  state = build(
    state,
    'claude',
    'max',
    nowMs,
    {
      session: { used: 0.64, resetsIn: 2 * HOUR + 10 * MINUTE, window: 5 * HOUR },
      weekly: { used: 0.62, resetsIn: 14 * HOUR + 12 * MINUTE, window: week },
      'weekly-fable': { used: 0.41, resetsIn: 14 * HOUR + 12 * MINUTE, window: week },
      'api-credits': { used: 0.22, resetsIn: 9 * DAY + 4 * HOUR, window: month, ageMinutes: 60 * 26 }
    },
    11,
    { notes: 'Ideas when the week is ending with quota left:\n- run the dependency upgrade on the side projects\n- generate the missing test suites\n- long refactor of the importer' }
  );
  // Running hot, and its session cap is hit.
  state = build(
    state,
    'codex',
    'plus',
    nowMs,
    {
      session: { used: 1, resetsIn: 48 * MINUTE, window: 5 * HOUR },
      weekly: { used: 0.88, resetsIn: 2 * DAY + 1 * HOUR, window: week }
    },
    23
  );
  // Behind pace on a calendar-month allowance.
  const startOfMonth = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), 1);
  const startOfNext = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth() + 1, 1);
  const monthElapsed = (nowMs - startOfMonth) / (startOfNext - startOfMonth);
  state = build(
    state,
    'copilot',
    'pro',
    nowMs,
    { 'ai-credits': { used: Math.max(0.04, monthElapsed * 0.45), resetsIn: startOfNext - nowMs, window: startOfNext - startOfMonth, ageMinutes: 35 } },
    37
  );
  // On pace, with a monthly credit grant falling behind.
  state = build(
    state,
    'gemini',
    'pro',
    nowMs,
    {
      session: { used: 0.18, resetsIn: 3 * HOUR + 40 * MINUTE, window: 5 * HOUR },
      weekly: { used: 0.52, resetsIn: 3 * DAY + 6 * HOUR, window: week },
      'flow-credits': { used: 0.18, resetsIn: 11 * DAY, window: month, ageMinutes: 60 * 50 },
      'flow-music': { used: 0.05, resetsIn: 11 * DAY, window: month, ageMinutes: 60 * 50 }
    },
    41,
    { billingDay: new Date(nowMs + 11 * DAY).getDate() }
  );
  // Use now, and stale: nobody has looked at it for days.
  state = build(
    state,
    'suno',
    'pro',
    nowMs,
    { credits: { used: 0.36, resetsIn: 2 * DAY + 3 * HOUR, window: month, ageMinutes: 60 * 24 * 4 } },
    53,
    { billingDay: new Date(nowMs + 2 * DAY + 3 * HOUR).getDate() }
  );
  // Carries over: unused credits are not lost, so nothing is at risk.
  state = build(
    state,
    'elevenlabs',
    'creator',
    nowMs,
    { credits: { used: 0.31, resetsIn: 6 * DAY + 5 * HOUR, window: month, ageMinutes: 12 } },
    67,
    { billingDay: new Date(nowMs + 6 * DAY + 5 * HOUR).getDate() }
  );
  // Used up: the good ending.
  state = build(
    state,
    'midjourney',
    'standard',
    nowMs,
    { fast: { used: 0.985, resetsIn: 8 * DAY, window: month, ageMinutes: 60 * 9 } },
    71,
    { billingDay: new Date(nowMs + 8 * DAY).getDate() }
  );
  // Prepaid credits that expire in six weeks.
  state = build(
    state,
    'openai-api',
    'prepaid',
    nowMs,
    { credits: { used: 0.62, resetsIn: 41 * DAY, window: 365 * DAY, ageMinutes: 60 * 20 } },
    83
  );
  // A window that just opened.
  state = build(state, 'jetbrains-ai', 'pro', nowMs, { credits: { used: 0.02, resetsIn: 29 * DAY + 2 * HOUR, window: month, ageMinutes: 90 } }, 89);

  // History: what the last weeks looked like.
  const cycles: ClosedCycle[] = [
    ...history(state, 'claude-max:weekly', nowMs, [0.58, 0.71, 0.49, 0.93, 0.66, 0.81, 0.74, 0.69], 5),
    ...history(state, 'chatgpt-plus:weekly', nowMs, [0.82, 1, 0.91, 1, 0.97, 1, 0.88, 1], 7),
    ...history(state, 'github-copilot-pro:ai-credits', nowMs, [0.41, 0.63, 0.52], 9),
    ...history(state, 'google-ai-pro:weekly', nowMs, [0.77, 0.9, 0.84, 0.95, 0.7, 0.88], 13),
    ...history(state, 'suno-pro:credits', nowMs, [0.44, 0.83, 0.38], 15),
    ...history(state, 'midjourney-standard:fast', nowMs, [1, 0.96, 1], 17)
  ].sort((a, b) => (a.endedAt < b.endedAt ? -1 : 1));
  state = { ...state, cycles };

  // Optional API spend, with one source heading over its budget.
  const spendRandom = seeded(101);
  for (const [label, providerId, budget, scale] of [
    ['OpenAI API', 'openai-api', 60, 2.9],
    ['Claude API', 'anthropic-api', 40, 0.9]
  ] as const) {
    const added = addSpendSource(state, { label, providerId, currency: 'USD', monthlyBudget: budget }, nowMs, { kind: 'demo' });
    const entries: { date: string; amount: number }[] = [];
    for (let back = 44; back >= 0; back -= 1) {
      const day = nowMs - back * DAY;
      const weekend = [0, 6].includes(new Date(day).getDay());
      const amount = Math.round(scale * (weekend ? 0.25 : 0.6 + spendRandom() * 1.1) * 100) / 100;
      entries.push({ date: dateKey(day, 'UTC'), amount });
    }
    state = { ...added.state, spend: added.state.spend.map((source) => (source.id === added.source.id ? { ...source, entries } : source)) };
  }
  return state;
}
