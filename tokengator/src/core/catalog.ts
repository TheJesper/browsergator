// The provider catalog: plans people actually have, with their quota windows and where to read usage.
//
// Presets are a starting point, not a source of truth. Limits and prices drift, and several providers
// publish no numbers at all (their meters are percent-only). Every field can be edited after adding.
// Sources and verification notes are in the OpenSpec change that introduced the catalog:
// openspec/changes/archive/2026-11-19-add-tokengator-dashboard/research.md

import { BILLING_MONTH_HOURS, type PresetMeter, type PresetPlan, type ProviderPreset } from './catalog-types.js';
import type { Price, Unit } from './types.js';

/** When the entries below were last checked against the providers' own pages. */
export const CATALOG_CHECKED = '2026-11-19';

const usd = (amount: number): Price => ({ amount, currency: 'USD', period: 'month' });

/** A short rate window that opens on first use. Never counted as waste. */
const session = (hours = 5, label = `${hours}-hour session`, key = 'session'): PresetMeter => ({
  key,
  label,
  role: 'throttle',
  unit: 'percent',
  reset: { kind: 'rolling', hours }
});

/** A weekly cap on a fixed schedule: the provider reports the reset instant. */
const weeklyFixed = (label = 'Weekly limit', key = 'weekly', valueShare = 1): PresetMeter => ({
  key,
  label,
  role: 'allowance',
  unit: 'percent',
  reset: { kind: 'interval', hours: 168 },
  valueShare
});

/** A weekly cap that starts with the first request of the period. */
const weeklyFromFirstUse = (label = 'Weekly limit', key = 'weekly', valueShare = 1): PresetMeter => ({
  key,
  label,
  role: 'allowance',
  unit: 'percent',
  reset: { kind: 'rolling', hours: 168 },
  valueShare
});

/** A cap on part of a plan (one model family) inside a weekly allowance. Reaching it blocks only that part. */
const weeklyPart = (label: string, key: string, fromFirstUse = false): PresetMeter => ({
  key,
  label,
  role: 'throttle',
  unit: 'percent',
  reset: fromFirstUse ? { kind: 'rolling', hours: 168 } : { kind: 'interval', hours: 168 },
  partial: true
});

/** A monthly grant that renews on the subscriber's billing day. */
const billingMonth = (
  key: string,
  label: string,
  unit: Unit,
  limit: number | undefined,
  extra: Partial<PresetMeter> = {}
): PresetMeter => {
  const meter: PresetMeter = {
    key,
    label,
    role: 'allowance',
    unit,
    reset: { kind: 'interval', hours: BILLING_MONTH_HOURS },
    anchor: 'billing',
    ...extra
  };
  if (limit !== undefined) meter.limit = limit;
  return meter;
};

/** A monthly grant on the calendar month, UTC. */
const calendarMonth = (key: string, label: string, unit: Unit, limit: number, extra: Partial<PresetMeter> = {}): PresetMeter => ({
  key,
  label,
  role: 'allowance',
  unit,
  limit,
  reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' },
  ...extra
});

const credits = (limit: number, label = 'Monthly credits', extra: Partial<PresetMeter> = {}): PresetMeter =>
  billingMonth('credits', label, 'credits', limit, extra);

const plan = (id: string, name: string, price: Price | null, meters: PresetMeter[], note?: string): PresetPlan => {
  const built: PresetPlan = { id, name, price, meters };
  if (note) built.note = note;
  return built;
};

/** The research recorded that ChatGPT Pro includes monthly API credits, not how many. */
const PRO_CREDITS_NOTE = 'API credits must be claimed in Settings > Billing; the amount here is a starting point, so set it to what that page shows';

export const CATALOG: readonly ProviderPreset[] = [
  // ------------------------------------------------------------------ coding
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    monogram: 'Cl',
    category: 'coding',
    usageUrl: 'https://claude.ai/settings/usage',
    howToRead:
      'Settings > Usage shows "Current session" and each weekly limit as a percentage used with its reset time. Monthly API credits are under Promotional credits on the Console billing page.',
    collectors: ['claude-statusline'],
    uses: [
      {
        title: 'Cloud sessions',
        note: 'Tasks handed to Claude Code on the web keep running with the computer off and count toward the same plan limits.',
        url: 'https://code.claude.com/docs/en/claude-code-on-the-web'
      },
      {
        title: 'Scheduled tasks',
        note: 'Recurring cloud tasks draw on subscription usage the same way interactive sessions do.',
        url: 'https://code.claude.com/docs/en/routines'
      }
    ],
    plans: [
      plan('pro', 'Pro', usd(20), [session(), weeklyFixed('Weekly limit')]),
      plan(
        'max',
        'Max',
        usd(100),
        [
          session(),
          weeklyFixed('Weekly limit'),
          weeklyPart('Weekly, Fable models', 'weekly-fable'),
          billingMonth('api-credits', 'Monthly API credits', 'usd', 100)
        ],
        'API credits must be claimed once by linking a Console organisation'
      ),
      plan(
        'ultra',
        'Ultra',
        usd(200),
        [weeklyFixed('Weekly limit'), weeklyPart('Weekly, Fable models', 'weekly-fable'), billingMonth('api-credits', 'Monthly API credits', 'usd', 200)],
        'no 5-hour limit on verified accounts'
      ),
      plan(
        'team',
        'Team seat',
        usd(25),
        [session(), weeklyFixed('Weekly limit'), billingMonth('api-credits', 'Monthly API credits', 'usd', 20)],
        'the seat price was not verified, so set what you pay; API credits are $20 for a Standard seat and $100 for a Premium seat, pooled across the team'
      )
    ]
  },
  {
    id: 'codex',
    name: 'ChatGPT',
    vendor: 'OpenAI',
    monogram: 'Ch',
    category: 'coding',
    usageUrl: 'https://chatgpt.com/codex/settings/usage',
    howToRead:
      'The usage page shows the 5-hour and weekly windows as a percentage remaining, each with a reset time. Note that it shows what is LEFT, not what is used. From December 2026 Plus, Pro and Business share one allowance between ChatGPT and Codex; until then the page covers Codex.',
    collectors: ['codex-sessions'],
    uses: [
      {
        title: 'Cloud tasks',
        note: 'Codex cloud tasks keep working while the computer is asleep. Local messages and cloud tasks share the plan allowance.',
        url: 'https://learn.chatgpt.com/docs/pricing'
      }
    ],
    plans: [
      plan('plus', 'Plus', usd(20), [session(), weeklyFromFirstUse('Weekly limit')]),
      plan('pro-100', 'Pro 100', usd(100), [weeklyFromFirstUse('Weekly limit'), billingMonth('api-credits', 'Monthly API credits', 'usd', 100)], PRO_CREDITS_NOTE),
      plan('pro-200', 'Pro 200', usd(200), [weeklyFromFirstUse('Weekly limit'), billingMonth('api-credits', 'Monthly API credits', 'usd', 200)], PRO_CREDITS_NOTE),
      plan('pro-500', 'Pro 500', usd(500), [weeklyFromFirstUse('Weekly limit'), billingMonth('api-credits', 'Monthly API credits', 'usd', 500)], PRO_CREDITS_NOTE),
      plan(
        'business',
        'Business seat',
        usd(25),
        [session(), weeklyFromFirstUse('Weekly limit')],
        '$25 billed monthly, $20 billed annually; also includes monthly API credits whose amount is not published per seat, so add a meter for them from Settings > Billing'
      ),
      plan('go', 'Go', usd(8), [{ key: 'monthly', label: 'Monthly allowance', role: 'allowance', unit: 'percent', reset: { kind: 'rolling', hours: 720 }, valueShare: 1 }])
    ]
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    vendor: 'GitHub',
    monogram: 'Cp',
    category: 'coding',
    usageUrl: 'https://github.com/settings/billing',
    howToRead:
      'Billing > Metered usage > Copilot shows AI credits used this month. Allowances reset at 00:00 UTC on the 1st, whatever your billing date.',
    collectors: ['copilot'],
    uses: [
      {
        title: 'Cloud agent',
        note: 'An issue assigned to the Copilot cloud agent is worked on in the background and billed in the same AI credits.',
        url: 'https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing'
      }
    ],
    plans: [
      plan('pro', 'Pro', usd(10), [calendarMonth('ai-credits', 'Monthly AI credits', 'credits', 1500)]),
      plan('pro-plus', 'Pro+', usd(39), [calendarMonth('ai-credits', 'Monthly AI credits', 'credits', 7000)]),
      plan('max', 'Max', usd(100), [calendarMonth('ai-credits', 'Monthly AI credits', 'credits', 20000)]),
      plan('business', 'Business seat', usd(19), [calendarMonth('ai-credits', 'Monthly AI credits', 'credits', 1900)], 'pooled across the organisation'),
      plan('enterprise', 'Enterprise seat', usd(39), [calendarMonth('ai-credits', 'Monthly AI credits', 'credits', 3900)], 'pooled across the organisation'),
      plan('legacy-pro', 'Pro (legacy annual)', usd(10), [calendarMonth('premium-requests', 'Monthly premium requests', 'requests', 300)]),
      plan('legacy-pro-plus', 'Pro+ (legacy annual)', usd(39), [calendarMonth('premium-requests', 'Monthly premium requests', 'requests', 1500)])
    ]
  },
  {
    id: 'gemini',
    name: 'Google AI',
    vendor: 'Google',
    monogram: 'Gm',
    category: 'assistant',
    usageUrl: 'https://gemini.google.com/usage',
    howToRead:
      'gemini.google.com/usage shows the 5-hour and weekly usage as percentages with reset times. Flow and Flow Music credits are at one.google.com/ai/activity.',
    collectors: [],
    plans: [
      plan('plus', 'Plus', usd(4.99), [
        session(),
        weeklyFromFirstUse('Weekly limit', 'weekly', 0.7),
        billingMonth('flow-credits', 'Monthly Flow credits', 'credits', 200, { valueShare: 0.3 }),
        billingMonth('flow-music', 'Flow Music credits', 'credits', 3000, { valueShare: 0 })
      ]),
      plan('pro', 'Pro', usd(19.99), [
        session(),
        weeklyFromFirstUse('Weekly limit', 'weekly', 0.7),
        billingMonth('flow-credits', 'Monthly Flow credits', 'credits', 1000, { valueShare: 0.3 }),
        billingMonth('flow-music', 'Flow Music credits', 'credits', 10000, { valueShare: 0 })
      ]),
      plan('ultra-5x', 'Ultra 5x', usd(99.99), [
        session(),
        weeklyFromFirstUse('Weekly limit', 'weekly', 0.7),
        billingMonth('flow-credits', 'Monthly Flow credits', 'credits', 10000, { valueShare: 0.3 }),
        billingMonth('flow-music', 'Flow Music credits', 'credits', 30000, { valueShare: 0 })
      ]),
      plan('ultra-20x', 'Ultra 20x', usd(199.99), [
        session(),
        weeklyFromFirstUse('Weekly limit', 'weekly', 0.7),
        billingMonth('flow-credits', 'Monthly Flow credits', 'credits', 25000, { valueShare: 0.3 }),
        billingMonth('flow-music', 'Flow Music credits', 'credits', 30000, { valueShare: 0 })
      ])
    ]
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google',
    monogram: 'Ag',
    category: 'coding',
    usageUrl: 'https://antigravity.google/docs/plans/',
    planPage: true,
    howToRead:
      'Run /usage in the Antigravity CLI, or open Settings in the app: each model group has a 5-hour and a weekly quota with a reset time. The price belongs to your Google AI plan, so leave it empty here.',
    collectors: ['antigravity-statusline'],
    plans: [
      plan('included', 'With Google AI Pro or Ultra', null, [
        session(5, 'Gemini, 5-hour', 'gemini-5h'),
        weeklyFromFirstUse('Gemini, weekly', 'gemini-weekly', 1),
        { ...session(5, 'Claude and GPT, 5-hour', '3p-5h'), partial: true },
        weeklyPart('Claude and GPT, weekly', '3p-weekly', true)
      ])
    ]
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    monogram: 'Cu',
    category: 'coding',
    usageUrl: 'https://cursor.com/dashboard',
    howToRead: 'The dashboard Usage tab shows included usage for the current cycle and when it resets.',
    collectors: [],
    uses: [
      {
        title: 'Cloud agents',
        note: 'Cloud agents run in parallel without the editor open and use the plan like other agent work.',
        url: 'https://cursor.com/docs/cloud-agent'
      }
    ],
    plans: [
      plan('weekly-pool', 'Weekly usage pool', usd(30), [weeklyFixed('Weekly usage pool')], 'for plans that refresh weekly'),
      plan('monthly', 'Monthly included usage', usd(20), [billingMonth('included', 'Monthly included usage', 'percent', undefined, { valueShare: 1 })], 'for plans billed with a monthly pool')
    ]
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    vendor: 'Cognition',
    monogram: 'Ws',
    category: 'coding',
    usageUrl: 'https://app.devin.ai/settings/usage',
    howToRead: 'Settings > Usage shows the daily and weekly quota as a percentage remaining.',
    collectors: [],
    plans: [
      plan('pro', 'Pro', usd(20), [
        { key: 'daily', label: 'Daily quota', role: 'throttle', unit: 'percent', reset: { kind: 'daily', time: '00:00', tz: 'UTC' } },
        weeklyFixed('Weekly quota')
      ])
    ]
  },
  {
    id: 'jetbrains-ai',
    name: 'JetBrains AI',
    vendor: 'JetBrains',
    monogram: 'Jb',
    category: 'coding',
    usageUrl: 'https://account.jetbrains.com',
    howToRead: 'The AI widget in the IDE shows credits left and the next refill date.',
    collectors: [],
    plans: [
      plan('pro', 'Pro', usd(10), [{ key: 'credits', label: 'AI credits', role: 'allowance', unit: 'credits', limit: 10, reset: { kind: 'rolling', hours: 720 }, valueShare: 1 }]),
      plan('ultimate', 'Ultimate', usd(30), [{ key: 'credits', label: 'AI credits', role: 'allowance', unit: 'credits', limit: 35, reset: { kind: 'rolling', hours: 720 }, valueShare: 1 }])
    ]
  },
  {
    id: 'kiro',
    name: 'Kiro',
    vendor: 'AWS',
    monogram: 'Ki',
    category: 'coding',
    usageUrl: 'https://kiro.dev/pricing/',
    planPage: true,
    howToRead: 'The account usage dashboard shows credits used this month. The billing month starts on the 1st at 00:00 UTC.',
    collectors: [],
    plans: [
      plan('pro', 'Pro', usd(20), [calendarMonth('credits', 'Monthly credits', 'credits', 1000)]),
      plan('pro-plus', 'Pro+', usd(40), [calendarMonth('credits', 'Monthly credits', 'credits', 2000)]),
      plan('pro-max', 'Pro Max', usd(100), [calendarMonth('credits', 'Monthly credits', 'credits', 5000)]),
      plan('power', 'Power', usd(200), [calendarMonth('credits', 'Monthly credits', 'credits', 10000)])
    ]
  },
  {
    id: 'replit',
    name: 'Replit',
    vendor: 'Replit',
    monogram: 'Re',
    category: 'coding',
    usageUrl: 'https://replit.com/usage',
    howToRead: 'The usage page shows credits used this cycle and the renewal date.',
    collectors: [],
    plans: [
      plan('core', 'Core', usd(20), [billingMonth('credits', 'Monthly credits', 'usd', 20)]),
      plan('pro', 'Pro', usd(100), [billingMonth('credits', 'Monthly credits', 'usd', 100, { rollover: 'carries' })], 'unused credits roll over for two months')
    ]
  },
  {
    id: 'lovable',
    name: 'Lovable',
    vendor: 'Lovable',
    monogram: 'Lv',
    category: 'coding',
    usageUrl: 'https://lovable.dev/',
    howToRead: 'The workspace menu shows credits left this cycle.',
    collectors: [],
    plans: [
      plan('pro', 'Pro', usd(25), [
        credits(100, 'Monthly credits', { rollover: 'carries' }),
        { key: 'daily', label: 'Daily credits', role: 'allowance', unit: 'credits', limit: 5, reset: { kind: 'daily', time: '00:00', tz: 'UTC' }, valueShare: 0 }
      ], 'monthly credits roll over while subscribed; daily ones do not')
    ]
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    vendor: 'Perplexity',
    monogram: 'Px',
    category: 'assistant',
    usageUrl: 'https://www.perplexity.ai/account/usage',
    howToRead: 'Account > Usage shows what is left this period and when it refreshes.',
    collectors: [],
    plans: [
      plan('pro', 'Pro', usd(20), [weeklyFixed('Weekly Pro searches')]),
      plan('max', 'Max', usd(200), [credits(10000, 'Monthly credits')])
    ]
  },

  // ------------------------------------------------------------------ voice and music
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    vendor: 'ElevenLabs',
    monogram: '11',
    category: 'voice',
    usageUrl: 'https://elevenlabs.io/app/subscription',
    howToRead: 'The subscription page shows credits used out of the monthly quota and the date the quota resets.',
    collectors: ['elevenlabs'],
    plans: [
      plan('starter', 'Starter', usd(6), [credits(30000, 'Monthly credits', { rollover: 'carries' })], 'unused credits roll over, up to twice the monthly quota'),
      plan('creator', 'Creator', usd(22), [credits(121000, 'Monthly credits', { rollover: 'carries' })], 'unused credits roll over, up to twice the monthly quota'),
      plan('pro', 'Pro', usd(99), [credits(600000, 'Monthly credits', { rollover: 'carries' })], 'unused credits roll over, up to twice the monthly quota'),
      plan('scale', 'Scale', usd(299), [credits(1800000, 'Monthly credits', { rollover: 'carries' })]),
      plan('free', 'Free', null, [credits(10000, 'Monthly credits')], 'no rollover on the free tier')
    ]
  },
  {
    id: 'suno',
    name: 'Suno',
    vendor: 'Suno',
    monogram: 'Su',
    category: 'music',
    usageUrl: 'https://suno.com/account',
    howToRead: 'The account page shows credits remaining. Subscription credits renew at the same date and time each month as the original purchase and do not carry over.',
    collectors: [],
    plans: [
      plan('pro', 'Pro', usd(10), [credits(2500, 'Monthly song credits')]),
      plan('premier', 'Premier', usd(30), [credits(10000, 'Monthly song credits')]),
      plan('platinum', 'Platinum', usd(120), [credits(15000, 'Monthly song credits')]),
      plan('free', 'Free', null, [{ key: 'credits', label: 'Daily credits', role: 'allowance', unit: 'credits', limit: 50, reset: { kind: 'interval', hours: 24 }, valueShare: 1 }])
    ]
  },
  {
    id: 'udio',
    name: 'Udio',
    vendor: 'Udio',
    monogram: 'Ud',
    category: 'music',
    usageUrl: 'https://www.udio.com/pricing',
    planPage: true,
    howToRead: 'The credit counter in the app shows what is left this cycle.',
    collectors: [],
    plans: [plan('standard', 'Standard', usd(10), [credits(2400)]), plan('pro', 'Pro', usd(30), [credits(6000)])]
  },

  // ------------------------------------------------------------------ image and video
  {
    id: 'midjourney',
    name: 'Midjourney',
    vendor: 'Midjourney',
    monogram: 'Mj',
    category: 'image',
    usageUrl: 'https://www.midjourney.com/account',
    howToRead: 'Manage Subscription shows Fast time remaining and the renewal date. Unused Fast time does not carry over.',
    collectors: [],
    plans: [
      plan('basic', 'Basic', usd(10), [billingMonth('fast', 'Fast GPU time', 'minutes', 200)]),
      plan('standard', 'Standard', usd(30), [billingMonth('fast', 'Fast GPU time', 'minutes', 900)]),
      plan('pro', 'Pro', usd(60), [billingMonth('fast', 'Fast GPU time', 'minutes', 1800)]),
      plan('mega', 'Mega', usd(120), [billingMonth('fast', 'Fast GPU time', 'minutes', 3600)])
    ]
  },
  {
    id: 'leonardo',
    name: 'Leonardo',
    vendor: 'Leonardo.Ai',
    monogram: 'Le',
    category: 'image',
    usageUrl: 'https://app.leonardo.ai/',
    howToRead: 'The token counter in the app shows fast tokens left and the renewal date.',
    collectors: [],
    plans: [
      plan('essential', 'Essential', usd(12), [billingMonth('tokens', 'Monthly fast tokens', 'tokens', 8500, { rollover: 'carries' })], 'unused tokens bank up to three months'),
      plan('premium', 'Premium', usd(30), [billingMonth('tokens', 'Monthly fast tokens', 'tokens', 25000, { rollover: 'carries' })]),
      plan('ultimate', 'Ultimate', usd(60), [billingMonth('tokens', 'Monthly fast tokens', 'tokens', 60000, { rollover: 'carries' })])
    ]
  },
  {
    id: 'ideogram',
    name: 'Ideogram',
    vendor: 'Ideogram',
    monogram: 'Id',
    category: 'image',
    usageUrl: 'https://ideogram.ai/pricing',
    planPage: true,
    howToRead: 'The credit counter shows priority credits left this month.',
    collectors: [],
    plans: [plan('plus', 'Plus', usd(20), [credits(2400, 'Monthly priority credits')]), plan('pro', 'Pro', usd(60), [credits(7500, 'Monthly priority credits')])]
  },
  {
    id: 'runway',
    name: 'Runway',
    vendor: 'Runway',
    monogram: 'Rw',
    category: 'video',
    usageUrl: 'https://app.runwayml.com/',
    howToRead: 'The credit counter in the app shows what is left; plan credits expire on the renewal date.',
    collectors: [],
    plans: [
      plan('standard', 'Standard', null, [credits(625)], 'enter the price you pay'),
      plan('pro', 'Pro', usd(35), [credits(2250)]),
      plan('max', 'Max', null, [credits(9500, 'Monthly credits', { rollover: 'carries' })], 'up to one month of unused credits carries over')
    ]
  },
  {
    id: 'kling',
    name: 'Kling',
    vendor: 'Kuaishou',
    monogram: 'Kl',
    category: 'video',
    usageUrl: 'https://kling.ai/app/membership/membership-plan',
    howToRead: 'The membership page shows credits left and when each grant expires.',
    collectors: [],
    plans: [plan('standard', 'Standard', null, [credits(660)]), plan('pro', 'Pro', null, [credits(3000)]), plan('premier', 'Premier', null, [credits(8000)])]
  },
  {
    id: 'luma',
    name: 'Luma',
    vendor: 'Luma',
    monogram: 'Lu',
    category: 'video',
    usageUrl: 'https://app.lumalabs.ai/billing',
    howToRead: 'The billing page shows credits left this cycle.',
    collectors: [],
    plans: [plan('plus', 'Plus', usd(30), [credits(10000)]), plan('pro', 'Pro', usd(90), [credits(40000)]), plan('ultra', 'Ultra', usd(300), [credits(150000)])]
  },
  {
    id: 'pika',
    name: 'Pika',
    vendor: 'Pika',
    monogram: 'Pk',
    category: 'video',
    usageUrl: 'https://pika.art/pricing',
    planPage: true,
    howToRead: 'The credit counter shows what is left; plan credits refresh each billing cycle.',
    collectors: [],
    plans: [plan('starter', 'Starter', usd(10), [credits(600)]), plan('creator', 'Creator', usd(35), [credits(2600)])]
  },
  {
    id: 'heygen',
    name: 'HeyGen',
    vendor: 'HeyGen',
    monogram: 'Hg',
    category: 'video',
    usageUrl: 'https://app.heygen.com/',
    howToRead: 'The credit counter shows what is left and the renewal date.',
    collectors: [],
    plans: [
      plan('creator', 'Creator', usd(29), [credits(600, 'Monthly credits', { rollover: 'carries' })], 'unused credits last one extra cycle'),
      plan('pro', 'Pro', usd(49), [credits(1000, 'Monthly credits', { rollover: 'carries' })])
    ]
  },

  // ------------------------------------------------------------------ prepaid API credits
  {
    id: 'openai-api',
    name: 'OpenAI API',
    vendor: 'OpenAI',
    monogram: 'Oa',
    category: 'api',
    usageUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    howToRead: 'Billing > Credit grants lists each prepaid grant with its balance and expiry. Purchases expire a year after they are made.',
    collectors: ['openai-costs'],
    plans: [
      plan('prepaid', 'Prepaid', null, [{ key: 'credits', label: 'Prepaid credits', role: 'allowance', unit: 'usd', limit: 50, reset: { kind: 'once' }, valueShare: 1 }], 'set the amount you bought and the expiry date')
    ]
  },
  {
    id: 'anthropic-api',
    name: 'Claude API',
    vendor: 'Anthropic',
    monogram: 'An',
    category: 'api',
    usageUrl: 'https://platform.claude.com/settings/billing',
    howToRead: 'Console > Billing shows the credit balance, and promotional credits with their expiry.',
    collectors: ['anthropic-costs'],
    plans: [
      plan('prepaid', 'Prepaid', null, [{ key: 'credits', label: 'Prepaid credits', role: 'allowance', unit: 'usd', limit: 50, reset: { kind: 'once' }, valueShare: 1 }], 'set the amount you bought and the expiry date')
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: 'OpenRouter',
    monogram: 'Or',
    category: 'api',
    usageUrl: 'https://openrouter.ai/settings/credits',
    howToRead: 'Settings > Credits shows the remaining balance.',
    collectors: ['openrouter'],
    plans: [
      plan('credits', 'Pay as you go', null, [{ key: 'credits', label: 'Credit balance', role: 'allowance', unit: 'usd', limit: 20, reset: { kind: 'none' }, valueShare: 1 }], 'a balance with no reset; OpenRouter may expire unused credits a year after purchase, so set an expiry if yours has one')
    ]
  }
];
