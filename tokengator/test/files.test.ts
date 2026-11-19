// Files as Windows tools leave them, and the command lines Windows needs (platform review findings).

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planSpawn } from '../src/cli/wrap.js';
import { connectSnippets } from '../src/core/connect.js';
import { cliCommand } from '../src/server/app.js';
import { loadEnvFile } from '../src/server/env.js';
import { decodeText, replaceFile } from '../src/server/files.js';
import { FileStateStore } from '../src/server/store.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tg-files-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const TEXT = '{"name":"Zoë","note":"100 €"}';
const utf16le = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = (text: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
const utf8bom = (text: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);

describe('decodeText', () => {
  it('reads UTF-8 with and without a byte-order mark, and UTF-16 of either byte order', () => {
    expect(decodeText(Buffer.from(TEXT, 'utf8'))).toBe(TEXT);
    expect(decodeText(utf8bom(TEXT))).toBe(TEXT);
    expect(decodeText(utf16le(TEXT))).toBe(TEXT);
    expect(decodeText(utf16be(TEXT))).toBe(TEXT);
    expect(decodeText(Buffer.alloc(0))).toBe('');
    // A lone mark, and a UTF-16 file cut in the middle of a character, are read without throwing.
    expect(decodeText(Buffer.from([0xff, 0xfe]))).toBe('');
    expect(decodeText(Buffer.concat([utf16be('ab'), Buffer.from([0x00])]))).toBe('ab');
  });

  it('leaves the caller\'s bytes as they were', () => {
    const bytes = utf16be(TEXT);
    const before = Buffer.from(bytes);
    decodeText(bytes);
    expect(bytes.equals(before)).toBe(true);
  });
});

describe('replaceFile', () => {
  it('replaces the file and leaves no temporary file behind', async () => {
    const file = join(root, 'record.json');
    await replaceFile(file, 'one\n', 'a');
    await replaceFile(file, 'two\n', 'b');
    expect(await readFile(file, 'utf8')).toBe('two\n');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('gives up cleanly when the target cannot be replaced at all', async () => {
    const missing = join(root, 'no-such-dir', 'record.json');
    await expect(replaceFile(missing, 'x', 'c')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('files a Windows tool wrote', () => {
  it('loads a state file saved with a byte-order mark instead of setting it aside as corrupt', async () => {
    const home = join(root, 'home-bom');
    const first = new FileStateStore(home, { pollMs: 0 });
    await first.update((state) => ({ state: { ...state, settings: { ...state.settings, currency: 'SEK' } }, result: null }));
    first.close();
    const file = join(home, 'state.json');
    await writeFile(file, utf8bom(await readFile(file, 'utf8')));

    const second = new FileStateStore(home, { pollMs: 0 });
    expect((await second.read()).settings.currency).toBe('SEK');
    expect(second.warnings).toEqual([]);
    second.close();
    expect((await readdir(home)).filter((name) => name.includes('corrupt'))).toEqual([]);
  });

  it('reads an environment file that PowerShell wrote as UTF-16', async () => {
    const home = join(root, 'home-env');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.env'), utf16le('TOKENGATOR_PORT=5123\r\nTOKENGATOR_NOTIFY_URL=https://ntfy.example/topic\r\n'));
    expect(loadEnvFile(home)).toEqual({ TOKENGATOR_PORT: '5123', TOKENGATOR_NOTIFY_URL: 'https://ntfy.example/topic' });
  });
});

describe('cliCommand', () => {
  const unixRoot = '/opt/tokengator';
  const entry = `node "${join(unixRoot, 'dist', 'cli', 'main.js')}"`;

  it('uses the short name only for a shim that is on the search path', () => {
    const where = { path: '/usr/local/bin:/usr/bin:/bin', platform: 'linux' as const, root: unixRoot };
    expect(cliCommand('/usr/local/bin/tokengator', where)).toBe('tokengator');
    // Not on the path: whatever runs the snippet later would not find it.
    expect(cliCommand('/home/me/.npm-global/bin/tokengator', where)).toBe(entry);
    expect(cliCommand('/opt/tokengator/dist/cli/main.js', where)).toBe(entry);
    expect(cliCommand('/somewhere/else/vitest.mjs', where)).toBe(entry);
    expect(cliCommand(undefined, where)).toBe(entry);
  });

  it('never trusts a project-local shim, which is on the path only while npm runs a script', () => {
    const bin = '/home/me/project/node_modules/.bin';
    expect(cliCommand(`${bin}/tokengator`, { path: `${bin}:/usr/bin`, platform: 'linux', root: unixRoot })).toBe(entry);
  });

  it('writes a Windows entry point with forward slashes, which every shell there leaves alone', () => {
    const windowsRoot = 'C:\\Users\\jespe\\browsergator\\tokengator';
    const script = win32.join(windowsRoot, 'dist', 'cli', 'main.js');
    const command = cliCommand(script, { path: 'C:\\Windows;C:\\Users\\jespe\\AppData\\Roaming\\npm', platform: 'win32', root: windowsRoot });
    expect(command).not.toContain('\\');
    expect(command.startsWith('node "C:/Users/jespe/browsergator/tokengator')).toBe(true);
    expect(command.endsWith('/dist/cli/main.js"')).toBe(true);
    // A global shim there is found whatever the case of the directory name.
    expect(cliCommand('C:\\Users\\jespe\\AppData\\Roaming\\npm\\tokengator.cmd', { path: 'c:\\users\\jespe\\appdata\\roaming\\npm\\;C:\\Windows', platform: 'win32', root: windowsRoot })).toBe('tokengator');
  });

  it('gives snippets from a Windows path that Git Bash does not mangle', () => {
    const windowsRoot = 'C:\\Users\\jespe\\browsergator\\tokengator';
    const cli = cliCommand(win32.join(windowsRoot, 'dist', 'cli', 'main.js'), { path: '', platform: 'win32', root: windowsRoot });
    const snippets = connectSnippets({ origin: 'http://127.0.0.1:4777', tokenRequired: false, cli });
    for (const id of ['statusline', 'statusline-antigravity', 'claude-stdio', 'copilot-cli']) {
      const code = snippets.find((snippet) => snippet.id === id)?.code ?? '';
      expect(code, id).toContain('C:/Users/jespe/browsergator/tokengator');
      expect(code, id).not.toContain('\\');
    }
    // A path with a space is quoted as one word.
    const spaced = connectSnippets({ origin: 'http://127.0.0.1:4777', tokenRequired: false, cli: 'node "C:/Users/Jesper W/tokengator/dist/cli/main.js"' });
    expect(spaced.find((snippet) => snippet.id === 'claude-stdio')?.code).toContain('-- node "C:/Users/Jesper W/tokengator/dist/cli/main.js" mcp');
  });
});

describe('planSpawn', () => {
  const env = { Path: 'C:\\Program Files\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const present = new Set(['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\npx.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\ccusage.cmd']);
  const exists = (path: string): boolean => present.has(path);

  it('starts the program as it is named everywhere but Windows', () => {
    expect(planSpawn(['bash', '/home/me/.claude/statusline.sh'], 'linux', {})).toEqual({ file: 'bash', args: ['/home/me/.claude/statusline.sh'], verbatim: false });
    expect(planSpawn([], 'linux', {})).toBeNull();
  });

  it('finds a real program on the Windows search path and starts it directly', () => {
    expect(planSpawn(['node', 'line.js'], 'win32', env, exists)).toEqual({ file: 'C:\\Program Files\\nodejs\\node.exe', args: ['line.js'], verbatim: false });
    // Unknown to the search path: started by name, and the failure is reported as "not found".
    expect(planSpawn(['nothing-here'], 'win32', env, exists)).toEqual({ file: 'nothing-here', args: [], verbatim: false });
  });

  it('runs an npm shim through cmd.exe, because nothing else can run a batch file', () => {
    const plan = planSpawn(['npx', '-y', 'ccusage', 'statusline'], 'win32', env, exists);
    expect(plan?.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan?.verbatim).toBe(true);
    expect(plan?.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan?.args[3]).toBe('"C:\\Program^ Files\\nodejs\\npx.cmd ^^^"-y^^^" ^^^"ccusage^^^" ^^^"statusline^^^""');
    expect(planSpawn(['ccusage.cmd'], 'win32', env, exists)?.args[3]).toBe('"C:\\Users\\me\\AppData\\Roaming\\npm\\ccusage.cmd"');
  });

  it('escapes every character cmd.exe would act on, so an argument stays one argument', () => {
    const line = planSpawn(['npx', 'a & calc.exe', '%PATH%', 'say "hi"', 'back\\'], 'win32', env, exists)?.args[3] ?? '';
    // No unescaped ampersand, percent sign or quote survives outside the outer pair.
    const inner = line.slice(1, -1);
    expect(inner).not.toMatch(/(?<!\^)[&%"]/);
    expect(inner).toContain('^^^&');
    expect(inner).toContain('^^^%PATH^^^%');
    // A trailing backslash is doubled so it cannot escape the closing quote.
    expect(inner).toContain('back\\\\^^^"');
  });
});
