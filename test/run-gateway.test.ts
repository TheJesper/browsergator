import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const launcherSource = resolve(process.cwd(), 'scripts', 'run-gateway.mjs');
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Create an isolated fake project root with the launcher copied into scripts/. */
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bg-launcher-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(launcherSource, join(root, 'scripts', 'run-gateway.mjs'));
  return root;
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runLauncher(root: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'run-gateway.mjs')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('run-gateway launcher', () => {
  it('should exit non-zero with a build hint when dist/index.js is missing', async () => {
    const root = makeTempRoot();

    const result = await runLauncher(root);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Build first: npm run build');
  }, 15_000);

  it('should create the data directory before failing on a missing build', async () => {
    const root = makeTempRoot();
    expect(existsSync(join(root, '.data'))).toBe(false);

    await runLauncher(root);

    expect(existsSync(join(root, '.data'))).toBe(true);
  }, 15_000);
});
