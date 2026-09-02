#!/usr/bin/env node
// Portable cross-platform launcher for the Browsergator gateway.
// Runs on any OS Node runs on. Resolves the Node interpreter from the current
// runtime (process.execPath), ensures the data directory exists, and spawns the
// gateway in the foreground so it lives with the terminal (Ctrl+C stops it).
// No hardcoded interpreter path, no shell string interpolation, no shell: true.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Dev mode runs the TypeScript entry via tsx; prod runs the compiled dist.
const dev = process.argv.includes('--dev') || process.env.BG_DEV === '1';
const entry = dev ? join(root, 'src', 'index.ts') : join(root, 'dist', 'index.js');

// Ensure the default data directory exists before starting (config default is
// <cwd>/.data). The gateway is launched with cwd = root, so this keeps parity.
mkdirSync(join(root, '.data'), { recursive: true });

if (!dev && !existsSync(entry)) {
  console.error(`[run-gateway] Missing ${entry}. Build first: npm run build`);
  process.exit(1);
}

// Interpreter: the Node that runs this launcher. Guaranteed present, portable,
// and free of PATH-lookup ambiguity across nvm/fnm/winget/Scoop/Homebrew.
const nodeBin = process.execPath;
// For --dev, use `--import tsx` (Node 22+) so a global tsx install is not required.
const args = dev ? ['--import', 'tsx', entry] : [entry];

const child = spawn(nodeBin, args, {
  cwd: root,
  stdio: 'inherit', // foreground; logs stream to the terminal
  env: process.env // .env is loaded by the gateway entrypoint before loadConfig()
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise the signal semantics with a conventional exit code.
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`[run-gateway] Failed to start gateway: ${error.message}`);
  process.exit(1);
});
