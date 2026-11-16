// Auto-launch the DEDICATED agent Chrome that the gateway owns and proxies to.
//
// The gateway is a session-OWNING singleton: it does not assume a debuggable Chrome
// already exists — it starts its own, with an isolated profile and remote debugging on
// a loopback port, and never touches the user's normal browser/profile. Chrome 136+
// (March 2025) ignores --remote-debugging-port on the default profile, so an isolated
// --user-data-dir is mandatory.
//
// This is the reusable, server-side counterpart of scripts/launch-chrome.mjs so the
// driver can ensure its own Chrome on connect and after a crash (self-healing).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { log } from '../core/logger.js';

export interface ChromeLaunchOptions {
  /** Debug port to open. Parsed from the gateway's browserUrl. */
  port: number;
  /** Loopback host. Always 127.0.0.1 in practice. */
  host?: string;
  /** Explicit Chrome/Edge/Chromium binary. Falls back to OS auto-detection. */
  bin?: string;
  /** Isolated user-data-dir. Defaults to ~/.cache/browsergator/chrome-profile. */
  profileDir?: string;
  /** Opt-in headless (e.g. CI). Default is a visible window you can log into. */
  headless?: boolean;
  /** How long to wait for the debug port to come up before giving up (ms). */
  readyTimeoutMs?: number;
}

const DEFAULT_HOST = '127.0.0.1';

/** Single-flight guard: never spawn two Chromes when concurrent reconnects race. */
let launchInFlight: Promise<boolean> | undefined;

export function defaultProfileDir(): string {
  return process.env['BROWSERGATOR_CHROME_PROFILE'] ?? join(homedir(), '.cache', 'browsergator', 'chrome-profile');
}

export async function debugPortAlive(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function resolveChrome(explicitBin?: string): string | undefined {
  const envBin = explicitBin ?? process.env['BROWSERGATOR_CHROME_BIN'];
  if (envBin && existsSync(envBin)) return envBin;

  const os = platform();
  const candidates: string[] = [];
  if (os === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    candidates.push(
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  } else if (os === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  }
  return candidates.find((p) => existsSync(p));
}

/**
 * Ensure a debuggable agent Chrome is up on the given port. Idempotent and
 * single-flight: if the port already answers, returns immediately; if a launch
 * is already in progress, awaits it rather than starting a second browser.
 * Returns true when the debug port is confirmed alive.
 */
export async function ensureChrome(options: ChromeLaunchOptions): Promise<boolean> {
  const host = options.host ?? DEFAULT_HOST;
  const { port } = options;

  if (await debugPortAlive(host, port)) return true;
  if (launchInFlight) return launchInFlight;

  launchInFlight = launchChrome({ ...options, host }).finally(() => {
    launchInFlight = undefined;
  });
  return launchInFlight;
}

async function launchChrome(options: Required<Pick<ChromeLaunchOptions, 'port' | 'host'>> & ChromeLaunchOptions): Promise<boolean> {
  const { host, port } = options;
  const chrome = resolveChrome(options.bin);
  if (!chrome) {
    log('error', 'Could not find Chrome/Chromium/Edge to auto-launch', {
      hint: 'set BROWSERGATOR_CHROME_BIN to the executable path'
    });
    return false;
  }

  const profileDir = options.profileDir ?? defaultProfileDir();
  mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${host}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--hide-crash-restore-bubble'
  ];
  const headless = options.headless ?? process.env['BROWSERGATOR_CHROME_HEADLESS'] === '1';
  if (headless) args.push('--headless=new');
  args.push('about:blank');

  const child = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  log('info', 'Auto-launching agent Chrome', { bin: chrome, port, headless, profileDir });

  const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (await debugPortAlive(host, port)) {
      log('info', 'Agent Chrome up', { host, port, headless });
      return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  log('error', 'Agent Chrome started but debug port did not open in time', { pid: child.pid, port });
  return false;
}

/** Parse the debug port out of the gateway's browserUrl (default 9222). */
export function portFromBrowserUrl(browserUrl: string): number {
  try {
    const parsed = new URL(browserUrl);
    if (parsed.port) return Number(parsed.port);
  } catch {
    /* fall through */
  }
  return 9222;
}
