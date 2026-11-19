// How `tokengator statusline -- <command>` starts the command a person already had.
//
// The words after "--" are a program and its arguments, as the calling shell split them, and they are
// started without a shell. Windows needs more than that: most command-line tools installed with npm are
// batch files (`npx.cmd`, `ccusage.cmd`), which only cmd.exe can run and which Node refuses to start
// directly. For those the command line for cmd.exe is built here, with every word escaped so that cmd
// reads it as one word and as nothing else.

import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface SpawnPlan {
  file: string;
  args: string[];
  /** The arguments are already one finished command line and must reach the program untouched. */
  verbatim: boolean;
}

/** A variable of a Windows environment, whatever case its name was stored in. */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The file Windows would run for `program`: itself when it names a path, otherwise the first match on the
 * search path with one of the executable extensions. The current directory is deliberately not searched.
 */
function resolveOnWindows(program: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null {
  const extensions = (variable(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const named = extensions.some((extension) => program.toLowerCase().endsWith(extension.toLowerCase()));
  const candidates = (base: string): string[] => (named ? [base] : extensions.map((extension) => base + extension.toLowerCase()));
  if (/[\\/]/.test(program)) return candidates(program).find(exists) ?? null;
  for (const dir of (variable(env, 'PATH') ?? '').split(';').filter(Boolean)) {
    const found = candidates(win32.join(dir, program)).find(exists);
    if (found) return found;
  }
  return null;
}

// Characters cmd.exe gives a meaning to. A caret in front takes the meaning away.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument as cmd.exe must be given it: quoted the way the program's own argument parser expects
 * (backslashes before a quote doubled, the quote escaped), then every cmd metacharacter escaped. A batch
 * file hands its arguments to cmd a second time, hence the second round.
 */
function cmdArgument(argument: string): string {
  const quoted = `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** How to start `command` on `platform`, or null when it names no program. */
export function planSpawn(
  command: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync
): SpawnPlan | null {
  const [program, ...args] = command;
  if (!program) return null;
  if (platform !== 'win32') return { file: program, args, verbatim: false };
  const target = resolveOnWindows(program, env, exists) ?? program;
  if (!/\.(cmd|bat)$/i.test(target)) return { file: target, args, verbatim: false };
  const line = [target.replace(CMD_META, '^$1'), ...args.map(cmdArgument)].join(' ');
  return { file: variable(env, 'COMSPEC') ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}
