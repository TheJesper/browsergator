// The MCP server (design D10): the tools, resources and prompt agents use to read the quota picture a
// person sees and to keep it current. Both transports build the same server from the same application
// service, so an agent on stdio and one on HTTP are told the same thing and write to the same state.
//
// Nothing in here spends quota or starts work. Tools read Tokengator's records or change them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable, Writable } from 'node:stream';

import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import {
  CLIENT_INFO_META_KEY,
  McpServer,
  createMcpHandler,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isLegacyRequest,
  serializeMessage,
  type CallToolResult,
  type JSONRPCMessage,
  type ServerContext,
  type ToolAnnotations,
  type Transport,
  type TransportSendOptions
} from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import {
  updateAccount,
  updateMeter,
  validateResetRule,
  type AccountInput,
  type AccountPatch,
  type MeterInput,
  type MeterPatch
} from '../core/accounts.js';
import { costsMarkdown, meterMarkdown, meterRecord, queueText, snapshot, stamp, type MeterRecord } from '../core/brief.js';
import { CATALOG, CATALOG_CHECKED } from '../core/catalog.js';
import { findProvider, type PresetMeter, type ProviderPreset } from '../core/catalog-types.js';
import { cyclesOf, ledgerTotals, viewAccount, type MeterView, type Money } from '../core/forecast.js';
import { formatAmount, formatMoney, formatMoneyTotals, formatPercent } from '../core/format.js';
import { addSpendSource, recordSpend, summariseSpend } from '../core/spend.js';
import { DAY, HOUR, MINUTE, dateKey, iso, toMs } from '../core/time.js';
import type { Account, ClosedCycle, Meter, MeterSource, Price, Reading, ResetRule, SpendSource, State, Unit } from '../core/types.js';
import { explain, headline, moneyPair, statusLine } from '../core/wording.js';
import { CollectorError, type CollectorHost, type CollectorStatus } from './collectors/types.js';
import { MAX_BODY_BYTES, VERSION } from './config.js';
import { log, redact } from './logger.js';
import { AmbiguousTargetError, NotFoundError, ReadingError, ValidationError, type TokengatorService } from './service.js';
import { LockTimeoutError } from './store.js';

export interface McpDeps {
  service: TokengatorService;
  collectors?: CollectorHost;
  version?: string;
}

const INSTRUCTIONS = [
  'Tokengator tracks prepaid AI subscription quota that expires unused at each reset.',
  'Call what_to_use before substantial work to see which subscription has quota at risk, and prefer that one when it suits the task.',
  'When you learn a fresher number (a usage page, a rate-limit message), record it with report_usage or quick_update; list_catalog says where each provider shows its usage and what to read there.',
  'These tools only read and update the records. They never spend quota, and you must not start work just to use quota up unless the user asked for it.',
  'You have no clock: every result says when it was computed and in which time zone.'
].join(' ');

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

const READS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds a record (a reading, an account, a day's spend). Repeating the call records again, as of a later time. */
const RECORDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Overwrites stored settings, and a relative snooze or a corrected amount lands differently each time. */
const OVERWRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Deletes. Removing what is already gone changes nothing further. */
const DELETES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
/** Collectors read local files and call provider APIs, and store what they find. */
const COLLECTS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// ---------------------------------------------------------------------------
// Input schemas
//
// Objects are strict: a misspelt argument is answered with its name instead of being dropped, which would
// let a tool report success for a change it never made. The only unions are "or null" on fields that can
// be cleared; a reset rule is one flat object, because several model providers reject richer unions in
// tool parameters. The core checks which of its fields a given kind needs.
// ---------------------------------------------------------------------------

const PERCENT_RANGE = 'must be a percentage from 0 to 100';
const UNIT_IDS = ['percent', 'requests', 'credits', 'tokens', 'characters', 'minutes', 'hours', 'images', 'usd', 'count'] as const satisfies readonly Unit[];
const RESET_KINDS = ['rolling', 'interval', 'daily', 'monthly', 'once', 'none'] as const satisfies readonly ResetRule['kind'][];

const accountArg = z
  .string()
  .min(1)
  .max(120)
  .describe('Which account: its id, label or provider, or any words that pick out exactly one ("claude", "claude-max", "suno pro").');

const meterArg = z
  .string()
  .min(1)
  .max(120)
  .describe('Which meter of the account: its key, label or id, or unambiguous words from them ("weekly", "session").');

const instantArg = (subject: string): z.ZodString =>
  z
    .string()
    .max(40)
    .describe(`${subject}: an ISO 8601 instant with a time zone, such as 2026-11-21T09:00:00Z or 2026-11-21T10:00:00+01:00.`);

const priceArg = z
  .strictObject({
    amount: z.number().min(0, 'must be 0 or more').describe('What one period costs. 0 means no price.'),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, 'must be a three-letter currency code such as USD')
      .describe('ISO 4217 code, for example USD or EUR. Amounts are never converted.'),
    period: z.enum(['month', 'year'])
  })
  .describe('What the plan costs. It turns unused quota into money at risk.');

const resetArg = z
  .strictObject({
    kind: z
      .enum(RESET_KINDS)
      .describe(
        'rolling: opens on first use and lasts `hours`. interval: a fixed cadence of `hours` (a weekly cap is 168). daily, monthly: a wall-clock boundary. once: a single expiry date. none: a balance without a clock.'
      ),
    hours: z
      .number()
      .min(1 / 60)
      .max(24 * 366)
      .optional()
      .describe('rolling and interval: window length in hours, from one minute to 366 days.'),
    day: z.number().int().min(1).max(31).optional().describe('monthly: day of the month, clamped to the month length.'),
    time: z.string().max(5).optional().describe('daily and monthly: HH:MM on a 24-hour clock. Default 00:00.'),
    tz: z.string().max(64).optional().describe('daily and monthly: IANA time zone such as Europe/Stockholm. Default UTC.')
  })
  .describe('How the window renews.');

const customMeterArg = z.strictObject({
  label: z.string().min(1).max(60).describe('Name as the provider shows it, for example "Weekly limit" or "Monthly credits".'),
  key: z.string().max(40).optional().describe('Stable machine key. Derived from the label when omitted.'),
  role: z
    .enum(['allowance', 'throttle'])
    .optional()
    .describe('allowance (default): prepaid quota that is lost at the reset. throttle: a short rate window; nothing of value expires with it.'),
  unit: z.enum(UNIT_IDS).optional().describe('What the meter counts. Default percent, for providers that only show a percentage.'),
  unitLabel: z.string().max(24).optional().describe('Plural noun shown instead of the unit name, for example "songs".'),
  limit: z.number().positive().optional().describe("Size of one window's allowance. Required unless the unit is percent."),
  used: z.number().min(0).optional().describe('Amount already used in the current window, when known.'),
  reset: resetArg,
  resetsAt: instantArg('When the current window ends').optional(),
  rollover: z.enum(['none', 'carries']).optional().describe('carries: unused quota is kept at the reset, so it is never counted as waste.'),
  valueShare: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Share of the plan price this meter stands for. Default 1 for the account's first allowance and 0 for the others, so overlapping limits are not counted twice.")
});

const whatToUseInput = z.strictObject({
  limit: z.number().int().min(1).max(50).default(10).describe('How many meters to return, most urgent first. 1 to 50, default 10.'),
  includeSettled: z
    .boolean()
    .default(false)
    .describe('Also include meters with nothing left to decide in the structured queue: used up, expired, or a balance without a reset. Default false.')
});

const providerFilterInput = (what: string): z.ZodOptional<z.ZodString> => z.string().min(1).max(60).optional().describe(what);

const reportUsageInput = z.strictObject({
  account: accountArg,
  meter: meterArg.optional().describe("Which meter: its key, label or id. Omit for the account's main allowance."),
  used: z.number().min(0, 'must be 0 or more').optional().describe("Amount used in the current window, in the meter's unit."),
  remaining: z.number().min(0, 'must be 0 or more').optional().describe("Amount left in the current window, in the meter's unit."),
  usedPercent: z.number().min(0, PERCENT_RANGE).max(100, PERCENT_RANGE).optional().describe('Share of the limit used, 0 to 100.'),
  remainingPercent: z.number().min(0, PERCENT_RANGE).max(100, PERCENT_RANGE).optional().describe('Share of the limit left, 0 to 100.'),
  limit: z.number().positive().optional().describe('The size of the allowance, when the page shows one that differs from the stored limit.'),
  resetsAt: instantArg('When the current window resets').optional(),
  resetsInMinutes: z
    .number()
    .positive()
    .max(366 * 24 * 60)
    .optional()
    .describe('Minutes until the reset, for pages that show a countdown. Use this or resetsAt, not both.'),
  note: z.string().max(200).optional().describe('Where the numbers came from, for example "usage page".')
});

const quickUpdateInput = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(500)
    .describe('One line: account, optional meter, amount, optional reset. "claude weekly 62%", "suno 1200 left resets in 9d", "copilot 120/300 resets dec 1".')
});

const addAccountInput = z.strictObject({
  provider: z.string().min(1).max(60).optional().describe('Catalog provider id or name from list_catalog. Use this or custom, not both.'),
  plan: z.string().min(1).max(60).optional().describe("With provider: the plan's id or name (the provider's first plan when omitted). With custom: a plan name to show."),
  label: z.string().min(1).max(60).optional().describe('Name to show. Overrides the preset name or custom.label.'),
  price: priceArg.nullable().optional().describe('Overrides the preset price, or prices a custom account. null means no price.'),
  billingDay: z
    .number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe('With provider: the day of the month the subscription renews, for plans whose quota resets on the billing date. The first reported reset time corrects it either way.'),
  custom: z
    .strictObject({
      label: z.string().min(1).max(60).describe('Name of the subscription.'),
      usageUrl: z.string().max(500).optional().describe('Address of the page where a signed-in person reads current usage.'),
      notes: z.string().max(2000).optional(),
      meters: z.array(customMeterArg).min(1).max(12).describe('One entry per quota or rate limit of the subscription.')
    })
    .optional()
    .describe('A subscription the catalog does not have. Use this or provider, not both.')
});

const updateAccountInput = z.strictObject({
  account: accountArg,
  label: z.string().min(1).max(60).optional(),
  plan: z.string().max(60).nullable().optional().describe('Plan name to show. null clears it.'),
  price: priceArg.nullable().optional().describe('null clears the price.'),
  usageUrl: z.string().max(500).nullable().optional().describe('Address of the usage page, starting with http:// or https://. null clears it.'),
  notes: z.string().max(2000).nullable().optional().describe('Free text kept with the account. null clears it.'),
  snoozeHours: z
    .number()
    .positive()
    .max(8760)
    .nullable()
    .optional()
    .describe('Hide the account from the "use first" queue and from alerts for this many hours. null wakes it up.'),
  meter: meterArg.optional().describe('The meter meterPatch applies to. May be omitted when the account has exactly one meter.'),
  meterPatch: z
    .strictObject({
      label: z.string().min(1).max(60).optional(),
      limit: z.number().positive().optional().describe("Size of one window's allowance. Ignored for percent meters."),
      used: z.number().min(0).optional().describe('Corrects the stored amount. To record a fresh reading use report_usage instead.'),
      resetsAt: instantArg('When the current window ends').nullable().optional(),
      reset: resetArg.optional(),
      rollover: z.enum(['none', 'carries']).optional(),
      valueShare: z.number().min(0).max(1).optional()
    })
    .optional()
    .describe('Settings to change on one meter.')
});

const removeAccountInput = z.strictObject({
  account: accountArg,
  confirm: z.boolean().optional().describe('Must be true to remove. Without it the call only describes what would be removed.')
});

const refreshUsageInput = z.strictObject({
  collectors: z.array(z.string().min(1).max(60)).max(50).optional().describe('Collector ids to run. Omit to run every enabled collector.')
});

const wasteReportInput = z.strictObject({
  days: z.number().int().min(1).max(365).default(30).describe('How far back to look. 1 to 365, default 30.')
});

const recordSpendInput = z.strictObject({
  source: z.string().min(1).max(60).describe('Spend source id, label or provider, or part of the label when that is unambiguous.'),
  amount: z.number().min(0, 'must be 0 or more').describe("Money spent that day, in the source's currency."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must look like 2026-11-19')
    .optional()
    .describe("Calendar day as YYYY-MM-DD. Default: today in the user's time zone."),
  mode: z.enum(['set', 'add']).optional().describe("set (default) replaces the day's total, add adds to it."),
  create: z
    .strictObject({
      label: z.string().min(1).max(60),
      currency: z
        .string()
        .regex(/^[A-Za-z]{3}$/, 'must be a three-letter currency code such as USD')
        .optional()
        .describe('Default USD.'),
      monthlyBudget: z.number().min(0).optional().describe('Budget per calendar month. Omit for none.')
    })
    .optional()
    .describe('Creates the spend source first when nothing matches `source`.')
});

// ---------------------------------------------------------------------------
// Output schemas
//
// Loose on purpose: they state the fields a client can rely on, and a field added later must not make a
// client that validates results reject them.
// ---------------------------------------------------------------------------

const text = z.string();
const maybeText = z.string().nullable();
const maybeNumber = z.number().nullable();
const moneyOut = z.record(z.string(), z.number());

const meterRecordShape = {
  id: text,
  account: text,
  accountId: text,
  provider: text,
  plan: maybeText,
  meter: text,
  key: text,
  role: z.enum(['allowance', 'throttle']),
  state: text,
  tier: maybeText,
  unit: text,
  limit: z.number(),
  used: z.number(),
  remaining: z.number(),
  usedPercent: z.number(),
  remainingPercent: z.number(),
  resetsAt: maybeText,
  resetsInMinutes: maybeNumber,
  windowHours: maybeNumber,
  projectedUnusedPercent: maybeNumber,
  valueAtRisk: maybeNumber,
  currency: maybeText,
  valueBasis: z.enum(['plan', 'credit']).nullable(),
  requiredPaceMultiple: maybeNumber,
  blockedBy: maybeText,
  blockedUntil: maybeText,
  stale: z.boolean(),
  updatedAt: maybeText,
  source: text,
  estimated: z.boolean(),
  snoozed: z.boolean(),
  headline: text,
  recommendation: text
} satisfies Record<keyof MeterRecord, z.ZodType>;

// A compile-time proof that the published schema and the core record agree field for field, so a change
// to MeterRecord cannot ship with a stale schema.
type Inferred<Shape extends Record<string, z.ZodType>> = { [Key in keyof Shape]: z.infer<Shape[Key]> };
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const meterRecordSchemaMatchesCore: SameType<Inferred<typeof meterRecordShape>, MeterRecord> = true;
void meterRecordSchemaMatchesCore;

const meterRecordOut = z.looseObject(meterRecordShape);
const priceOut = z.looseObject({ amount: z.number(), currency: text, period: z.enum(['month', 'year']) }).nullable();
const accountOut = z.looseObject({
  id: text,
  label: text,
  provider: text,
  plan: maybeText,
  price: priceOut,
  usageUrl: maybeText,
  notes: maybeText,
  snoozedUntil: maybeText
});

const whatToUseOutput = z.looseObject({
  generatedAt: text,
  timeZone: text,
  summary: z.looseObject({
    line: text,
    useNow: z.number(),
    behind: z.number(),
    hot: z.number(),
    stale: z.number(),
    atRisk: moneyOut,
    creditsAtRisk: moneyOut,
    lost30: moneyOut,
    creditsLost30: moneyOut,
    utilisation30Percent: maybeNumber,
    nextReset: z.looseObject({ meter: text, account: text, resetsAt: text }).nullable()
  }),
  queue: z.array(meterRecordOut),
  throttles: z.array(meterRecordOut),
  omitted: z.looseObject({ settled: z.number(), beyondLimit: z.number() })
});

const listAccountsOutput = z.looseObject({
  generatedAt: text,
  timeZone: text,
  accounts: z.array(accountOut.extend({ meters: z.array(meterRecordOut) }))
});

const getAccountOutput = z.looseObject({
  generatedAt: text,
  timeZone: text,
  account: accountOut,
  meters: z.array(
    meterRecordOut.extend({
      explanation: text,
      samples: z.array(z.looseObject({ t: text, used: z.number() })),
      cycles: z.array(z.looseObject({ endedAt: text, usedPercent: z.number(), unusedPercent: z.number() }))
    })
  )
});

const listCatalogOutput = z.looseObject({
  checked: text,
  known: z.array(text),
  providers: z.array(
    z.looseObject({
      id: text,
      name: text,
      category: text,
      usageUrl: text,
      collectors: z.array(text),
      plans: z.array(z.looseObject({ id: text, name: text, price: priceOut }))
    })
  )
});

const meterResultOutput = z.looseObject({ accountId: text, meterId: text, meter: meterRecordOut, explanation: text });
const accountResultOutput = z.looseObject({ account: accountOut, meters: z.array(meterRecordOut) });

const removeAccountOutput = z.looseObject({
  removed: z.boolean(),
  confirmationRequired: z.boolean(),
  account: z.looseObject({ id: text, label: text }),
  meters: z.array(z.looseObject({ id: text, key: text, label: text }))
});

const refreshUsageOutput = z.looseObject({
  available: z.boolean(),
  collectors: z.array(
    z.looseObject({
      id: text,
      ran: z.boolean(),
      outcome: maybeText,
      message: maybeText,
      updatedMeters: z.array(text)
    })
  )
});

const wasteReportOutput = z.looseObject({
  generatedAt: text,
  days: z.number(),
  windows: z.number(),
  utilisationPercent: maybeNumber,
  lost: moneyOut,
  creditsLost: moneyOut,
  lostIsEstimate: z.boolean(),
  meters: z.array(
    z.looseObject({
      meterId: text,
      account: text,
      meter: text,
      windows: z.number(),
      averageUnusedPercent: z.number(),
      lost: moneyOut,
      valueBasis: z.enum(['plan', 'credit']).nullable()
    })
  )
});

const spendSourceOut = z.looseObject({
  id: text,
  label: text,
  currency: text,
  monthlyBudget: maybeNumber,
  monthToDate: z.number(),
  projected: z.number(),
  overBudget: z.boolean(),
  headingOver: z.boolean()
});

const recordSpendOutput = z.looseObject({
  created: z.boolean(),
  entry: z.looseObject({ date: text, amount: z.number(), mode: z.enum(['set', 'add']) }),
  dayTotal: z.number(),
  source: spendSourceOut
});

const getCostsOutput = z.looseObject({
  generatedAt: text,
  timeZone: text,
  monthToDate: moneyOut,
  sources: z.array(spendSourceOut)
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const roundMoney = (totals: Money): Money => Object.fromEntries(Object.entries(totals).map(([currency, amount]) => [currency, round(amount, 2)]));

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|');

/** Splits a name the way quick entry does, so "weekly", "Weekly limit" and "weekly-limit" all match. */
const nameWords = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * A time given by an agent. Stricter than the core: a string without a zone would be read in this
 * machine's zone, and an agent that copied "9:00" from a web page cannot know which zone that is.
 */
function parseInstant(field: string, value: string): string {
  const ms = ISO_INSTANT.test(value.trim()) ? toMs(value.trim()) : null;
  if (ms === null) {
    throw new ValidationError(
      field,
      `${field} must be an ISO 8601 instant with a time zone, for example 2026-11-21T09:00:00Z or 2026-11-21T10:00:00+01:00.`
    );
  }
  return iso(ms);
}

function priceText(price: Price | null): string {
  return price ? `${formatMoney(price.amount, price.currency)} a ${price.period}` : 'no price';
}

function resetText(rule: ResetRule, anchor?: PresetMeter['anchor']): string {
  switch (rule.kind) {
    case 'rolling':
      return `opens on first use, lasts ${rule.hours}h`;
    case 'interval':
      return anchor === 'billing' ? 'renews monthly on the billing day' : `resets every ${rule.hours}h`;
    case 'daily':
      return `resets daily at ${rule.time} ${rule.tz}`;
    case 'monthly':
      return `resets monthly on day ${rule.day} at ${rule.time} ${rule.tz}`;
    case 'once':
      return 'expires once';
    default:
      return 'no reset';
  }
}

function accountSummary(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    label: account.label,
    provider: account.providerId,
    plan: account.plan,
    price: account.price,
    usageUrl: account.usageUrl,
    notes: account.notes,
    snoozedUntil: account.snoozedUntil,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function cycleSummary(cycle: ClosedCycle): Record<string, unknown> {
  return {
    startedAt: cycle.startedAt,
    endedAt: cycle.endedAt,
    unit: cycle.unit,
    limit: cycle.limit,
    used: round(cycle.used, 2),
    usedPercent: round((1 - cycle.wastedFraction) * 100),
    unusedPercent: round(cycle.wastedFraction * 100),
    lostValue: cycle.wastedValue === null ? null : round(cycle.wastedValue, 2),
    currency: cycle.currency,
    confidence: cycle.confidence
  };
}

function presetCompact(provider: ProviderPreset): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    vendor: provider.vendor,
    category: provider.category,
    usageUrl: provider.usageUrl,
    collectors: provider.collectors,
    plans: provider.plans.map((plan) => ({ id: plan.id, name: plan.name, price: plan.price }))
  };
}

function presetDetail(provider: ProviderPreset): Record<string, unknown> {
  return {
    ...presetCompact(provider),
    howToRead: provider.howToRead,
    uses: provider.uses ?? [],
    plans: provider.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      price: plan.price,
      note: plan.note ?? null,
      meters: plan.meters.map((meter) => ({
        key: meter.key,
        label: meter.label,
        role: meter.role,
        unit: meter.unit,
        unitLabel: meter.unitLabel ?? null,
        limit: meter.limit ?? (meter.unit === 'percent' ? 100 : null),
        reset: meter.reset,
        renewsOnBillingDay: meter.anchor === 'billing',
        rollover: meter.rollover ?? 'none'
      }))
    }))
  };
}

function spendSummary(source: SpendSource, nowMs: number, tz: string): Record<string, unknown> {
  const summary = summariseSpend(source, nowMs, tz);
  return {
    id: source.id,
    label: source.label,
    provider: source.providerId,
    currency: source.currency,
    monthlyBudget: source.monthlyBudget,
    monthToDate: round(summary.monthToDate, 2),
    dailyAverage: round(summary.dailyAverage, 2),
    projected: round(summary.projected, 2),
    previousMonth: round(summary.previousMonth, 2),
    budgetPercent: summary.budgetFraction === null ? null : round(summary.budgetFraction * 100),
    overBudget: summary.overBudget,
    headingOver: summary.headingOver,
    updatedAt: source.updatedAt,
    reportedBy: source.source.id ? `${source.source.kind}:${source.source.id}` : source.source.kind,
    // Days without spend are left out: thirty zeroes per source say nothing.
    recentDays: summary.series.filter((day) => day.amount > 0)
  };
}

function collectorSummary(status: CollectorStatus, ran: boolean): Record<string, unknown> {
  return {
    id: status.id,
    provider: status.providerId,
    title: status.title,
    sourceKind: status.sourceKind,
    enabled: status.enabled,
    available: status.available,
    ran,
    outcome: ran ? status.lastOutcome : null,
    // Collectors keep credentials out of their messages; this is the second line of defence.
    message: redact(status.lastMessage ?? status.reason ?? '').trim() || null,
    updatedMeters: ran && status.lastOutcome === 'ok' ? status.lastUpdated : [],
    lastRunAt: status.lastRunAt,
    nextRunAt: status.nextRunAt
  };
}

const OUTCOME_TEXT: Record<NonNullable<CollectorStatus['lastOutcome']>, string> = {
  ok: 'ok',
  auth: 'the credential was rejected',
  unavailable: 'nothing to read',
  failed: 'failed'
};

/** A message from the collector layer as one sentence, with anything key-shaped removed. */
function sentence(message: string | null): string {
  const cleaned = message === null ? '' : redact(message).trim();
  if (!cleaned) return '';
  return /[.!?]$/.test(cleaned) ? ` ${cleaned}` : ` ${cleaned}.`;
}

function collectorLine(status: CollectorStatus, ran: boolean): string {
  const name = `${status.id} (${status.title})`;
  if (!ran) return `- ${name}: not run, ${status.enabled ? 'no result yet' : 'it is not enabled'}.${sentence(status.reason)}`;
  if (status.lastOutcome === 'ok') {
    const updated = status.lastUpdated;
    const changed =
      updated.length === 0 ? 'nothing changed' : `updated ${updated.length === 1 ? '1 meter' : `${updated.length} meters`}: ${updated.join(', ')}`;
    return `- ${name}: ok, ${changed}.${sentence(status.lastMessage)}`;
  }
  const outcome = status.lastOutcome === null ? 'no result' : OUTCOME_TEXT[status.lastOutcome];
  return `- ${name}: ${outcome}.${sentence(status.lastMessage ?? status.reason)}`;
}

/** Plain JSON, detached from the service's own objects: an in-memory transport passes references. */
function plain(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function done(lines: string | string[], structured: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: Array.isArray(lines) ? lines.join('\n') : lines }],
    structuredContent: plain(structured)
  };
}

/** A name supplied by the other end of the connection, made safe to store and to print. */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function createMcpServer(deps: McpDeps): McpServer {
  const { service } = deps;
  const tz = service.timeZone;
  const server = new McpServer(
    { name: 'tokengator', title: 'Tokengator', version: deps.version ?? VERSION },
    { instructions: INSTRUCTIONS }
  );

  /** Agents have no clock, so every text says when it was written. */
  const asOf = (nowMs: number): string => `As of ${stamp(nowMs, tz)}.`;

  const read = async (): Promise<{ state: State; now: number }> => {
    const state = await service.state();
    return { state, now: service.nowMs() };
  };

  /**
   * Who is reporting. A client of the 2026-07-28 revision names itself in every request; an older one
   * does so once, in the handshake, which a stateless HTTP exchange never sees again.
   */
  const agentSource = (ctx: ServerContext, note?: string): MeterSource => {
    // The SDK publishes the envelope as an open record, so the key is read as one.
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const sent = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined;
    const source: MeterSource = { kind: 'agent', id: cleanName(sent?.name) ?? cleanName(server.server.getClientVersion()?.name) ?? 'mcp' };
    const cleaned = note?.trim();
    if (cleaned) source.note = cleaned.slice(0, 200);
    return source;
  };

  /**
   * Turns a failure into a result a model can read, and says truthfully what it left behind. A single
   * change is atomic, and the two-step tools rehearse on a copy first, so "partly" is only ever a failure
   * of the moment between two saves (a lock held by another process, say).
   */
  const failure = (error: unknown, effect: 'read' | 'nothing' | 'partly'): CallToolResult => {
    const unchanged =
      effect === 'nothing'
        ? ' Nothing was changed.'
        : effect === 'partly'
          ? ' Part of the change had already been saved: look at the current state before trying again.'
          : '';
    let message: string;
    if (error instanceof AmbiguousTargetError) {
      const lines = [`${error.message}${unchanged}`];
      if (error.candidates.length > 0) {
        lines.push('Candidates (name one by its id):');
        for (const candidate of error.candidates) {
          lines.push(
            candidate.meterId
              ? `- ${candidate.label} (account id: ${candidate.accountId}, meter id: ${candidate.meterId})`
              : `- ${candidate.label} (account id: ${candidate.accountId})`
          );
        }
      } else if (/^No account matches/.test(error.message)) {
        lines.push('No accounts are tracked yet. Add one with add_account.');
      }
      message = lines.join('\n');
    } else if (error instanceof ValidationError || error instanceof ReadingError) {
      // A reset time is judged against a clock the agent cannot see.
      const clock = /resetsAt$/.test(error.field) ? ` It is now ${stamp(service.nowMs(), tz)}.` : '';
      message = `Invalid input (${error.field}): ${error.message}${clock}${unchanged}`;
    } else if (error instanceof NotFoundError) {
      message = `${error.message}${unchanged}`;
    } else if (error instanceof CollectorError) {
      // Written for the user by the collector layer: it names what is missing, never a value. A run that
      // stopped half way may have stored readings already, so no claim is made about that.
      message = redact(error.message);
    } else if (error instanceof LockTimeoutError) {
      message = `Another Tokengator process is writing the state. Try again in a moment.${unchanged}`;
    } else {
      // The real message may quote paths or upstream text; it goes to the log, not to the model.
      log('error', 'MCP tool failed', { error: error instanceof Error ? error.message : String(error) });
      message = `Something went wrong inside Tokengator. The service log has the details.${effect === 'partly' ? unchanged : ''}`;
    }
    return { content: [{ type: 'text', text: message }], isError: true };
  };

  const reading = async (run: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await run();
    } catch (error) {
      return failure(error, 'read');
    }
  };

  /** `saved` is for tools that save twice: called after the first save, it keeps a later failure honest. */
  const writing = async (run: (saved: () => void) => Promise<CallToolResult>): Promise<CallToolResult> => {
    let partly = false;
    try {
      return await run(() => {
        partly = true;
      });
    } catch (error) {
      return failure(error, partly ? 'partly' : 'nothing');
    }
  };

  const resolveAccount = (state: State, name: string): Account => service.resolve(state, { account: name }).account;

  /**
   * Finds a meter inside an account that is already known. Done here rather than by joining the two names:
   * a meter name that also occurs in the account's label would otherwise resolve to the wrong meter, and
   * a miss has to list this account's meters, not every account.
   */
  const resolveMeter = (account: Account, name: string): Meter => {
    const wanted = name.trim();
    const lower = wanted.toLowerCase();
    const exact =
      account.meters.find((meter) => meter.id === wanted) ??
      account.meters.find((meter) => meter.key === lower) ??
      account.meters.find((meter) => meter.label.toLowerCase() === lower);
    if (exact) return exact;
    const tokens = nameWords(wanted);
    const loose =
      tokens.length === 0
        ? []
        : account.meters.filter((meter) => {
            const words = [...nameWords(meter.label), ...nameWords(meter.key)];
            return tokens.every((token) => words.some((word) => word.startsWith(token)));
          });
    if (loose.length === 1) return loose[0] as Meter;
    const several = loose.length > 1;
    throw new AmbiguousTargetError(
      several
        ? `"${wanted.slice(0, 80)}" matches more than one meter of ${account.label}.`
        : `No meter of ${account.label} matches "${wanted.slice(0, 80)}".`,
      (several ? loose : account.meters).map((meter) => ({
        accountId: account.id,
        meterId: meter.id,
        label: `${account.label}, ${meter.label}`
      }))
    );
  };

  const viewsOf = (account: Account, nowMs: number): MeterView[] => viewAccount(account, nowMs);
  const recordsOf = (account: Account, nowMs: number): MeterRecord[] => viewsOf(account, nowMs).map((view) => meterRecord(view, nowMs, tz));
  const meterLine = (view: MeterView, nowMs: number): string => {
    const freshness = view.ageMs === null ? ' (no reading yet)' : view.stale ? ' (stale)' : '';
    return `- ${view.meter.label} [${view.meter.key}]: ${headline(view, nowMs, tz)}${freshness}`;
  };

  /** The answer of every tool that changed one meter: its new headline, as the shared status line, and the reasoning behind it. */
  const meterResult = (lead: string, outcome: { account: Account; meter: Meter }, extra: Record<string, unknown> = {}): CallToolResult => {
    const now = service.nowMs();
    const view = viewsOf(outcome.account, now).find((candidate) => candidate.id === outcome.meter.id);
    if (!view) throw new NotFoundError(`No meter with id "${outcome.meter.id}".`);
    const explanation = explain(view, now, tz);
    return done([asOf(now), lead, statusLine(view, now, tz), explanation], {
      accountId: outcome.account.id,
      meterId: outcome.meter.id,
      meter: meterRecord(view, now, tz),
      explanation,
      ...extra
    });
  };

  const accountResult = (lead: string, account: Account, tail: string[], extra: Record<string, unknown> = {}): CallToolResult => {
    const now = service.nowMs();
    const views = viewsOf(account, now);
    return done([asOf(now), lead, ...views.map((view) => meterLine(view, now)), ...tail], {
      account: accountSummary(account),
      meters: views.map((view) => meterRecord(view, now, tz)),
      ...extra
    });
  };

  // -- reading -------------------------------------------------------------------

  server.registerTool(
    'what_to_use',
    {
      title: 'What to use first',
      description:
        'Shows which AI subscription to spend first. Returns the tracked allowance meters in "use first" order (quota that resets soon with a lot still left comes first), each with its tier, share left, time to reset, money at risk, the pace needed to finish it, staleness, any rate limit blocking it and a one-sentence recommendation. Call it before starting substantial work, when choosing between subscriptions or tools, or when the user asks what is about to expire. It only reads: it never starts work or spends quota.',
      inputSchema: whatToUseInput,
      outputSchema: whatToUseOutput,
      annotations: READS
    },
    ({ limit, includeSettled }) =>
      reading(async () => {
        const { state, now } = await read();
        const full = snapshot(state, now, tz);
        const open = includeSettled
          ? full.queue
          : full.queue.filter((record) => record.tier !== 'spent' && record.tier !== 'expired' && record.tier !== 'balance');
        const queue = open.slice(0, limit);
        return done(queueText(state, now, tz, limit), {
          ...full,
          queue,
          omitted: { settled: full.queue.length - open.length, beyondLimit: open.length - queue.length }
        });
      })
  );

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Lists every tracked subscription with all of its meters (allowances and rate limits) and their forecasts, plus plan, price and usage-page address. Use it to find account ids and meter keys before report_usage or update_account, or to answer a question about one provider. For the ranked "what should I use" answer call what_to_use instead.',
      inputSchema: z.strictObject({
        provider: providerFilterInput('Only accounts of this provider: a provider id such as "claude", or its name.')
      }),
      outputSchema: listAccountsOutput,
      annotations: READS
    },
    ({ provider }) =>
      reading(async () => {
        const { state, now } = await read();
        const wanted = provider?.trim().toLowerCase();
        const providerId = wanted === undefined ? undefined : (findProvider(CATALOG, wanted)?.id ?? wanted);
        const accounts = providerId === undefined ? state.accounts : state.accounts.filter((account) => account.providerId === providerId);
        const lines = [asOf(now)];
        if (state.accounts.length === 0) {
          lines.push('No subscriptions are tracked yet. Add one with add_account.');
        } else if (accounts.length === 0) {
          const tracked = [...new Set(state.accounts.map((account) => account.providerId))].join(', ');
          lines.push(`No account of provider "${providerId}" is tracked. Tracked providers: ${tracked}.`);
        } else {
          lines.push(accounts.length === 1 ? '1 account.' : `${accounts.length} accounts.`);
        }
        for (const account of accounts) {
          const facts = [`id: ${account.id}`, account.plan ? `plan ${account.plan}` : '', priceText(account.price)].filter(Boolean);
          lines.push('', `${account.label} (${facts.join(', ')})${account.usageUrl ? ` ${account.usageUrl}` : ''}`);
          for (const view of viewsOf(account, now)) lines.push(meterLine(view, now));
        }
        return done(lines, {
          generatedAt: iso(now),
          timeZone: tz,
          accounts: accounts.map((account) => ({ ...accountSummary(account), meters: recordsOf(account, now) }))
        });
      })
  );

  server.registerTool(
    'get_account',
    {
      title: 'Get one account',
      description:
        "Returns one account in full: every meter with its forecast and the reasoning behind it, the readings recorded in the current window, the meter's recently finished windows and the account's notes. Use it to explain a forecast, to check when a number was last updated and by whom, or to look at history before changing anything.",
      inputSchema: z.strictObject({ account: accountArg }),
      outputSchema: getAccountOutput,
      annotations: READS
    },
    ({ account: name }) =>
      reading(async () => {
        const { state, now } = await read();
        const account = resolveAccount(state, name);
        const views = viewsOf(account, now);
        const facts = [`id: ${account.id}`, `provider ${account.providerId}`, account.plan ? `plan ${account.plan}` : '', priceText(account.price)];
        const lines = [asOf(now), `${account.label} (${facts.filter(Boolean).join(', ')})`];
        if (account.usageUrl) lines.push(`Usage page: ${account.usageUrl}`);
        if (account.notes) lines.push(`Notes: ${account.notes}`);
        const snoozedUntil = toMs(account.snoozedUntil);
        if (snoozedUntil !== null && snoozedUntil > now) lines.push(`Snoozed until ${stamp(snoozedUntil, tz)}.`);
        const meters = views.map((view) => {
          const cycles = cyclesOf(state, view.meter.id);
          lines.push('', meterMarkdown(view, now, tz));
          if (cycles.length > 0) {
            const unused = cycles.map((cycle) => formatPercent(cycle.wastedFraction)).join(', ');
            lines.push(`Finished windows on record: ${cycles.length}. Unused at each reset, oldest first: ${unused}.`);
          }
          return {
            ...meterRecord(view, now, tz),
            explanation: explain(view, now, tz),
            reset: view.meter.reset,
            rollover: view.meter.rollover,
            valueShare: view.meter.valueShare,
            reportedNote: view.meter.source.note ?? null,
            samples: view.meter.samples,
            cycles: cycles.map(cycleSummary)
          };
        });
        return done(lines, { generatedAt: iso(now), timeZone: tz, account: accountSummary(account), meters });
      })
  );

  server.registerTool(
    'list_catalog',
    {
      title: 'List provider presets',
      description:
        'Lists the built-in provider presets. Without arguments: a compact list of provider ids, plans and usage-page addresses. With a provider: its plans and meters, the address of its usage page and which figures to read there. Use it before add_account, and before reading a usage page to refresh stale numbers with report_usage.',
      inputSchema: z.strictObject({
        provider: providerFilterInput('Provider id or name. Omit for the compact list of all providers.')
      }),
      outputSchema: listCatalogOutput,
      annotations: READS
    },
    ({ provider }) =>
      reading(async () => {
        const known = CATALOG.map((entry) => entry.id);
        const custom =
          'Anything not listed can be tracked with add_account and a custom definition: a label and one or more meters (label, unit, limit, reset).';
        if (provider !== undefined) {
          const preset = findProvider(CATALOG, provider);
          if (!preset) {
            const listed = known.length > 0 ? `Known providers: ${known.join(', ')}.` : 'The catalog has no presets.';
            return done([`No preset for "${provider.trim().slice(0, 60)}". ${listed}`, custom], { checked: CATALOG_CHECKED, known, providers: [] });
          }
          const lines = [
            `${preset.name} (id: ${preset.id}, ${preset.vendor}, ${preset.category}). Catalog checked ${CATALOG_CHECKED}; limits and prices drift, so trust the usage page over the preset.`,
            `Usage page: ${preset.usageUrl}`,
            `What to read there: ${preset.howToRead}`,
            'Plans:'
          ];
          for (const plan of preset.plans) {
            lines.push(`- ${plan.id} (${plan.name}, ${priceText(plan.price)})${plan.note ? `: ${plan.note}` : ''}`);
            for (const meter of plan.meters) {
              const size = meter.unit === 'percent' || meter.limit === undefined ? 'percent only' : formatAmount(meter, meter.limit);
              lines.push(`  - ${meter.label} [${meter.key}]: ${meter.role}, ${size}, ${resetText(meter.reset, meter.anchor)}`);
            }
          }
          if (preset.collectors.length > 0) lines.push(`Collectors that can fill it automatically: ${preset.collectors.join(', ')}.`);
          if (preset.uses && preset.uses.length > 0) {
            lines.push("Ways the provider documents for using the quota unattended (suggest them; do not start one unasked):");
            for (const use of preset.uses) lines.push(`- ${use.title}: ${use.note} ${use.url}`);
          }
          lines.push(`Track it with add_account (provider "${preset.id}" and a plan id), then record the numbers with report_usage.`);
          return done(lines, { checked: CATALOG_CHECKED, known, providers: [presetDetail(preset)] });
        }
        const lines =
          CATALOG.length === 0
            ? ['The catalog has no presets.']
            : [
                `Provider presets, checked ${CATALOG_CHECKED}. Call list_catalog with a provider id for its plans, its meters and what to read on its usage page.`,
                ...CATALOG.map(
                  (entry) =>
                    `- ${entry.id}: ${entry.name} (${entry.category}); plans ${entry.plans.map((plan) => plan.id).join(', ')}; usage page ${entry.usageUrl}`
                )
              ];
        lines.push(custom);
        return done(lines, { checked: CATALOG_CHECKED, known, providers: CATALOG.map(presetCompact) });
      })
  );

  server.registerTool(
    'waste_report',
    {
      title: 'Waste report',
      description:
        'Reports what actually expired unused: totals over the last N days (finished windows, average utilisation, money lost per currency) and a per-meter breakdown with its recent windows. Use it when the user asks how much quota or money went to waste, or whether they are getting better at using what they pay for.',
      inputSchema: wasteReportInput,
      outputSchema: wasteReportOutput,
      annotations: READS
    },
    ({ days }) =>
      reading(async () => {
        const { state, now } = await read();
        const totals = ledgerTotals(state.cycles, now, days);
        const since = now - days * DAY;
        const inWindow = state.cycles.filter((cycle) => {
          const ended = toMs(cycle.endedAt);
          return ended !== null && ended >= since && ended <= now;
        });
        const windowed: State = { ...state, cycles: inWindow };
        const meters = [...new Set(inWindow.map((cycle) => cycle.meterId))]
          .map((meterId) => {
            const own = inWindow.filter((cycle) => cycle.meterId === meterId);
            const latest = own[own.length - 1] as ClosedCycle;
            const lost: Money = {};
            for (const cycle of own) {
              if (cycle.currency && cycle.wastedValue !== null && cycle.wastedValue > 0) {
                lost[cycle.currency] = round((lost[cycle.currency] ?? 0) + cycle.wastedValue, 2);
              }
            }
            return {
              meterId,
              accountId: latest.accountId,
              account: latest.accountLabel,
              meter: latest.meterLabel,
              windows: own.length,
              averageUnusedPercent: round((own.reduce((sum, cycle) => sum + cycle.wastedFraction, 0) / own.length) * 100),
              lost,
              valueBasis: Object.keys(lost).length === 0 ? null : latest.unit === 'usd' ? ('credit' as const) : ('plan' as const),
              estimated: own.some((cycle) => cycle.confidence === 'estimated'),
              recent: cyclesOf(windowed, meterId, 6).map(cycleSummary)
            };
          })
          .sort(
            (a, b) =>
              Object.values(b.lost).reduce((sum, value) => sum + value, 0) - Object.values(a.lost).reduce((sum, value) => sum + value, 0) ||
              b.averageUnusedPercent - a.averageUnusedPercent
          );

        const lines = [asOf(now)];
        if (inWindow.length === 0) {
          lines.push(`No window finished in the last ${days} days, so there is nothing to report yet. The ledger fills as tracked windows reset.`);
        } else {
          const lostText = moneyPair(totals.lost30, totals.creditsLost30, state.settings.currency);
          const used = totals.utilisation30 === null ? '' : `, ${formatPercent(totals.utilisation30)} of the quota used on average`;
          const money = lostText ? `, ${totals.lostIsEstimate ? 'about ' : ''}${lostText} expired unused` : '';
          lines.push(`Last ${days} days: ${inWindow.length === 1 ? '1 finished window' : `${inWindow.length} finished windows`}${used}${money}.`, '');
          lines.push('| Subscription | Meter | Windows | Unused on average | Expired value |', '| --- | --- | --- | --- | --- |');
          for (const row of meters.slice(0, 20)) {
            lines.push(
              `| ${escapeCell(row.account)} | ${escapeCell(row.meter)} | ${row.windows} | ${Math.round(row.averageUnusedPercent)}% | ${formatMoneyTotals(row.lost, state.settings.currency)}${row.valueBasis === 'credit' ? ' in credits' : ''} |`
            );
          }
          if (meters.length > 20) lines.push('', `(${meters.length - 20} more meters in the structured result)`);
        }
        return done(lines, {
          generatedAt: iso(now),
          timeZone: tz,
          days,
          windows: inWindow.length,
          utilisationPercent: totals.utilisation30 === null ? null : round(totals.utilisation30 * 100),
          lost: roundMoney(totals.lost30),
          creditsLost: roundMoney(totals.creditsLost30),
          lostIsEstimate: totals.lostIsEstimate,
          meters
        });
      })
  );

  server.registerTool(
    'get_costs',
    {
      title: 'API costs',
      description:
        'Returns the tracked pay-as-you-go API spend per source: month to date, a straight-line projection to the end of the month, budget status and the days with spend in the last 30. Use it when the user asks about API costs or budgets. This is money spent, separate from subscription quota.',
      outputSchema: getCostsOutput,
      annotations: READS
    },
    () =>
      reading(async () => {
        const { state, now } = await read();
        const sources = state.spend.map((source) => spendSummary(source, now, tz));
        const monthToDate: Money = {};
        for (const source of state.spend) {
          const spent = summariseSpend(source, now, tz).monthToDate;
          if (spent > 0) monthToDate[source.currency] = round((monthToDate[source.currency] ?? 0) + spent, 2);
        }
        return done([asOf(now), '', costsMarkdown(state, now, tz)], { generatedAt: iso(now), timeZone: tz, monthToDate, sources });
      })
  );

  // -- recording -----------------------------------------------------------------

  server.registerTool(
    'report_usage',
    {
      title: 'Report usage',
      description:
        "Records a fresh reading for one meter: how much is used or left and, optionally, when it resets. Use it after you have seen current numbers, for example on a provider's usage page (list_catalog says where it is and what to read) or in a rate-limit message. Give exactly one of used, remaining, usedPercent or remainingPercent, and/or a reset as resetsAt or resetsInMinutes. Returns the meter's new forecast. It records a number; it does not spend quota.",
      inputSchema: reportUsageInput,
      outputSchema: meterResultOutput,
      annotations: RECORDS
    },
    (args, ctx) =>
      writing(async () => {
        const amounts = (['used', 'remaining', 'usedPercent', 'remainingPercent'] as const).filter((field) => args[field] !== undefined);
        if (amounts.length > 1) {
          throw new ValidationError(amounts[1] as string, `Give one of used, remaining, usedPercent or remainingPercent, not ${amounts.join(' and ')}.`);
        }
        if (args.resetsAt !== undefined && args.resetsInMinutes !== undefined) {
          throw new ValidationError('resetsInMinutes', 'Give resetsAt or resetsInMinutes, not both.');
        }
        if (amounts.length === 0 && args.resetsAt === undefined && args.resetsInMinutes === undefined) {
          throw new ValidationError(
            'used',
            'Give an amount (one of used, remaining, usedPercent, remainingPercent), a reset (resetsAt or resetsInMinutes), or both.'
          );
        }
        const now = service.nowMs();
        const observed: Reading = {};
        for (const field of amounts) observed[field] = args[field] as number;
        if (args.limit !== undefined) observed.limit = args.limit;
        if (args.resetsAt !== undefined) observed.resetsAt = parseInstant('resetsAt', args.resetsAt);
        if (args.resetsInMinutes !== undefined) observed.resetsAt = iso(now + args.resetsInMinutes * MINUTE);

        const state = await service.state();
        const found = service.resolve(state, { account: args.account });
        const meter = args.meter === undefined ? found.meter : resolveMeter(found.account, args.meter);
        const source = agentSource(ctx, args.note);
        const outcome = await service.report({ meterId: meter.id }, observed, source);
        return meterResult(`Recorded, reported by agent "${source.id}".`, outcome);
      })
  );

  server.registerTool(
    'quick_update',
    {
      title: 'Quick update',
      description:
        'Records a reading from one line of text in the dashboard\'s quick-entry form: account, optional meter, amount, optional reset. Examples: "claude weekly 62%", "suno 1200 left resets in 9d", "copilot 120/300 resets dec 1". A bare amount means used. Use it when the user dictates a number in this form; prefer report_usage when you already hold separate values. Returns how the line was understood and the meter\'s new forecast.',
      inputSchema: quickUpdateInput,
      outputSchema: meterResultOutput.extend({ preview: text }),
      annotations: RECORDS
    },
    ({ text: line }, ctx) =>
      writing(async () => {
        const saved = await service.quick(line, agentSource(ctx));
        return meterResult(`Saved: ${saved.preview}`, saved, { preview: saved.preview });
      })
  );

  server.registerTool(
    'record_spend',
    {
      title: 'Record API spend',
      description:
        'Records pay-as-you-go API spend for one day against a spend source (money spent, separate from subscription quota). mode "set" (the default) replaces that day\'s total, "add" adds to it. When no source matches, pass create to make it first. Returns the month to date and the projection against the budget.',
      inputSchema: recordSpendInput,
      outputSchema: recordSpendOutput,
      annotations: RECORDS
    },
    (args, ctx) =>
      writing(async (saved) => {
        const { state, now } = await read();
        const wanted = args.source.trim().toLowerCase();
        const mode = args.mode ?? 'set';
        const entry: { date?: string; amount: number; mode: 'set' | 'add' } = { amount: args.amount, mode };
        if (args.date !== undefined) entry.date = args.date;
        const source = agentSource(ctx);

        // Whether anything could match at all, by the same loose rule the service applies. Only a clean
        // miss may create: an ambiguous name must not add a third source next to the two it matched.
        const matches = state.spend.some(
          (candidate) => candidate.id === wanted || candidate.providerId === wanted || candidate.label.toLowerCase().includes(wanted)
        );
        const create = args.create;
        let sourceId: string;
        if (matches) {
          sourceId = (await service.findSpendSource(args.source)).id;
        } else if (create === undefined) {
          const known = state.spend.map((candidate) => candidate.id).join(', ') || 'none';
          throw new NotFoundError(
            `No spend source matches "${args.source.trim().slice(0, 60)}". Known: ${known}. Pass create with a label to add it.`
          );
        } else {
          const input: { label: string; currency?: string; monthlyBudget?: number } = { label: create.label };
          if (create.currency !== undefined) input.currency = create.currency;
          if (create.monthlyBudget !== undefined) input.monthlyBudget = create.monthlyBudget;
          // Rehearsed on a copy first, so an entry the core rejects does not leave an empty source behind.
          const trial = addSpendSource(state, input, now);
          recordSpend(trial.state, trial.source.id, entry, now, tz);
          sourceId = (await service.addSpendSource(input)).id;
          saved();
        }
        const created = !matches;
        const updated = await service.recordSpend(sourceId, entry, source);
        const after = service.nowMs();
        const date = entry.date ?? dateKey(after, tz);
        const dayTotal = updated.entries.find((candidate) => candidate.date === date)?.amount ?? 0;
        const summary = summariseSpend(updated, after, tz);
        const budget = updated.monthlyBudget
          ? `, budget ${formatMoney(updated.monthlyBudget, updated.currency)}${summary.overBudget ? ' (over)' : summary.headingOver ? ' (heading over)' : ''}`
          : '';
        return done(
          [
            asOf(after),
            `${created ? `Created spend source ${updated.label} (id: ${updated.id}). ` : ''}Recorded ${formatMoney(args.amount, updated.currency)} for ${updated.label} on ${date} (${mode}); that day now totals ${formatMoney(dayTotal, updated.currency)}.`,
            `Month to date ${formatMoney(summary.monthToDate, updated.currency)}, projected ${formatMoney(summary.projected, updated.currency)}${budget}.`
          ],
          { created, entry: { date, amount: args.amount, mode }, dayTotal, source: spendSummary(updated, after, tz) }
        );
      })
  );

  // -- managing accounts ---------------------------------------------------------

  server.registerTool(
    'add_account',
    {
      title: 'Add an account',
      description:
        'Starts tracking a subscription, either from a catalog preset (provider and, optionally, plan; see list_catalog) or from a custom definition (custom: a label and one or more meters). Give exactly one of provider or custom. The new meters have no reading yet, so follow up with report_usage. Ask the user before adding a subscription they did not mention.',
      inputSchema: addAccountInput,
      outputSchema: accountResultOutput,
      annotations: RECORDS
    },
    (args, ctx) =>
      writing(async () => {
        if (args.provider !== undefined && args.custom !== undefined) {
          throw new ValidationError('custom', 'Give provider (a catalog preset) or custom (your own definition), not both.');
        }
        const source = agentSource(ctx);
        if (args.provider !== undefined) {
          const overrides: { label?: string; price?: Price | null; billingDay?: number } = {};
          if (args.label !== undefined) overrides.label = args.label;
          if (args.price !== undefined) overrides.price = args.price;
          if (args.billingDay !== undefined) overrides.billingDay = args.billingDay;
          const account = await service.addFromPreset(args.provider, args.plan, overrides, source);
          const preset = findProvider(CATALOG, account.providerId);
          const tail = [
            `Usage page: ${account.usageUrl ?? 'not known'}${preset ? `. What to read there: ${preset.howToRead}` : ''}`,
            'No reading yet. Record the current numbers with report_usage.'
          ];
          return accountResult(`Added ${account.label} (id: ${account.id}), plan ${account.plan ?? 'not set'}, ${priceText(account.price)}.`, account, tail);
        }
        const custom = args.custom;
        if (custom === undefined) {
          throw new ValidationError('provider', 'Give provider (a catalog preset id from list_catalog) or custom (a label and meters).');
        }
        const input: AccountInput = {
          providerId: 'custom',
          label: args.label ?? custom.label,
          plan: args.plan ?? null,
          price: args.price ?? null,
          usageUrl: custom.usageUrl ?? null,
          notes: custom.notes ?? null,
          meters: custom.meters.map((meter, index) => {
            // The core checks the rule and names the field; the cast only carries it there.
            const built: MeterInput = { label: meter.label, reset: meter.reset as ResetRule };
            if (meter.key !== undefined) built.key = meter.key;
            if (meter.role !== undefined) built.role = meter.role;
            if (meter.unit !== undefined) built.unit = meter.unit;
            if (meter.unitLabel !== undefined) built.unitLabel = meter.unitLabel;
            if (meter.limit !== undefined) built.limit = meter.limit;
            if (meter.used !== undefined) built.used = meter.used;
            if (meter.resetsAt !== undefined) built.resetsAt = parseInstant(`custom.meters[${index}].resetsAt`, meter.resetsAt);
            if (meter.rollover !== undefined) built.rollover = meter.rollover;
            if (meter.valueShare !== undefined) built.valueShare = meter.valueShare;
            return built;
          })
        };
        let account: Account;
        try {
          account = await service.addAccount(input, source);
        } catch (error) {
          // The core names fields of its own input; say where they sit in this tool's arguments.
          if (!(error instanceof ValidationError)) throw error;
          const nested = /^(meters|usageUrl$|notes$)/.test(error.field) || (error.field === 'label' && args.label === undefined);
          throw new ValidationError(nested ? `custom.${error.field}` : error.field, error.message);
        }
        return accountResult(`Added ${account.label} (id: ${account.id}), ${priceText(account.price)}.`, account, [
          'Record the current numbers with report_usage.'
        ]);
      })
  );

  server.registerTool(
    'update_account',
    {
      title: 'Update an account',
      description:
        "Changes an account's label, plan, price, usage-page address or notes, snoozes it (snoozeHours; null wakes it), or changes one meter's settings through meter and meterPatch: limit, reset rule, reset time, carry-over, value share, label, or a corrected used amount. It overwrites the stored values. To record a new usage reading use report_usage instead.",
      inputSchema: updateAccountInput,
      outputSchema: accountResultOutput.extend({ changed: z.array(text) }),
      annotations: OVERWRITES
    },
    (args) =>
      writing(async (saved) => {
        const { state, now } = await read();
        const account = resolveAccount(state, args.account);

        const patch: AccountPatch = {};
        const changed: string[] = [];
        if (args.label !== undefined) patch.label = args.label;
        if (args.plan !== undefined) patch.plan = args.plan;
        if (args.price !== undefined) patch.price = args.price;
        if (args.usageUrl !== undefined) patch.usageUrl = args.usageUrl;
        if (args.notes !== undefined) patch.notes = args.notes;
        changed.push(...Object.keys(patch));
        if (args.snoozeHours !== undefined) {
          patch.snoozedUntil = args.snoozeHours === null ? null : iso(now + args.snoozeHours * HOUR);
          changed.push('snoozeHours');
        }
        const hasAccountPatch = changed.length > 0;

        let meter: Meter | null = null;
        const meterPatch: MeterPatch = {};
        if (args.meterPatch !== undefined) {
          const given = args.meterPatch;
          if (args.meter !== undefined) meter = resolveMeter(account, args.meter);
          else if (account.meters.length === 1) meter = account.meters[0] as Meter;
          else {
            throw new ValidationError(
              'meter',
              `Name the meter meterPatch applies to. ${account.label} has: ${account.meters.map((candidate) => candidate.key).join(', ')}.`
            );
          }
          if (given.label !== undefined) meterPatch.label = given.label;
          if (given.limit !== undefined) meterPatch.limit = given.limit;
          if (given.used !== undefined) meterPatch.used = given.used;
          if (given.reset !== undefined) meterPatch.reset = validateResetRule(given.reset, 'meterPatch.reset');
          if (given.resetsAt !== undefined) {
            meterPatch.resetsAt = given.resetsAt === null ? null : parseInstant('meterPatch.resetsAt', given.resetsAt);
          }
          if (given.rollover !== undefined) meterPatch.rollover = given.rollover;
          if (given.valueShare !== undefined) meterPatch.valueShare = given.valueShare;
          if (Object.keys(meterPatch).length === 0) {
            throw new ValidationError('meterPatch', 'meterPatch is empty. Give at least one of label, limit, used, resetsAt, reset, rollover, valueShare.');
          }
          changed.push(...Object.keys(meterPatch).map((field) => `meterPatch.${field}`));
        } else if (args.meter !== undefined) {
          throw new ValidationError('meterPatch', 'meter says which meter to change; put what to change in meterPatch.');
        }
        if (changed.length === 0) {
          throw new ValidationError(
            'account',
            'Nothing to change. Give at least one of label, plan, price, usageUrl, notes, snoozeHours, or meter with meterPatch.'
          );
        }

        // Both changes are rehearsed on a copy before either is saved, so a rejected meter patch cannot
        // leave the account half updated.
        let trial = state;
        if (hasAccountPatch) trial = updateAccount(trial, account.id, patch, now);
        if (meter) {
          try {
            updateMeter(trial, meter.id, meterPatch, now);
          } catch (error) {
            if (!(error instanceof ValidationError)) throw error;
            throw new ValidationError(error.field.startsWith('meterPatch.') ? error.field : `meterPatch.${error.field}`, error.message);
          }
        }

        let updated = account;
        if (hasAccountPatch) {
          updated = await service.updateAccount(account.id, patch);
          saved();
        }
        if (meter) {
          await service.updateMeter(meter.id, meterPatch);
          updated = (await service.state()).accounts.find((candidate) => candidate.id === account.id) ?? updated;
        }
        const snoozedUntil = toMs(updated.snoozedUntil);
        const tail = snoozedUntil !== null && snoozedUntil > service.nowMs() ? [`Snoozed until ${stamp(snoozedUntil, tz)}.`] : [];
        return accountResult(`Updated ${updated.label} (id: ${updated.id}): ${changed.join(', ')}.`, updated, tail, { changed });
      })
  );

  server.registerTool(
    'remove_account',
    {
      title: 'Remove an account',
      description:
        'Stops tracking an account and deletes its meters. Finished windows stay in the waste ledger. Without confirm: true nothing is removed and the result describes what would be. Call it again with confirm: true only after the user has agreed.',
      inputSchema: removeAccountInput,
      outputSchema: removeAccountOutput,
      annotations: DELETES
    },
    ({ account: name, confirm }) =>
      writing(async () => {
        const { state, now } = await read();
        const account = resolveAccount(state, name);
        const meters = account.meters.map((meter) => ({ id: meter.id, key: meter.key, label: meter.label }));
        const listed = account.meters.map((meter) => `- ${meter.label} [${meter.key}]`);
        const summary = { id: account.id, label: account.label, provider: account.providerId, plan: account.plan };
        if (confirm !== true) {
          return done(
            [
              asOf(now),
              `Not removed. This would stop tracking ${account.label} (id: ${account.id}) and delete its ${meters.length === 1 ? 'meter' : `${meters.length} meters`}:`,
              ...listed,
              'Finished windows would stay in the waste ledger.',
              'Call remove_account again with confirm: true once the user has agreed.'
            ],
            { removed: false, confirmationRequired: true, account: summary, meters }
          );
        }
        await service.removeAccount(account.id);
        return done(
          [
            asOf(service.nowMs()),
            `Removed ${account.label} (id: ${account.id}) and its ${meters.length === 1 ? 'meter' : `${meters.length} meters`}:`,
            ...listed,
            'Its finished windows remain in the waste ledger.'
          ],
          { removed: true, confirmationRequired: false, account: summary, meters }
        );
      })
  );

  // -- collectors ----------------------------------------------------------------

  server.registerTool(
    'refresh_usage',
    {
      title: 'Refresh from collectors',
      description:
        "Runs the enabled collectors now and reports, per collector, whether it succeeded and which meters changed. Collectors are opt-in sources that read usage automatically from local files or provider APIs. Use it when readings are stale, before reading usage pages by hand. May contact provider APIs with the user's own credentials; it never returns them.",
      inputSchema: refreshUsageInput,
      outputSchema: refreshUsageOutput,
      annotations: COLLECTS
    },
    ({ collectors: ids }) =>
      writing(async () => {
        const host = deps.collectors;
        const manual = 'Read the usage pages instead (list_catalog says where) and record the numbers with report_usage.';
        if (!host) {
          return done(['Collectors are not available in this Tokengator process, so nothing was refreshed.', manual], {
            available: false,
            collectors: []
          });
        }
        const requested = ids !== undefined && ids.length > 0;
        if (requested) {
          const known = (await host.list()).map((status) => status.id);
          const unknown = ids.find((id) => !known.includes(id));
          if (unknown !== undefined) {
            throw new ValidationError(
              'collectors',
              `Unknown collector "${unknown.slice(0, 60)}". Known: ${known.length > 0 ? known.join(', ') : 'none'}.`
            );
          }
        }
        const statuses = await host.refresh(requested ? ids : undefined);
        // Only enabled collectors are run, also when one is asked for by id: switching a source on is the
        // user's decision, not something a refresh may do on the side.
        const ran = (status: CollectorStatus): boolean => status.enabled && status.lastRunAt !== null;
        const lines = [asOf(service.nowMs())];
        const count = statuses.filter(ran).length;
        if (count === 0) {
          lines.push(
            requested
              ? 'None of the requested collectors is enabled, so nothing was refreshed. The user can switch collectors on in the dashboard.'
              : 'No collector is enabled, so nothing was refreshed. The user can switch collectors on in the dashboard.',
            manual
          );
        } else {
          lines.push(count === 1 ? 'Ran 1 collector.' : `Ran ${count} collectors.`);
        }
        // Run collectors first, then the ones that were skipped.
        const ordered = [...statuses].sort((a, b) => Number(ran(b)) - Number(ran(a)));
        for (const status of ordered) lines.push(collectorLine(status, ran(status)));
        return done(lines, { available: true, ran: count, collectors: ordered.map((status) => collectorSummary(status, ran(status))) });
      })
  );

  // -- resources and prompt --------------------------------------------------------

  server.registerResource(
    'brief',
    'tokengator://brief',
    {
      title: 'AI quota brief',
      description: 'The current situation as Markdown, most urgent first. The same text as the dashboard\'s "copy brief".',
      mimeType: 'text/markdown'
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await service.brief() }] })
  );

  server.registerResource(
    'state',
    'tokengator://state',
    {
      title: 'Tokengator state',
      description: 'Everything Tokengator stores, as the JSON document its export produces: accounts, meters, readings, finished windows, spend and settings.',
      mimeType: 'application/json'
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await service.exportState(), null, 2) }]
    })
  );

  server.registerPrompt(
    'burn_plan',
    {
      title: 'Plan how to use quota at risk',
      description: 'Asks for a plan that spends the quota about to expire on work the user actually wants done, most urgent first.',
      argsSchema: {
        work: z.string().max(2000).optional().describe('What the user wants to get done. Omit to ask for suggestions.')
      }
    },
    async ({ work }) => {
      const { state, now } = await read();
      const wanted = work?.trim();
      const body = [
        'This is my AI subscription quota right now, most urgent first:',
        '',
        queueText(state, now, tz),
        '',
        wanted ? `What I want to get done: ${wanted}` : 'I have not decided what to work on yet.',
        '',
        wanted
          ? 'Propose how to spend the quota that is at risk on that work, most urgent first: which subscription to use for which part, and roughly how much fits before each reset.'
          : 'Suggest worthwhile things from my current projects that would use the quota at risk, most urgent first, and which subscription to use for each.',
        'If a reading is marked stale, say so and offer to refresh it first. Leave alone any quota that nothing useful fits into: do not invent work just to use it up.',
        'Do not start anything yet. Show me the options and wait for my choice.'
      ].join('\n');
      return {
        description: 'A plan for the quota at risk',
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }]
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function sendRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

/**
 * Streamable HTTP, stateless: a fresh server for every request, built from the same tool definitions for
 * both generations of the protocol. Requests of the 2026-07-28 revision carry everything they need and
 * are answered by the SDK's handler. Requests from clients that still open with a handshake are answered
 * the way they always were: plain JSON, no session id. GET and DELETE answer 405 with a JSON-RPC error.
 *
 * Mount it behind Host, Origin and token validation: the handler itself trusts whoever reaches it.
 */
export function createMcpHttpHandler(deps: McpDeps): (req: IncomingMessage, res: ServerResponse, parsedBody: unknown) => Promise<void> {
  const report = (error: Error): void => log('debug', 'MCP transport error', { error: error.message });
  const modern = createMcpHandler(() => createMcpServer(deps), { legacy: 'reject', maxRequestBodySize: MAX_BODY_BYTES, onerror: report });
  const serveModern = toNodeHandler(modern, { onerror: report });

  /** No session id means a restart of the service never strands a client holding a dead one. */
  const serveLegacy = async (req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<void> => {
    const server = createMcpServer(deps);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transport.onerror = report;
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  };

  return async (req, res, parsedBody) => {
    if (req.method !== 'POST') {
      // Without sessions there is no stream to open with GET and nothing to end with DELETE. 405 is the
      // answer the protocol defines for both, and clients carry on with plain request and response.
      sendRpcError(res, 405, -32000, 'Method not allowed. This endpoint is stateless: send each JSON-RPC message with POST.', { Allow: 'POST' });
      return;
    }
    try {
      // The SDK decides which generation a request belongs to, by the same rule its own entry uses.
      const legacy = await isLegacyRequest(await toWebRequest(req, parsedBody), undefined, { maxRequestBodySize: MAX_BODY_BYTES });
      if (legacy) await serveLegacy(req, res, parsedBody);
      else await serveModern(req, res, parsedBody);
    } catch (error) {
      log('error', 'MCP request failed', { error: error instanceof Error ? error.message : String(error) });
      if (res.headersSent) res.destroy();
      else sendRpcError(res, 500, -32603, 'Internal error.');
    }
  };
}

/**
 * A transport that knows which requests are still waiting for their answer. A client that sends its
 * last calls and closes the pipe (a script, or an agent shutting down) has not withdrawn them: they are
 * answered, and what they report is saved, before the server goes away.
 */
class DrainingTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: Transport['onmessage'];
  private readonly waiting = new Set<string | number>();
  private idle: (() => void)[] = [];
  /** The wrapped transport gives up the moment its input ends, while its output is still open. */
  private inputEnded = false;

  constructor(
    private readonly inner: Transport,
    private readonly output: { write(chunk: string): unknown },
    private readonly drainMs: number
  ) {}

  start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message)) this.waiting.add(message.id);
      this.onmessage?.(message, extra);
    };
    this.inner.onclose = () => {
      this.inputEnded = true;
      // Telling the server now would tear it down under the calls it is still working on.
      void this.drained().then(() => this.onclose?.());
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    try {
      // After the input has ended the answers still owed go straight to the output, as the same lines.
      if (this.inputEnded) this.output.write(serializeMessage(message));
      else await this.inner.send(message, options);
    } finally {
      if (isJSONRPCResponse(message) && message.id !== null && message.id !== undefined) {
        this.waiting.delete(message.id);
        if (this.waiting.size === 0) for (const done of this.idle.splice(0)) done();
      }
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /** Resolves once every request received so far has been answered, or when the time allowed is up. */
  drained(): Promise<void> {
    if (this.waiting.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.drainMs);
      this.idle.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** How long requests that were already received get to finish after the client closed its end. */
const STDIO_DRAIN_MS = 5000;

/** Serves MCP on stdin/stdout until the streams close. Writes nothing but protocol messages to stdout. */
export function runMcpStdio(deps: McpDeps, streams: { input?: Readable; output?: Writable } = {}): Promise<void> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let handle: { close(): Promise<void> } | null = null;
    const transport = new DrainingTransport(new StdioServerTransport(input, output), output, STDIO_DRAIN_MS);
    const finish = (): void => {
      if (finished) return;
      finished = true;
      input.off('end', ended);
      input.off('close', ended);
      output.off('error', finish);
      void (handle?.close() ?? Promise.resolve()).catch(() => undefined).then(resolve);
    };
    // A client that exits closes our stdin. Without this the promise would never settle and the command
    // could not shut down in order. What it sent before leaving is finished first.
    const ended = (): void => void transport.drained().then(finish);
    input.once('end', ended);
    input.once('close', ended);
    // The client went away while an answer was being written: nobody is left to answer.
    output.once('error', finish);
    try {
      // One server for the life of the connection; the opening exchange decides which revision it speaks.
      handle = serveStdio(() => createMcpServer(deps), { transport, onerror: (error) => log('warn', 'MCP stdio error', { error: error.message }) });
    } catch (error) {
      finished = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
