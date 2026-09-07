#!/usr/bin/env node
// Portable launcher for the DEDICATED agent Chrome that Browsergator connects to.
//
// This starts a SEPARATE Chrome instance with its own isolated profile and remote
// debugging on a loopback port. It never touches your normal/default browser or
// profile. Chrome 136+ (March 2025) no longer honours --remote-debugging-port on
// the default profile, so an isolated --user-data-dir is mandatory, not optional.
//
// Idempotent: if the debug port already answers, it exits without launching a second
// Chrome. Detached: the browser keeps running after this launcher returns.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.BROWSERGATOR_CHROME_PORT ?? 9222);
const HOST = '127.0.0.1';

// Profile lives OUTSIDE any repo, under the current user's home -- derived at
// runtime so the same script works on every machine and user. Never committed.
const profileDir =
  process.env.BROWSERGATOR_CHROME_PROFILE ?? join(homedir(), '.cache', 'browsergator', 'chrome-profile');

async function debugPortAlive() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://${HOST}:${PORT}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function resolveChrome() {
  if (process.env.BROWSERGATOR_CHROME_BIN && existsSync(process.env.BROWSERGATOR_CHROME_BIN)) {
    return process.env.BROWSERGATOR_CHROME_BIN;
  }
  const os = platform();
  const candidates = [];
  if (os === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
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

async function main() {
  if (await debugPortAlive()) {
    console.log(`[launch-chrome] Debug port ${HOST}:${PORT} already answering -- not launching a second Chrome.`);
    return;
  }

  const chrome = resolveChrome();
  if (!chrome) {
    console.error('[launch-chrome] Could not find Chrome/Chromium/Edge. Set BROWSERGATOR_CHROME_BIN to the executable path.');
    process.exit(1);
  }

  mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--remote-debugging-address=${HOST}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--hide-crash-restore-bubble',
    'about:blank'
  ];

  const child = spawn(chrome, args, {
    detached: true, // survives this launcher process
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  // Confirm it actually opened the port before reporting success.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await debugPortAlive()) {
      console.log(`[launch-chrome] Agent Chrome up on ${HOST}:${PORT} (profile: ${profileDir}).`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`[launch-chrome] Chrome started (pid ${child.pid}) but debug port ${PORT} did not open in time.`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`[launch-chrome] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
