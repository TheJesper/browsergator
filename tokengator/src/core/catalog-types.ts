// Shape of the provider catalog and the helpers that turn a preset into an account. The data itself lives
// in catalog.ts so it can be reviewed and updated on its own.

import type { AccountInput, MeterInput } from './accounts.js';
import { BILLING_MONTH_HOURS } from './reset.js';
import { localZone } from './time.js';
import type { MeterRole, Price, ResetRule, Unit } from './types.js';

export type ProviderCategory = 'coding' | 'assistant' | 'voice' | 'music' | 'image' | 'video' | 'api' | 'other';

export const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  coding: 'Coding',
  assistant: 'Assistants',
  voice: 'Voice',
  music: 'Music',
  image: 'Image',
  video: 'Video',
  api: 'API credits',
  other: 'Other'
};

export interface PresetMeter {
  key: string;
  label: string;
  role: MeterRole;
  unit: Unit;
  unitLabel?: string;
  /** Omitted for percent meters. */
  limit?: number;
  reset: ResetRule;
  rollover?: 'none' | 'carries';
  /** Share of the plan price this meter stands for. Sub-limits that overlap another meter use 0. */
  valueShare?: number;
  /**
   * `billing`: the window renews on the subscriber's own billing day, which no preset can know. Until that
   * day is supplied the meter is created with a month-long interval and flagged as needing its reset time.
   */
  anchor?: 'billing';
  /** Throttles only: covers part of the plan (one model family) and does not block the rest. */
  partial?: boolean;
}

export interface PresetPlan {
  id: string;
  name: string;
  price: Price | null;
  meters: PresetMeter[];
  /** Anything a person should know before trusting the preset: published vs. opaque limits, caveats. */
  note?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  vendor: string;
  /** Two characters shown in place of a logo. */
  monogram: string;
  category: ProviderCategory;
  /** Where a signed-in person sees current usage. */
  usageUrl: string;
  /** Which figures to read there, written for a person or an agent with a browser. */
  howToRead: string;
  plans: PresetPlan[];
  /** Ids of collectors that can fill this provider automatically. */
  collectors: string[];
  /**
   * Ways the provider itself documents for putting plan quota to work without sitting at the keyboard.
   * Each one links to the provider's own page, so nobody has to take the note on trust.
   */
  uses?: PresetUse[];
}

export interface PresetUse {
  title: string;
  /** One sentence: what it is, and whether it draws on the same allowance. */
  note: string;
  /** The provider's documentation for it. */
  url: string;
}

export function findProvider(catalog: readonly ProviderPreset[], providerId: string): ProviderPreset | null {
  const wanted = providerId.trim().toLowerCase();
  return (
    catalog.find((provider) => provider.id === wanted) ??
    catalog.find((provider) => provider.name.toLowerCase() === wanted) ??
    null
  );
}

export function findPlan(provider: ProviderPreset, planId?: string | null): PresetPlan | null {
  if (!planId) return provider.plans[0] ?? null;
  const wanted = planId.trim().toLowerCase();
  return (
    provider.plans.find((plan) => plan.id === wanted) ??
    provider.plans.find((plan) => plan.name.toLowerCase() === wanted) ??
    provider.plans.find((plan) => plan.name.toLowerCase().includes(wanted)) ??
    null
  );
}

export { BILLING_MONTH_HOURS };

export function presetMeterInput(meter: PresetMeter, billingDay?: number | null): MeterInput {
  let reset = meter.reset;
  if (meter.anchor === 'billing') {
    reset =
      billingDay && billingDay >= 1 && billingDay <= 31
        ? { kind: 'monthly', day: Math.round(billingDay), time: '00:00', tz: localZone() }
        : { kind: 'interval', hours: BILLING_MONTH_HOURS };
  }
  const input: MeterInput = {
    key: meter.key,
    label: meter.label,
    role: meter.role,
    unit: meter.unit,
    reset,
    rollover: meter.rollover ?? 'none'
  };
  if (meter.limit !== undefined) input.limit = meter.limit;
  if (meter.unitLabel !== undefined) input.unitLabel = meter.unitLabel;
  if (meter.valueShare !== undefined) input.valueShare = meter.valueShare;
  if (meter.partial) input.partial = true;
  return input;
}

/** The account a preset describes, ready for `addAccount`. */
export function presetAccountInput(
  provider: ProviderPreset,
  plan: PresetPlan,
  label?: string,
  billingDay?: number | null
): AccountInput {
  return {
    providerId: provider.id,
    label: label?.trim() || (provider.plans.length > 1 ? `${provider.name} ${plan.name}` : provider.name),
    plan: plan.name,
    price: plan.price,
    usageUrl: provider.usageUrl,
    notes: null,
    meters: plan.meters.map((meter) => presetMeterInput(meter, billingDay))
  };
}

/** Monogram for an account: its provider's, or the first two letters of its label for custom accounts. */
export function monogramFor(catalog: readonly ProviderPreset[], providerId: string, label: string): string {
  const provider = catalog.find((entry) => entry.id === providerId);
  if (provider) return provider.monogram;
  const letters = label.replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 2) || '··').replace(/^(.)(.?)$/, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());
}

export function categoryFor(catalog: readonly ProviderPreset[], providerId: string): ProviderCategory {
  return catalog.find((entry) => entry.id === providerId)?.category ?? 'other';
}

/** True when a plan has a meter that renews on the subscriber's billing day. */
export function planNeedsBillingDay(plan: PresetPlan): boolean {
  return plan.meters.some((meter) => meter.anchor === 'billing');
}
