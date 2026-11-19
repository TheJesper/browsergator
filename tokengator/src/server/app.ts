// The composition root: the one place that decides which store, service, collectors and servers make
// up a running Tokengator. `tokengator serve` uses it, and so does anything that embeds the service.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoState } from '../core/demo.js';
import { createCollectorRunner, type CollectorRunner } from './collectors/index.js';
import { VERSION, loadConfig, tokengatorHome, type ServiceConfig } from './config.js';
import { liveEnv, mergedEnv } from './env.js';
import type { TokengatorHttpServer } from './http.js';
import { ReminderRunner } from './notify.js';
import { TokengatorService } from './service.js';
import { FileStateStore, MemoryStateStore, type StateStore } from './store.js';

export interface AppOptions {
  env: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
  /** Serve built-in sample data from memory. Nothing is read from or written to the state file. */
  demo?: boolean;
}

export interface App {
  config: ServiceConfig;
  service: TokengatorService;
  collectors: CollectorRunner;
  /** Raises reminders outside the dashboard. Created for every app; `serve` decides whether to start it. */
  reminders: ReminderRunner;
  http: TokengatorHttpServer;
  /** Stops the collectors, the HTTP server and the file watch. Safe to call more than once. */
  close(): Promise<void>;
}

/** The directory that holds this package's package.json, whether running from src/ or from dist/. */
export function packageRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) break;
  }
  // No package.json above us (a relocated build): fall back to the layout <root>/dist/server/app.js.
  return resolve(start, '..', '..');
}

/** Where the built dashboard lives. The HTTP server answers with a "not built yet" page when it is missing. */
export function resolvePublicDir(): string {
  return join(packageRoot(), 'dist', 'public');
}

export interface CliLocation {
  /** The search path of the process that will later run the command. */
  path?: string | undefined;
  platform?: NodeJS.Platform;
  /** Where the package is installed. */
  root?: string;
}

/**
 * How this machine invokes the CLI, for connection snippets. The short name is used only when the shim
 * that started this process sits in a directory on the search path, which is what a global install
 * gives. A project-local shim (`node_modules/.bin`, on the path only while npm runs a script), a clone,
 * `npm start` and a test runner all get the built entry point instead, because whatever runs the
 * snippet later will not find the short name.
 *
 * The entry point is written with forward slashes on every platform. Node accepts them on Windows, and
 * a path with backslashes does not survive Git Bash, which is what runs a Claude Code status line there.
 */
export function cliCommand(script: string | undefined = process.argv[1], where: CliLocation = {}): string {
  const platform = where.platform ?? process.platform;
  const windows = platform === 'win32';
  // Split on both separators: a Windows path must be read correctly whatever platform parses it.
  const parts = (script ?? '').split(/[\\/]/);
  const name = parts.pop() ?? '';
  const fold = (dir: string): string => {
    const plain = dir.replace(/[\\/]+/g, '/').replace(/\/$/, '');
    return windows ? plain.toLowerCase() : plain;
  };
  const dir = fold(parts.join('/'));
  if (/^tokengator(\.(cmd|ps1|exe))?$/i.test(name) && !dir.endsWith('/node_modules/.bin')) {
    const searched = (where.path ?? process.env['PATH'] ?? '').split(windows ? ';' : ':').map(fold);
    if (dir !== '' && searched.includes(dir)) return 'tokengator';
  }
  const entry = join(where.root ?? packageRoot(), 'dist', 'cli', 'main.js');
  return `node "${windows ? entry.replace(/\\/g, '/') : entry}"`;
}

/**
 * The CLI as an absolute program and an absolute script, for schedulers and start-up entries. Those run
 * with a search path of two or three system directories, so neither `tokengator` nor `node` is found.
 */
export function fullCommand(where: CliLocation & { node?: string } = {}): string {
  const windows = (where.platform ?? process.platform) === 'win32';
  const plain = (path: string): string => (windows ? path.replace(/\\/g, '/') : path);
  return `"${plain(where.node ?? process.execPath)}" "${plain(join(where.root ?? packageRoot(), 'dist', 'cli', 'main.js'))}"`;
}

export async function createApp(options: AppOptions): Promise<App> {
  const home = tokengatorHome(options.env);
  const overrides: Partial<Pick<ServiceConfig, 'host' | 'port' | 'demo'>> = {};
  if (options.host !== undefined) overrides.host = options.host;
  if (options.port !== undefined) overrides.port = options.port;
  if (options.demo !== undefined) overrides.demo = options.demo;
  const config = loadConfig(mergedEnv(options.env, home), overrides);

  const store: StateStore = config.demo ? new MemoryStateStore(demoState(Date.now())) : new FileStateStore(config.home);
  try {
    // Read once before anything is served, so a state file that cannot be parsed is set aside and
    // reported at start instead of on some later request.
    await store.read();
  } catch (error) {
    store.close();
    throw error;
  }

  // The HTTP server and the MCP SDK are by far the heaviest things to load. They are imported here
  // rather than at the top so that commands which only need the paths below, the status line above
  // all, start in a fraction of the time.
  const [{ TokengatorHttpServer: HttpServer }, { createMcpHttpHandler }] = await Promise.all([import('./http.js'), import('./mcp.js')]);

  const service = new TokengatorService(store);
  // Collectors get a live view of the environment file: a key added while the service is running is
  // picked up by the next run.
  const env = liveEnv(options.env, config.home);
  const collectors = createCollectorRunner(service, { env, homeDir: homedir() });
  // On sample data nothing is kept on disk, and nothing is ever delivered (see `serve` and the test route).
  const reminders = new ReminderRunner(service, { home: config.demo ? null : config.home, env });
  const http = new HttpServer({
    service,
    config,
    publicDir: resolvePublicDir(),
    collectors,
    reminders,
    mcpHandler: createMcpHttpHandler({ service, collectors, version: VERSION }),
    cliCommand: cliCommand()
  });

  let closing: Promise<void> | null = null;
  return {
    config,
    service,
    collectors,
    reminders,
    http,
    close(): Promise<void> {
      closing ??= (async () => {
        collectors.stop();
        reminders.stop();
        await http.close();
        store.close();
      })();
      return closing;
    }
  };
}
