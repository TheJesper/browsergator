// The commands. Each one takes the words that followed its name and an `Io`, and returns the exit code.
// They share one application service with the HTTP API and the MCP server, so the terminal can never
// say something different from the dashboard.

import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { snapshot } from '../core/brief.js';
import { CATALOG, CATALOG_CHECKED } from '../core/catalog.js';
import { connectSnippets } from '../core/connect.js';
import { calendarFeed } from '../core/reminders.js';
import { summarise, viewAccount, viewMeter } from '../core/forecast.js';
import { emptyState, type State } from '../core/types.js';
import { headline } from '../core/wording.js';
import { cliCommand, createApp, packageRoot, resolvePublicDir, type App } from '../server/app.js';
import { createCollectorRunner } from '../server/collectors/index.js';
import { runStatusline } from '../server/collectors/statusline.js';
import type { CollectorStatus } from '../server/collectors/types.js';
import { VERSION, ConfigError, loadConfig, tokengatorHome, type ServiceConfig } from '../server/config.js';
import { envFilePath, liveEnv, loadEnvFile, mergedEnv } from '../server/env.js';
import { redact } from '../server/logger.js';
import { ReminderRunner, type Delivery } from '../server/notify.js';
import { isWildcardHost } from '../server/security.js';
import { AmbiguousTargetError, ReadingError, TokengatorService, ValidationError } from '../server/service.js';
import { NOTE_NOT_INSTALLED, NOTE_NOT_SET_UP, SKILL_CLIENT_IDS, installSkill, type SkillAction } from '../server/skill-install.js';
import { FileStateStore, MemoryStateStore, type FileStoreOptions } from '../server/store.js';
import { ArgError, integerFlag, parseArgs } from './args.js';
import { PROGRAM, commandUsage, usage } from './help.js';
import { readAll, type Io } from './io.js';
import { colorMode, columns, renderCatalog, renderCollectors, renderConnect, renderStatus } from './render.js';

export type { Io } from './io.js';

export type Command = (args: readonly string[], io: Io) => Promise<number>;

const say = (io: Io, text: string): void => void io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
/** Everything on standard error passes through redaction, whatever produced the text. */
const warn = (io: Io, text: string): void => void io.stderr.write(`${redact(text)}\n`);

function noPositionals(command: string, positionals: readonly string[]): void {
  if (positionals.length > 0) throw new ArgError(`${command} takes no arguments, got "${positionals.join(' ')}".`);
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

interface Session {
  home: string;
  /** The process environment with <home>/.env filled in underneath it. */
  env: NodeJS.ProcessEnv;
  service: TokengatorService;
}

/**
 * Runs `work` against the state file. One-shot commands have nobody to tell about later changes, so
 * the file is not watched. Anything the store found wrong with the file is reported afterwards.
 */
async function withState<T>(io: Io, work: (session: Session) => Promise<T>, options: FileStoreOptions = {}): Promise<T> {
  const home = tokengatorHome(io.env);
  const store = new FileStateStore(home, { pollMs: 0, ...options });
  try {
    return await work({ home, env: mergedEnv(io.env, home), service: new TokengatorService(store) });
  } finally {
    for (const warning of store.warnings) warn(io, warning);
    store.close();
  }
}

/** The address a browser or an MCP client on this machine should use for a configured host and port. */
function originOf(host: string, port: number): string {
  // "Every interface" is not an address anything can open; loopback always is.
  const open = isWildcardHost(host) ? (host.includes(':') ? 'localhost' : '127.0.0.1') : host;
  const name = open.includes(':') && !open.startsWith('[') ? `[${open}]` : open;
  return `http://${name}:${port}`;
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

export interface ServeHooks {
  /** Stops the service when aborted, the way a signal would. */
  signal?: AbortSignal;
  onListening?: (address: { host: string; port: number; url: string }) => void;
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export async function serve(args: readonly string[], io: Io, hooks: ServeHooks = {}): Promise<number> {
  const flags = parseArgs(args, { values: ['port', 'host'], switches: ['demo', 'no-collectors'] });
  noPositionals('serve', flags.positionals);
  const port = integerFlag(flags, 'port', 0, 65_535);
  const host = flags.values.get('host')?.trim();
  const demo = flags.switches.has('demo');

  const app: App = await createApp({
    env: io.env,
    demo,
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {})
  });

  let address: { host: string; port: number; url: string };
  try {
    address = await app.http.listen();
  } catch (error) {
    await app.close();
    const code = (error as NodeJS.ErrnoException).code;
    const where = `${app.config.host} port ${app.config.port}`;
    if (code === 'EADDRINUSE') {
      warn(io, `${where} is already in use. Tokengator may already be running there; otherwise choose another port with --port.`);
      return 1;
    }
    if (code === 'EACCES' || code === 'EADDRNOTAVAIL') {
      warn(io, `Cannot listen on ${where} (${code}). Choose another address or port with --host and --port.`);
      return 1;
    }
    throw error;
  }

  if (!demo && !flags.switches.has('no-collectors')) app.collectors.start();
  // Sample data must never reach a real notification centre. With real data the runner only delivers
  // through what the person switched on, so starting it costs a state read a minute and nothing else.
  if (!demo) app.reminders.start();

  // The address is followed by a space, never by punctuation, so a terminal that makes it clickable
  // opens the right page. The token's value is not printed: scrollback and logs outlive the session.
  const sample = demo ? ' with sample data, nothing is saved' : '';
  const token = app.config.token !== null ? ` An access token is set: open ${address.url}/#token=<value of TOKENGATOR_TOKEN> once` : '';
  warn(io, `Tokengator ${VERSION} is running at ${address.url}${sample} (Ctrl+C to stop).${token}`);
  for (const warning of app.service.store.warnings) warn(io, warning);
  if (!isFile(join(resolvePublicDir(), 'index.html'))) {
    warn(io, 'The dashboard is not built yet: run "npm run build". The API and the MCP endpoint are running.');
  }
  hooks.onListening?.(address);

  await new Promise<void>((stopped) => {
    const stop = (): void => {
      for (const signal of STOP_SIGNALS) process.off(signal, stop);
      hooks.signal?.removeEventListener('abort', stop);
      stopped();
    };
    for (const signal of STOP_SIGNALS) process.once(signal, stop);
    hooks.signal?.addEventListener('abort', stop, { once: true });
    if (hooks.signal?.aborted) stop();
  });
  await app.close();
  return 0;
}

// ---------------------------------------------------------------------------
// notify, calendar
// ---------------------------------------------------------------------------

const CHANNEL_LABEL: Record<Delivery['channel'], string> = { desktop: 'This computer', webhook: 'Your address' };

function sayDeliveries(io: Io, deliveries: readonly Delivery[]): void {
  for (const delivery of deliveries) {
    const line = `${CHANNEL_LABEL[delivery.channel]}: ${delivery.ok ? 'sent' : `not sent. ${delivery.error ?? ''}`.trim()}`;
    if (delivery.ok) say(io, line);
    else warn(io, line);
  }
}

/**
 * One check for due reminders, for a scheduler. Asking for it is the opt-in, so the desktop channel is
 * used whether or not the dashboard setting is on. Exit 1 when something was due and nothing took it.
 */
export async function notify(args: readonly string[], io: Io): Promise<number> {
  const flags = parseArgs(args, { values: [], switches: ['dry-run', 'test', 'no-desktop'] });
  noPositionals('notify', flags.positionals);
  const desktop = !flags.switches.has('no-desktop');
  return withState(io, async ({ home, env, service }) => {
    const runner = new ReminderRunner(service, { home, env });
    if (flags.switches.has('test')) {
      const deliveries = await runner.test(desktop);
      if (deliveries.length === 0) warn(io, 'No route is set up: --no-desktop was given and TOKENGATOR_NOTIFY_URL is not set.');
      sayDeliveries(io, deliveries);
      return deliveries.some((delivery) => delivery.ok) ? 0 : 1;
    }
    const dryRun = flags.switches.has('dry-run');
    const outcome = await runner.check({ dryRun, desktop });
    if (outcome.message === null) {
      say(io, 'Nothing is due.');
      return 0;
    }
    say(io, `${outcome.message.title}\n${outcome.message.body}`);
    if (dryRun) {
      say(io, '(dry run: nothing was sent or recorded)');
      return 0;
    }
    if (outcome.deliveries.length === 0) warn(io, 'No route is set up: --no-desktop was given and TOKENGATOR_NOTIFY_URL is not set.');
    sayDeliveries(io, outcome.deliveries);
    return outcome.deliveries.some((delivery) => delivery.ok) ? 0 : 1;
  });
}

/** The coming resets as an iCalendar document on standard output. */
export async function calendar(args: readonly string[], io: Io): Promise<number> {
  const flags = parseArgs(args, { values: ['days'], switches: [] });
  noPositionals('calendar', flags.positionals);
  const days = integerFlag(flags, 'days', 1, 366);
  return withState(io, async ({ env, home, service }) => {
    const config = loadConfig(mergedEnv(env, home));
    const feed = calendarFeed(await service.state(), service.nowMs(), {
      dashboardUrl: `${originOf(config.host, config.port)}/`,
      ...(days !== undefined ? { daysAhead: days } : {})
    });
    // Written as it is: an iCalendar document ends its lines with CR LF, including the last.
    io.stdout.write(feed);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// status, set, add
// ---------------------------------------------------------------------------

export async function status(args: readonly string[], io: Io): Promise<number> {
  const flags = parseArgs(args, { switches: ['json', 'all', 'check', 'no-color'] });
  noPositionals('status', flags.positionals);
  return withState(io, async ({ service }) => {
    const state = await service.state();
    const nowMs = service.nowMs();
    if (flags.switches.has('json')) {
      say(io, JSON.stringify(snapshot(state, nowMs, service.timeZone), null, 2));
    } else {
      const color = colorMode(io.stdout, io.env, flags.switches.has('no-color'));
      say(
        io,
        renderStatus(state, nowMs, {
          color,
          all: flags.switches.has('all'),
          program: PROGRAM,
          // Only a terminal has a width worth fitting; a file or a pipe gets every name in full.
          ...(io.stdout.isTTY === true && io.stdout.columns ? { width: io.stdout.columns } : {})
        })
      );
    }
    return flags.switches.has('check') && summarise(state, nowMs).useNow > 0 ? 2 : 0;
  });
}

export async function set(args: readonly string[], io: Io): Promise<number> {
  // The words are a quick-entry line, not options: they go to the parser exactly as typed.
  const text = args
    .filter((word) => word !== '--')
    .join(' ')
    .trim();
  if (!text) throw new ArgError(`Give an account and an amount, for example: ${PROGRAM} set claude weekly 62% resets thu 09:00`);
  return withState(io, async ({ service }) => {
    const result = await service.quick(text);
    const nowMs = service.nowMs();
    // Through the account, so a closed session limit shows up in the headline's context.
    const view = viewAccount(result.account, nowMs).find((candidate) => candidate.id === result.meter.id) ?? viewMeter(result.account, result.meter, nowMs);
    say(io, result.preview);
    say(io, headline(view, nowMs));
    return 0;
  });
}

export async function add(args: readonly string[], io: Io): Promise<number> {
  const flags = parseArgs(args, { values: ['plan', 'label', 'billing-day'], switches: ['list'] });
  const provider = flags.positionals[0];
  if (flags.switches.has('list') || provider === undefined) {
    say(io, renderCatalog(CATALOG, CATALOG_CHECKED, PROGRAM));
    return 0;
  }
  if (flags.positionals.length > 1) {
    throw new ArgError(`add takes one provider. For a plan use: ${PROGRAM} add ${provider} --plan ${flags.positionals[1] as string}`);
  }
  const billingDay = integerFlag(flags, 'billing-day', 1, 31);
  const label = flags.values.get('label');
  return withState(io, async ({ service }) => {
    const account = await service.addFromPreset(provider, flags.values.get('plan') ?? null, {
      ...(label !== undefined ? { label } : {}),
      ...(billingDay !== undefined ? { billingDay } : {})
    });
    // Semicolons, because a meter's own name may contain a comma.
    const meters = account.meters.map((meter) => meter.label).join('; ');
    say(io, `Added ${account.label} (id ${account.id}) with ${account.meters.length === 1 ? 'one meter' : `${account.meters.length} meters`}: ${meters}.`);
    const unanchored = viewAccount(account, service.nowMs()).filter((view) => view.needsReset);
    if (unanchored.length > 0) {
      say(io, `Reset time not known yet for: ${unanchored.map((view) => view.meter.label).join('; ')}. Include it with the first reading.`);
    }
    say(io, `Record what its usage page says: ${PROGRAM} set ${account.id} <amount> [resets <when>]`);
    if (account.usageUrl) say(io, `Usage page: ${account.usageUrl}`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// mcp, statusline
// ---------------------------------------------------------------------------

export async function mcp(args: readonly string[], io: Io): Promise<number> {
  noPositionals('mcp', parseArgs(args).positionals);
  const home = tokengatorHome(io.env);
  const store = new FileStateStore(home, { pollMs: 0 });
  const service = new TokengatorService(store);
  // Nothing is written to io.stdout here or below: on this command it carries the protocol and nothing else.
  const collectors = createCollectorRunner(service, { env: liveEnv(io.env, home), homeDir: homedir() });
  try {
    // Loaded here and not at the top: the MCP SDK is heavy, and no other command needs it.
    const { runMcpStdio } = await import('../server/mcp.js');
    await runMcpStdio({ service, collectors, version: VERSION });
    return 0;
  } finally {
    // Standard error is free for this: a client shows it in its server log.
    for (const warning of store.warnings) warn(io, warning);
    collectors.stop();
    store.close();
  }
}

/** The longest status line input worth parsing. Claude Code's document is a few kilobytes. */
const STATUSLINE_MAX_BYTES = 1024 * 1024;
const STATUSLINE_READ_MS = 1500;
/** A status line runs after every turn; it gives up on a busy state file rather than hold the terminal. */
const STATUSLINE_LOCK_MS = 400;

export async function statusline(_args: readonly string[], io: Io): Promise<number> {
  let line = PROGRAM;
  try {
    const input = await readAll(io.stdin, { maxBytes: STATUSLINE_MAX_BYTES, timeoutMs: STATUSLINE_READ_MS });
    const store = new FileStateStore(tokengatorHome(io.env), { lockTimeoutMs: STATUSLINE_LOCK_MS, pollMs: 0 });
    try {
      line = await runStatusline(input.complete ? input.text : '', new TokengatorService(store));
    } finally {
      store.close();
    }
  } catch {
    // A status line that fails or complains breaks the terminal it sits in: the fallback line stands.
  }
  try {
    io.stdout.write(`${line || PROGRAM}\n`);
  } catch {
    // nowhere left to print
  }
  return 0;
}

// ---------------------------------------------------------------------------
// collectors
// ---------------------------------------------------------------------------

const PUSH_SOURCES_NOTE = `Claude Code and the Antigravity CLI push their numbers through the status line instead: ${PROGRAM} connect --client statusline`;

export async function collectors(args: readonly string[], io: Io): Promise<number> {
  const [action = 'list', id, ...extra] = parseArgs(args).positionals;
  if (!['list', 'enable', 'disable', 'run'].includes(action)) {
    throw new ArgError(`Unknown collectors action "${action}". Use list, enable <id>, disable <id> or run [<id>].`);
  }
  if (extra.length > 0 || (action === 'list' && id !== undefined)) throw new ArgError(`Too many arguments for collectors ${action}.`);
  if ((action === 'enable' || action === 'disable') && id === undefined) throw new ArgError(`Name the collector: ${PROGRAM} collectors ${action} <id>`);

  return withState(io, async ({ service, env }) => {
    const runner = createCollectorRunner(service, { env, homeDir: homedir() });
    if (action === 'list') {
      say(io, renderCollectors(await runner.list()));
      say(io, PUSH_SOURCES_NOTE);
      return 0;
    }
    if (action === 'enable' || action === 'disable') {
      // Switching one on also runs it once, so the answer shows whether it works.
      const after = await runner.setEnabled(id as string, action === 'enable');
      say(io, renderCollectors([after]));
      return 0;
    }
    const ran = await runner.refresh(id === undefined ? undefined : [id]);
    if (ran.length === 0) {
      say(io, `No collectors are switched on. See what is available: ${PROGRAM} collectors list`);
      return 0;
    }
    say(io, renderCollectors(ran));
    const off = ran.filter((collector) => !collector.enabled);
    if (off.length > 0) {
      warn(io, `${off.map((collector) => collector.id).join(', ')}: switched off, so not run. Switch on with: ${PROGRAM} collectors enable <id>`);
      return 1;
    }
    return ran.some((collector) => collector.lastOutcome === 'failed' || collector.lastOutcome === 'auth') ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// connect, skill
// ---------------------------------------------------------------------------

export async function connect(args: readonly string[], io: Io): Promise<number> {
  const flags = parseArgs(args, { values: ['client'], switches: ['stdio'] });
  noPositionals('connect', flags.positionals);
  const config = loadConfig(mergedEnv(io.env, tokengatorHome(io.env)));
  const all = connectSnippets({ origin: originOf(config.host, config.port), cli: cliCommand(), tokenRequired: config.token !== null });
  let snippets = flags.switches.has('stdio') ? all.filter((snippet) => snippet.group === 'mcp-stdio') : all;

  const client = flags.values.get('client')?.trim().toLowerCase();
  if (client !== undefined) {
    const exact = snippets.filter((snippet) => snippet.id === client);
    snippets = exact.length > 0 ? exact : snippets.filter((snippet) => snippet.id.startsWith(client));
    if (snippets.length === 0) {
      warn(io, `No snippet matches "${client}". Known: ${all.map((snippet) => snippet.id).join(', ')}.`);
      return 1;
    }
    const [single] = snippets;
    if (snippets.length === 1 && single) {
      // Exactly one: print the code alone, so it can be pasted or piped as it is.
      say(io, single.code);
      return 0;
    }
  }
  say(io, renderConnect(snippets));
  if (config.token !== null) {
    say(io, 'An access token is set. The snippets name the TOKENGATOR_TOKEN variable and never contain its value: set that variable where the client runs.');
  }
  return 0;
}

const SKILL_VERB: Record<SkillAction['action'], [done: string, planned: string]> = {
  write: ['installed', 'would install'],
  update: ['updated', 'would update'],
  unchanged: ['up to date', 'up to date'],
  remove: ['removed', 'would remove'],
  skip: ['skipped', 'skipped']
};

export async function skill(args: readonly string[], io: Io): Promise<number> {
  const flags = parseArgs(args, { values: ['only'], switches: ['dry-run', 'all'] });
  const [action, ...extra] = flags.positionals;
  if ((action !== 'install' && action !== 'uninstall') || extra.length > 0) {
    throw new ArgError(`Use: ${PROGRAM} skill install [--dry-run] [--all] [--only=a,b], or ${PROGRAM} skill uninstall [--dry-run]`);
  }
  const only = flags.values
    .get('only')
    ?.split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  const unknown = only?.filter((id) => !SKILL_CLIENT_IDS.includes(id)) ?? [];
  if (unknown.length > 0) throw new ArgError(`Unknown client "${unknown.join(', ')}". Known: ${SKILL_CLIENT_IDS.join(', ')}.`);

  const dryRun = flags.switches.has('dry-run');
  const home = io.env['TOKENGATOR_AGENT_HOME']?.trim() || homedir();
  const { actions } = installSkill({
    home,
    packageRoot: packageRoot(),
    dryRun,
    all: flags.switches.has('all'),
    uninstall: action === 'uninstall',
    ...(only && only.length > 0 ? { only } : {})
  });

  // Clients that are simply not there are summed up in one line instead of one row each.
  const absent = actions.filter((entry) => entry.action === 'skip' && entry.note === NOTE_NOT_SET_UP);
  const shown = actions.filter((entry) => !(entry.action === 'skip' && (entry.note === NOTE_NOT_SET_UP || entry.note === NOTE_NOT_INSTALLED)));
  // The short form is only true when the paths really are under the user's own home directory.
  const prefix = home === homedir() ? home + sep : null;
  const display = (path: string): string => (prefix !== null && path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path);
  if (shown.length > 0) {
    say(io, columns(shown.map((entry) => [entry.client, SKILL_VERB[entry.action][dryRun ? 1 : 0], display(entry.path), entry.note ?? ''])).join('\n'));
  }

  const changed = actions.filter((entry) => entry.action === 'write' || entry.action === 'update' || entry.action === 'remove');
  const current = actions.filter((entry) => entry.action === 'unchanged');
  if (action === 'uninstall') {
    say(io, changed.length === 0 ? 'Nothing to remove.' : dryRun ? 'Dry run: nothing was removed.' : 'Removed. Only what Tokengator installed was touched.');
    return 0;
  }
  if (absent.length > 0) {
    say(io, `Not set up on this machine, so left alone: ${absent.map((entry) => entry.client).join(', ')}. Use --all to install for them anyway.`);
  }
  if (changed.length === 0 && current.length === 0) {
    warn(io, `No agent clients were found under ${home}.`);
    return 1;
  }
  if (changed.length === 0) say(io, 'Everything is up to date.');
  else if (dryRun) say(io, 'Dry run: nothing was written.');
  else say(io, `Done. Agents in ${changed.length === 1 ? 'that client' : 'those clients'} now know when to check Tokengator. Connect its tools with: ${PROGRAM} connect`);
  return 0;
}

// ---------------------------------------------------------------------------
// export, import
// ---------------------------------------------------------------------------

export async function exportState(args: readonly string[], io: Io): Promise<number> {
  noPositionals('export', parseArgs(args).positionals);
  return withState(io, async ({ service }) => {
    say(io, JSON.stringify(await service.exportState(), null, 2));
    return 0;
  });
}

/** Far above any real state document, and low enough that a wrong file is refused instead of parsed. */
const IMPORT_MAX_BYTES = 32 * 1024 * 1024;

export async function importState(args: readonly string[], io: Io): Promise<number> {
  const [file, ...extra] = parseArgs(args).positionals;
  if (file === undefined || extra.length > 0) throw new ArgError(`Name one file: ${PROGRAM} import <file>   (use - for standard input)`);

  let raw: string;
  if (file === '-') {
    const input = await readAll(io.stdin, { maxBytes: IMPORT_MAX_BYTES });
    if (!input.complete) {
      warn(io, 'Standard input could not be read to its end, so nothing was imported.');
      return 1;
    }
    raw = input.text;
  } else {
    const path = resolve(io.cwd, file);
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      warn(io, `Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'}).`);
      return 1;
    }
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    warn(io, `${file === '-' ? 'Standard input' : file} is not valid JSON, so nothing was imported.`);
    return 1;
  }
  return withState(io, async ({ service }) => {
    const state = await service.importState(document);
    const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
    say(
      io,
      `Imported ${count(state.accounts.length, 'account', 'accounts')}, ${count(state.spend.length, 'spend source', 'spend sources')} and ${count(state.cycles.length, 'finished window', 'finished windows')}.`
    );
    return 0;
  });
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Looks at the state file without going through the store, which would set a damaged file aside. */
function inspectState(path: string): { note: string; enabledCollectors: string[] } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { note: code === 'ENOENT' ? 'not created yet' : `cannot be read (${code ?? 'error'})`, enabledCollectors: [] };
  }
  try {
    const document = JSON.parse(raw) as Partial<State> | null;
    if (document === null || typeof document !== 'object' || !Array.isArray(document.accounts)) {
      return { note: 'exists, but is not a Tokengator state document', enabledCollectors: [] };
    }
    const enabled = Array.isArray(document.settings?.enabledCollectors) ? document.settings.enabledCollectors.filter((id) => typeof id === 'string') : [];
    return { note: `exists, ${document.accounts.length === 1 ? '1 account' : `${document.accounts.length} accounts`}`, enabledCollectors: enabled };
  } catch {
    return { note: 'exists, but is not valid JSON; the service will set it aside and start empty', enabledCollectors: [] };
  }
}

export async function doctor(args: readonly string[], io: Io): Promise<number> {
  noPositionals('doctor', parseArgs(args).positionals);
  const home = tokengatorHome(io.env);
  const env = mergedEnv(io.env, home);

  let config: ServiceConfig | null = null;
  let configProblem: string | null = null;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    configProblem = error.message;
  }

  const stateFile = join(home, 'state.json');
  const inspected = inspectState(stateFile);
  const envFile = envFilePath(home);
  const envCount = Object.keys(loadEnvFile(home)).length;
  const publicDir = resolvePublicDir();
  const skillFile = join(packageRoot(), 'skill', 'SKILL.md');
  const tokenSet = (env['TOKENGATOR_TOKEN'] ?? '').trim() !== '';

  const facts: [string, string][] = [
    ['Node', `${process.version} on ${process.platform}`],
    ['Home', home],
    ['State file', `${stateFile} (${inspected.note})`],
    // Names and values of what the file holds stay in the file; the count is enough to see it was read.
    ['Environment file', `${envFile} (${isFile(envFile) ? `present, ${envCount === 1 ? '1 variable' : `${envCount} variables`}` : 'not present'})`],
    ['Address', config ? `${config.host} port ${config.port} (${originOf(config.host, config.port)})` : 'not available: the configuration is not valid (see below)'],
    ['Access token', tokenSet ? 'yes' : 'no'],
    ['Dashboard', `${publicDir} (${isFile(join(publicDir, 'index.html')) ? 'built' : 'not built: run "npm run build"'})`],
    ['Skill', `${skillFile} (${isFile(skillFile) ? 'found' : 'missing'})`],
    ['Command', cliCommand()]
  ];
  say(io, `Tokengator ${VERSION}`);
  say(io, '');
  say(io, columns(facts, 2, 2).join('\n'));
  if (configProblem !== null) {
    say(io, '');
    say(io, redact(`Configuration problem: ${configProblem}`));
  }

  // Availability is worked out against a copy held in memory, so asking never changes the state file.
  const memory = new MemoryStateStore({ ...emptyState(), settings: { ...emptyState().settings, enabledCollectors: inspected.enabledCollectors } });
  const sources = await createCollectorRunner(new TokengatorService(memory), { env, homeDir: homedir() }).list();
  say(io, '');
  say(io, 'Automatic sources');
  say(
    io,
    columns(
      sources.map((source: CollectorStatus) => [source.id, source.sourceKind, source.enabled ? 'on' : 'off', source.available ? 'available' : (source.reason ?? 'not available')]),
      2,
      2
    ).join('\n')
  );
  say(io, `  ${PUSH_SOURCES_NOTE}`);
  return configProblem === null ? 0 : 1;
}

// ---------------------------------------------------------------------------
// help, dispatch
// ---------------------------------------------------------------------------

export async function help(args: readonly string[], io: Io): Promise<number> {
  const name = args.find((word) => !word.startsWith('-'));
  if (name === undefined) {
    say(io, usage());
    return 0;
  }
  const text = commandUsage(name);
  if (text === null) {
    warn(io, `Unknown command "${name}".\n\n${usage().trimEnd()}`);
    return 1;
  }
  say(io, text);
  return 0;
}

export const COMMANDS: Readonly<Record<string, Command>> = {
  serve,
  status,
  set,
  add,
  mcp,
  statusline,
  collectors,
  notify,
  calendar,
  connect,
  skill,
  export: exportState,
  import: importState,
  doctor
};

/** Turns whatever a command threw into a message on standard error and a non-zero exit code. */
function report(io: Io, command: string, error: unknown): number {
  if (error instanceof ArgError) {
    warn(io, error.message);
    warn(io, `See: ${PROGRAM} help ${command}`);
    return 1;
  }
  if (error instanceof AmbiguousTargetError) {
    warn(io, error.message);
    for (const candidate of error.candidates) warn(io, `  ${candidate.label}  (${candidate.meterId ?? candidate.accountId})`);
    return 1;
  }
  if (error instanceof ValidationError || error instanceof ReadingError) {
    warn(io, `${error.field}: ${error.message}`);
    return 1;
  }
  warn(io, error instanceof Error ? error.message : String(error));
  return 1;
}

/** Parses the command line and runs one command. Returns the process exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const first = argv[0];
  const options = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  const wantsHelp = options.includes('--help') || options.includes('-h');

  // No command word: `tokengator`, `tokengator --port 4777` and so on start the service.
  const bare = first === undefined || first.startsWith('-');
  if (bare && (argv.includes('--version') || argv.includes('-v'))) {
    say(io, VERSION);
    return 0;
  }
  if (bare && wantsHelp) return help([], io);
  const name = bare ? 'serve' : (first as string);
  const rest = bare ? argv : argv.slice(1);

  if (name === 'help') return help(rest, io);
  if (name === 'version') {
    say(io, VERSION);
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined || !Object.hasOwn(COMMANDS, name)) {
    warn(io, `Unknown command "${name}".\n\n${usage().trimEnd()}`);
    return 1;
  }
  if (wantsHelp) return help([name], io);
  try {
    return await command(rest, io);
  } catch (error) {
    // The status line contract is absolute: whatever happened, it exits 0 and prints no error.
    if (name === 'statusline') return 0;
    return report(io, name, error);
  }
}
