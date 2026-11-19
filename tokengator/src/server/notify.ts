// Reminders that reach the person when the dashboard is closed: a notification on this computer, and
// optionally a message to an address of their own (an ntfy topic, a Slack or Discord webhook).
//
// Two rules shape this file. Text never passes through a shell or into a script: it travels as an
// argument or an environment variable to a fixed command. And the webhook address is a secret: it is
// read from the environment when needed and never logged, stored or returned.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { digestReminders, dueReminders, rememberReminders, type Reminder } from '../core/reminders.js';
import { log } from './logger.js';
import type { TokengatorService } from './service.js';

export interface OutgoingMessage {
  title: string;
  body: string;
}

export interface DesktopCommand {
  command: string;
  args: string[];
  /** Extra environment for the command. This is how text reaches PowerShell without being parsed by it. */
  env?: Record<string, string>;
}

// Windows PowerShell 5.1 ships with every supported Windows and can raise a toast through WinRT with no
// module to install. The application id is PowerShell's own, which Windows already knows, so the toast is
// shown and kept in the notification centre; the price is that it is attributed to PowerShell.
const WINDOWS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_TOAST = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$text = $xml.GetElementsByTagName('text')",
  '$text.Item(0).AppendChild($xml.CreateTextNode($env:TOKENGATOR_NOTIFY_TITLE)) | Out-Null',
  '$text.Item(1).AppendChild($xml.CreateTextNode($env:TOKENGATOR_NOTIFY_BODY)) | Out-Null',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($toast)`
].join('; ');

/** The command that raises a notification on this platform, or null where there is no standard one. */
export function desktopCommand(platform: NodeJS.Platform, message: OutgoingMessage): DesktopCommand | null {
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', message.title, message.body]
    };
  }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', WINDOWS_TOAST],
      env: { TOKENGATOR_NOTIFY_TITLE: message.title, TOKENGATOR_NOTIFY_BODY: message.body }
    };
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { command: 'notify-send', args: ['--app-name=Tokengator', '--', message.title, message.body] };
  }
  return null;
}

const COMMAND_TIMEOUT_MS = 15_000;

function runCommand(command: DesktopCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
      env: { ...process.env, ...command.env }
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === 'ENOENT' ? `${command.command} is not installed.` : `${command.command} could not be started.`));
    });
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command.command} ended with status ${String(code)}.`));
    });
  });
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export const NOTIFY_URL_VARIABLE = 'TOKENGATOR_NOTIFY_URL';
const WEBHOOK_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface WebhookTarget {
  url: URL;
  /** Shown to the person so they can tell which address is configured, without the secret path. */
  host: string;
  format: 'text' | 'slack' | 'discord';
}

/** Reads the webhook address. Returns an error message instead of a target when it cannot be used. */
export function webhookTarget(env: NodeJS.ProcessEnv): WebhookTarget | { error: string } | null {
  const raw = env[NOTIFY_URL_VARIABLE]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `${NOTIFY_URL_VARIABLE} is not an address.` };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    return { error: `${NOTIFY_URL_VARIABLE} must start with https:// (http:// is accepted for this computer only).` };
  }
  if (url.username || url.password) return { error: `${NOTIFY_URL_VARIABLE} must not carry a user name or password.` };
  const host = url.hostname;
  const format = host === 'hooks.slack.com' ? 'slack' : (host === 'discord.com' || host === 'discordapp.com') && url.pathname.startsWith('/api/webhooks/') ? 'discord' : 'text';
  return { url, host, format };
}

/** Header values are Latin-1. A title outside it goes in the body instead of failing the request. */
const headerSafe = (text: string): boolean => /^[\x20-\x7E]*$/.test(text);

export function webhookRequest(target: WebhookTarget, message: OutgoingMessage): { headers: Record<string, string>; body: string } {
  if (target.format === 'slack') {
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${message.title}*\n${message.body}` }) };
  }
  if (target.format === 'discord') {
    // Nothing in a reminder should ping anyone, whatever an account happens to be called.
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${message.title}**\n${message.body}`.slice(0, 1900), allowed_mentions: { parse: [] } })
    };
  }
  // Plain text with a Title header is what ntfy takes, and what most "post me a line" endpoints accept.
  return headerSafe(message.title)
    ? { headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: message.title }, body: message.body }
    : { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: `${message.title}\n${message.body}` };
}

async function postWebhook(target: WebhookTarget, message: OutgoingMessage, fetchImpl: typeof fetch): Promise<void> {
  const request = webhookRequest(target, message);
  let response: Response;
  try {
    response = await fetchImpl(target.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
    });
  } catch {
    // The cause can quote the address, which is a secret. Name the host and nothing else.
    throw new Error(`${target.host} could not be reached.`);
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`${target.host} answered ${response.status}.`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface Delivery {
  channel: 'desktop' | 'webhook';
  ok: boolean;
  /** Why it failed, in words that are safe to show. */
  error?: string;
}

export interface ReminderOutcome {
  due: Reminder[];
  message: OutgoingMessage | null;
  deliveries: Delivery[];
}

export interface ReminderStatus {
  desktop: { enabled: boolean; supported: boolean };
  webhook: { configured: boolean; host: string | null; error: string | null };
}

export interface ReminderRunnerOptions {
  /** Directory for the record of what has been raised (reminders.json). Null keeps it in memory. */
  home: string | null;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Replaces running the notification command. For tests. */
  run?: (command: DesktopCommand) => Promise<void>;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}

export interface CheckOptions {
  /** Work out what is due without sending or recording anything. */
  dryRun?: boolean;
  /**
   * Overrides the setting for this run: true uses the desktop channel even when the setting is off (an
   * explicit `tokengator notify`), false leaves it out (a machine without a desktop).
   */
  desktop?: boolean;
}

const CHECK_INTERVAL_MS = 60_000;
/** Long enough for the automatic sources to bring fresh numbers after a start, so the first word is not a stale one. */
const FIRST_CHECK_MS = 45_000;
/** After a run in which nothing could be delivered, wait before trying the same reminders again. */
const RETRY_AFTER_MS = 15 * 60_000;

export const TEST_MESSAGE: OutgoingMessage = {
  title: 'Tokengator reminders work',
  body: 'This is where you will hear that quota is about to expire unused.'
};

export class ReminderRunner {
  private readonly platform: NodeJS.Platform;
  private readonly run: (command: DesktopCommand) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private memory: string[] = [];
  private busy = false;
  private retryAt = 0;

  constructor(
    private readonly service: TokengatorService,
    private readonly options: ReminderRunnerOptions
  ) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runCommand;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  }

  async status(): Promise<ReminderStatus> {
    const state = await this.service.state();
    const target = webhookTarget(this.options.env);
    return {
      desktop: { enabled: state.settings.desktopReminders === true, supported: desktopCommand(this.platform, TEST_MESSAGE) !== null },
      webhook: {
        configured: target !== null && !('error' in target),
        host: target !== null && !('error' in target) ? target.host : null,
        error: target !== null && 'error' in target ? target.error : null
      }
    };
  }

  /** Raises whatever is due and has not been raised for its window. */
  async check(options: CheckOptions = {}): Promise<ReminderOutcome> {
    const state = await this.service.state();
    const nowMs = this.service.nowMs();
    const sent = await this.load();
    const due = dueReminders(state, nowMs, sent, this.service.timeZone);
    const message = digestReminders(due);
    if (message === null || options.dryRun) return { due, message, deliveries: [] };

    const deliveries = await this.deliver(message, options.desktop ?? state.settings.desktopReminders === true);
    // Recorded as raised once any channel took it. With none, the same reminders are tried again later.
    if (deliveries.some((delivery) => delivery.ok)) {
      await this.save(rememberReminders(sent, due.map((reminder) => reminder.key), nowMs));
    }
    for (const delivery of deliveries) {
      if (!delivery.ok) log('warn', 'reminder not delivered', { channel: delivery.channel, reason: delivery.error });
    }
    return { due, message, deliveries };
  }

  /** Sends a fixed message through every channel that is switched on, so the person can see it arrive. */
  test(desktop = true): Promise<Delivery[]> {
    return this.deliver(TEST_MESSAGE, desktop);
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      if (this.busy || Date.now() < this.retryAt) return;
      this.busy = true;
      this.check()
        .then((outcome) => {
          if (outcome.deliveries.length > 0 && !outcome.deliveries.some((delivery) => delivery.ok)) this.retryAt = Date.now() + RETRY_AFTER_MS;
        })
        .catch((error: unknown) => {
          this.retryAt = Date.now() + RETRY_AFTER_MS;
          log('warn', 'reminder check failed', { reason: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          this.busy = false;
        });
    };
    this.first = setTimeout(tick, Math.min(FIRST_CHECK_MS, this.intervalMs));
    this.first.unref();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = undefined;
    this.timer = undefined;
  }

  private async deliver(message: OutgoingMessage, desktop: boolean): Promise<Delivery[]> {
    const deliveries: Delivery[] = [];
    if (desktop) {
      const command = desktopCommand(this.platform, message);
      if (command === null) deliveries.push({ channel: 'desktop', ok: false, error: 'This system has no standard notification command.' });
      else deliveries.push(await this.attempt('desktop', () => this.run(command)));
    }
    const target = webhookTarget(this.options.env);
    if (target !== null) {
      if ('error' in target) deliveries.push({ channel: 'webhook', ok: false, error: target.error });
      else deliveries.push(await this.attempt('webhook', () => postWebhook(target, message, this.fetchImpl)));
    }
    return deliveries;
  }

  private async attempt(channel: Delivery['channel'], work: () => Promise<void>): Promise<Delivery> {
    try {
      await work();
      return { channel, ok: true };
    } catch (error) {
      return { channel, ok: false, error: error instanceof Error ? error.message : 'It did not work.' };
    }
  }

  private file(): string | null {
    return this.options.home === null ? null : join(this.options.home, 'reminders.json');
  }

  private async load(): Promise<string[]> {
    const file = this.file();
    if (file === null) return this.memory;
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      const sent = (parsed as { sent?: unknown } | null)?.sent;
      return Array.isArray(sent) ? sent.filter((key): key is string => typeof key === 'string') : [];
    } catch {
      // Missing or unreadable: at worst a reminder is raised a second time.
      return [];
    }
  }

  private async save(sent: string[]): Promise<void> {
    const file = this.file();
    if (file === null || this.options.home === null) {
      this.memory = sent;
      return;
    }
    await mkdir(this.options.home, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify({ sent }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
