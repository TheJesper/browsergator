// The built-in collectors. Each reads one source that could be verified against the provider's own
// documentation or open-source client; see docs/COLLECTORS.md for what each one reads and how stable it is.

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { instant, numeric, record } from './fetch.js';
import { CollectorError, type CollectedAccount, type CollectedMeter, type Collector, type CollectorContext } from './types.js';

function needEnv(context: Pick<CollectorContext, 'env'>, names: string[]): string | null {
  for (const name of names) {
    const value = context.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

const missing = (names: string[]): string => `Set ${names[0]} to switch this on.`;

// ---------------------------------------------------------------------------
// Codex session logs (local file, no network)
// ---------------------------------------------------------------------------

/** How much of the end of a session log is read. The newest rate-limit snapshot is always near the end. */
const TAIL_BYTES = 512 * 1024;
const MAX_FILES = 8;

function codexHome(context: Pick<CollectorContext, 'env' | 'homeDir'>): string {
  const configured = context.env['CODEX_HOME'];
  return configured && configured.trim() ? configured.trim() : join(context.homeDir, '.codex');
}

async function newestFirst(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort().reverse();
  } catch {
    return [];
  }
}

/** Paths of the most recent rollout files, newest first, walking sessions/YYYY/MM/DD. */
async function recentRollouts(home: string): Promise<string[]> {
  const root = join(home, 'sessions');
  const found: string[] = [];
  for (const year of await newestFirst(root)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await newestFirst(join(root, year))) {
      for (const day of await newestFirst(join(root, year, month))) {
        const dir = join(root, year, month, day);
        for (const file of await newestFirst(dir)) {
          // Older files are recompressed to .zst; only plain logs are read.
          if (file.startsWith('rollout-') && file.endsWith('.jsonl')) found.push(join(dir, file));
          if (found.length >= MAX_FILES) return found;
        }
      }
    }
  }
  return found;
}

async function tail(path: string): Promise<string> {
  const info = await stat(path);
  const handle = await open(path, 'r');
  try {
    const length = Math.min(info.size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface CodexSnapshot {
  at: number;
  windows: { minutes: number; usedPercent: number; resetsAt: string | null }[];
  planType: string | null;
}

/** The newest rate-limit snapshot in a chunk of rollout log, or null. Exported for tests. */
export function parseCodexLog(text: string): CodexSnapshot | null {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (!line.includes('"rate_limits"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of a tail is usually cut in half
    }
    const payload = record(record(entry)?.['payload']);
    if (!payload || payload['type'] !== 'token_count') continue;
    const limits = record(payload['rate_limits']);
    if (!limits) continue;
    const windows: CodexSnapshot['windows'] = [];
    for (const name of ['primary', 'secondary']) {
      const window = record(limits[name]);
      const usedPercent = numeric(window?.['used_percent']);
      const minutes = numeric(window?.['window_minutes']);
      if (!window || usedPercent === null || minutes === null) continue;
      windows.push({ minutes, usedPercent, resetsAt: instant(window['resets_at']) });
    }
    if (windows.length === 0) continue;
    const at = Date.parse(String(record(entry)?.['timestamp'] ?? ''));
    return { at: Number.isFinite(at) ? at : 0, windows, planType: typeof limits['plan_type'] === 'string' ? limits['plan_type'] : null };
  }
  return null;
}

/** Maps a snapshot to meters, dropping windows that have already ended. Exported for tests. */
export function codexMeters(snapshot: CodexSnapshot, nowMs: number): CollectedMeter[] {
  const meters: CollectedMeter[] = [];
  for (const window of snapshot.windows) {
    const ends = window.resetsAt ? Date.parse(window.resetsAt) : null;
    if (ends === null || ends <= nowMs) continue; // a finished window says nothing about the current one
    // "primary" and "secondary" are positional, not fixed: Pro plans have no 5-hour window at all. Windows are
    // told apart by length, the way Codex's own interface does it.
    const [key, label] =
      window.minutes <= 12 * 60
        ? ['session', '5-hour session']
        : window.minutes <= 36 * 60
          ? ['daily', 'Daily limit']
          : window.minutes <= 10 * 24 * 60
            ? ['weekly', 'Weekly limit']
            : ['monthly', 'Monthly allowance'];
    meters.push({
      key,
      label,
      // Codex windows open on first use and run for their length, whatever the plan calls them.
      reset: { kind: 'rolling', hours: window.minutes / 60 },
      role: key === 'session' || key === 'daily' ? 'throttle' : 'allowance',
      reading: { usedPercent: Math.min(100, Math.max(0, window.usedPercent)), resetsAt: window.resetsAt as string }
    });
  }
  return meters;
}

const CODEX_PLANS: Record<string, string> = { plus: 'plus', go: 'go', business: 'business', team: 'business' };

export const codexSessions: Collector = {
  id: 'codex-sessions',
  providerId: 'codex',
  title: 'Codex session logs',
  description:
    'Reads the last rate-limit snapshot Codex wrote to its own session logs in ~/.codex/sessions. Nothing leaves the machine. Only as fresh as your last Codex turn here.',
  sourceKind: 'local-file',
  allowedHosts: [],
  env: [],
  intervalMinutes: 5,
  async available(context) {
    const files = await recentRollouts(codexHome(context));
    return files.length > 0 ? { ok: true } : { ok: false, reason: 'No Codex session logs found in ~/.codex/sessions.' };
  },
  async collect(context) {
    const files = await recentRollouts(codexHome(context));
    if (files.length === 0) throw new CollectorError('No Codex session logs found.', 'unavailable');
    let newest: CodexSnapshot | null = null;
    for (const file of files) {
      const snapshot = parseCodexLog(await tail(file).catch(() => ''));
      if (snapshot && (newest === null || snapshot.at > newest.at)) newest = snapshot;
    }
    if (!newest) return { accounts: [], spend: [], note: 'No rate-limit snapshot in the recent session logs.' };
    const meters = codexMeters(newest, context.nowMs);
    if (meters.length === 0) return { accounts: [], spend: [], note: 'The newest snapshot is from a window that has already ended.' };
    const account: CollectedAccount = { providerId: 'codex', meters };
    const planId = newest.planType ? CODEX_PLANS[newest.planType] : undefined;
    if (planId) account.planId = planId;
    return { accounts: [account], spend: [] };
  }
};

// ---------------------------------------------------------------------------
// ElevenLabs (documented API)
// ---------------------------------------------------------------------------

export const elevenlabs: Collector = {
  id: 'elevenlabs',
  providerId: 'elevenlabs',
  title: 'ElevenLabs subscription',
  description: 'Calls the documented GET /v1/user/subscription for credits used, the monthly quota and the next reset. Needs an API key with the User read permission.',
  sourceKind: 'documented-api',
  allowedHosts: ['api.elevenlabs.io'],
  env: ['ELEVENLABS_API_KEY'],
  intervalMinutes: 30,
  available(context) {
    return Promise.resolve(needEnv(context, this.env) ? { ok: true } : { ok: false, reason: missing(this.env) });
  },
  async collect(context) {
    const key = needEnv(context, this.env);
    if (!key) throw new CollectorError(missing(this.env), 'unavailable');
    const body = record(await context.fetchJson('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } }));
    const used = numeric(body?.['character_count']);
    const limit = numeric(body?.['character_limit']);
    if (!body || used === null || limit === null || limit <= 0) throw new CollectorError('ElevenLabs answered without usage figures.');
    const reading: CollectedMeter['reading'] = { used, limit };
    const resetsAt = instant(body['next_character_count_reset_unix']);
    if (resetsAt && Date.parse(resetsAt) > context.nowMs) reading.resetsAt = resetsAt;
    const account: CollectedAccount = { providerId: 'elevenlabs', meters: [{ key: 'credits', reading }] };
    if (typeof body['tier'] === 'string') account.planId = body['tier'];
    return { accounts: [account], spend: [] };
  }
};

// ---------------------------------------------------------------------------
// OpenRouter (documented API)
// ---------------------------------------------------------------------------

export const openrouter: Collector = {
  id: 'openrouter',
  providerId: 'openrouter',
  title: 'OpenRouter credits',
  description: 'Calls the documented GET /api/v1/credits for credits bought and credits used.',
  sourceKind: 'documented-api',
  allowedHosts: ['openrouter.ai'],
  env: ['OPENROUTER_API_KEY'],
  intervalMinutes: 30,
  available(context) {
    return Promise.resolve(needEnv(context, this.env) ? { ok: true } : { ok: false, reason: missing(this.env) });
  },
  async collect(context) {
    const key = needEnv(context, this.env);
    if (!key) throw new CollectorError(missing(this.env), 'unavailable');
    const body = record(await context.fetchJson('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${key}` } }));
    const data = record(body?.['data']);
    const total = numeric(data?.['total_credits']);
    const used = numeric(data?.['total_usage']);
    if (total === null || used === null) throw new CollectorError('OpenRouter answered without credit figures.');
    if (total <= 0) return { accounts: [], spend: [], note: 'No credits have been bought on this key.' };
    return { accounts: [{ providerId: 'openrouter', meters: [{ key: 'credits', reading: { used, limit: total } }] }], spend: [] };
  }
};

// ---------------------------------------------------------------------------
// OpenAI and Anthropic cost reports (documented admin APIs) -> API spend
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export const openaiCosts: Collector = {
  id: 'openai-costs',
  providerId: 'openai-api',
  title: 'OpenAI API costs',
  description: 'Calls the documented GET /v1/organization/costs for daily spend over the last 31 days. Needs an organisation admin key.',
  sourceKind: 'documented-api',
  allowedHosts: ['api.openai.com'],
  env: ['OPENAI_ADMIN_KEY'],
  intervalMinutes: 60,
  available(context) {
    return Promise.resolve(needEnv(context, this.env) ? { ok: true } : { ok: false, reason: missing(this.env) });
  },
  async collect(context) {
    const key = needEnv(context, this.env);
    if (!key) throw new CollectorError(missing(this.env), 'unavailable');
    const start = Math.floor((context.nowMs - 31 * DAY_MS) / 1000);
    const days = new Map<string, number>();
    let page: string | null = null;
    for (let guard = 0; guard < 4; guard += 1) {
      const url: string = `https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d&limit=31${page ? `&page=${encodeURIComponent(page)}` : ''}`;
      const body = record(await context.fetchJson(url, { headers: { Authorization: `Bearer ${key}` } }));
      const buckets = Array.isArray(body?.['data']) ? (body['data'] as unknown[]) : [];
      for (const raw of buckets) {
        const bucket = record(raw);
        const startTime = numeric(bucket?.['start_time']);
        if (!bucket || startTime === null) continue;
        const date = new Date(startTime * 1000).toISOString().slice(0, 10);
        let total = days.get(date) ?? 0;
        for (const result of Array.isArray(bucket['results']) ? (bucket['results'] as unknown[]) : []) {
          total += numeric(record(record(result)?.['amount'])?.['value']) ?? 0;
        }
        days.set(date, total);
      }
      page = body?.['has_more'] === true && typeof body['next_page'] === 'string' ? body['next_page'] : null;
      if (!page) break;
    }
    return { accounts: [], spend: [{ providerId: 'openai-api', label: 'OpenAI API', currency: 'USD', days: [...days].map(([date, amount]) => ({ date, amount: Math.round(amount * 100) / 100 })) }] };
  }
};

export const anthropicCosts: Collector = {
  id: 'anthropic-costs',
  providerId: 'anthropic-api',
  title: 'Claude API costs',
  description: 'Calls the documented GET /v1/organizations/cost_report for daily spend over the last 31 days. Needs an organisation admin key. Reports up to the last UTC midnight.',
  sourceKind: 'documented-api',
  allowedHosts: ['api.anthropic.com'],
  env: ['ANTHROPIC_ADMIN_KEY'],
  intervalMinutes: 60,
  available(context) {
    return Promise.resolve(needEnv(context, this.env) ? { ok: true } : { ok: false, reason: missing(this.env) });
  },
  async collect(context) {
    const key = needEnv(context, this.env);
    if (!key) throw new CollectorError(missing(this.env), 'unavailable');
    const startingAt = new Date(Math.floor((context.nowMs - 30 * DAY_MS) / DAY_MS) * DAY_MS).toISOString();
    const days = new Map<string, number>();
    let page: string | null = null;
    for (let guard = 0; guard < 4; guard += 1) {
      const url: string = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(startingAt)}&limit=31${page ? `&page=${encodeURIComponent(page)}` : ''}`;
      const body = record(await context.fetchJson(url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }));
      const buckets = Array.isArray(body?.['data']) ? (body['data'] as unknown[]) : [];
      for (const raw of buckets) {
        const bucket = record(raw);
        const date = typeof bucket?.['starting_at'] === 'string' ? bucket['starting_at'].slice(0, 10) : null;
        if (!bucket || !date) continue;
        let cents = 0;
        // Amounts are decimal strings in the lowest currency unit: "123.45" is 1.2345 dollars.
        for (const result of Array.isArray(bucket['results']) ? (bucket['results'] as unknown[]) : []) cents += numeric(record(result)?.['amount']) ?? 0;
        days.set(date, (days.get(date) ?? 0) + cents / 100);
      }
      page = body?.['has_more'] === true && typeof body['next_page'] === 'string' ? body['next_page'] : null;
      if (!page) break;
    }
    return { accounts: [], spend: [{ providerId: 'anthropic-api', label: 'Claude API', currency: 'USD', days: [...days].map(([date, amount]) => ({ date, amount: Math.round(amount * 100) / 100 })) }] };
  }
};

// ---------------------------------------------------------------------------
// GitHub Copilot (undocumented endpoint used by the editors)
// ---------------------------------------------------------------------------

const COPILOT_PLANS: Record<string, string> = { individual: 'pro', individual_pro: 'pro-plus', individual_max: 'max', business: 'business', enterprise: 'enterprise' };

/** Reads the allowance snapshot from a copilot_internal/user answer. Exported for tests. */
export function parseCopilot(body: unknown, nowMs: number): CollectedAccount | null {
  const root = record(body);
  const snapshots = record(root?.['quota_snapshots']);
  const snapshot = record(snapshots?.['premium_interactions']) ?? record(snapshots?.['premium_models']);
  if (!root || !snapshot || snapshot['unlimited'] === true) return null;
  // `entitlement` is a string in current clients and a number in older ones.
  const limit = numeric(snapshot['entitlement']);
  const remaining = numeric(snapshot['quota_remaining']) ?? numeric(snapshot['remaining']);
  const percentRemaining = numeric(snapshot['percent_remaining']);
  const reading: CollectedMeter['reading'] = {};
  if (limit !== null && limit > 0 && remaining !== null) {
    reading.limit = limit;
    reading.remaining = Math.max(0, remaining);
  } else if (percentRemaining !== null) reading.remainingPercent = Math.min(100, Math.max(0, percentRemaining));
  else return null;
  const resetsAt = instant(snapshot['quota_reset_at']) ?? instant(root['quota_reset_date_utc']) ?? instant(root['quota_reset_date']);
  if (resetsAt && Date.parse(resetsAt) > nowMs) reading.resetsAt = resetsAt;
  const tokenBilling = root['token_based_billing'] === true || snapshot['token_based_billing'] === true;
  const account: CollectedAccount = { providerId: 'copilot', meters: [{ key: tokenBilling ? 'ai-credits' : 'premium-requests', reading }] };
  const plan = typeof root['copilot_plan'] === 'string' ? COPILOT_PLANS[root['copilot_plan']] : undefined;
  if (plan) account.planId = tokenBilling ? plan : plan === 'pro' ? 'legacy-pro' : plan === 'pro-plus' ? 'legacy-pro-plus' : plan;
  return account;
}

export const copilot: Collector = {
  id: 'copilot',
  providerId: 'copilot',
  title: 'GitHub Copilot allowance',
  description:
    'Calls api.github.com/copilot_internal/user, the endpoint the editors use for the monthly allowance. It is undocumented and may change or stop working. Needs a GitHub token that has Copilot access.',
  sourceKind: 'undocumented-api',
  allowedHosts: ['api.github.com'],
  env: ['TOKENGATOR_GITHUB_TOKEN'],
  intervalMinutes: 30,
  available(context) {
    return Promise.resolve(needEnv(context, this.env) ? { ok: true } : { ok: false, reason: missing(this.env) });
  },
  async collect(context) {
    const token = needEnv(context, this.env);
    if (!token) throw new CollectorError(missing(this.env), 'unavailable');
    const body = await context.fetchJson('https://api.github.com/copilot_internal/user', {
      headers: { Authorization: `token ${token}`, 'X-GitHub-Api-Version': '2025-04-01', 'User-Agent': 'tokengator' }
    });
    const account = parseCopilot(body, context.nowMs);
    if (!account) return { accounts: [], spend: [], note: 'No metered Copilot allowance on this account (unlimited or not reported).' };
    return { accounts: [account], spend: [] };
  }
};

export const BUILT_IN_COLLECTORS: readonly Collector[] = [codexSessions, elevenlabs, openrouter, openaiCosts, anthropicCosts, copilot];
