// Installs the agent skill machine-wide. Agent clients come in two shapes:
//
//   skill-directory clients    get a copy of skill/SKILL.md in their skills directory
//   instruction-file clients   get the same text as a delimited block in their global instruction file
//
// The block is the only part of an instruction file this module ever touches: installing replaces what
// is between the markers, uninstalling removes it, and the person's own text is left exactly as it was.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SKILL_NAME = 'tokengator';
export const BLOCK_BEGIN = '<!-- BEGIN TOKENGATOR (managed by tokengator skill install) -->';
export const BLOCK_END = '<!-- END TOKENGATOR -->';

export interface SkillInstallOptions {
  /** The user's home directory, where agent clients keep their configuration. */
  home: string;
  /** The package root, which holds skill/SKILL.md. */
  packageRoot: string;
  /** Report what would change and write nothing. */
  dryRun?: boolean;
  /** Also install into clients that are not present on this machine yet. */
  all?: boolean;
  /** Limit the run to these client ids. */
  only?: string[];
  uninstall?: boolean;
}

/** The note on a client that was left alone because it is not set up on this machine. */
export const NOTE_NOT_SET_UP = 'Not set up on this machine. Use --all to install anyway.';
/** The note on a client that had nothing of ours to remove. */
export const NOTE_NOT_INSTALLED = 'Not installed.';

export interface SkillAction {
  client: string;
  path: string;
  action: 'write' | 'update' | 'unchanged' | 'remove' | 'skip';
  note?: string;
}

interface Client {
  id: string;
  kind: 'skills' | 'instructions';
  /** The client's own directory. Its presence is how an installed client is recognised. */
  root: string;
  /** The skill directory, or the instruction file. */
  target: string;
}

function clients(home: string): Client[] {
  const skills = (id: string, ...root: string[]): Client => ({
    id,
    kind: 'skills',
    root: join(home, ...root),
    target: join(home, ...root, 'skills', SKILL_NAME)
  });
  const instructions = (id: string, root: string[], file: string[]): Client => ({
    id,
    kind: 'instructions',
    root: join(home, ...root),
    target: join(home, ...root, ...file)
  });
  return [
    skills('claude', '.claude'),
    // The shared Agent Skills directory, read by Codex, Copilot CLI, Cursor, Zed, opencode and Goose.
    skills('agents', '.agents'),
    skills('antigravity', '.gemini', 'config'),
    skills('kiro', '.kiro'),
    instructions('codex', ['.codex'], ['AGENTS.md']),
    instructions('gemini', ['.gemini'], ['GEMINI.md']),
    instructions('copilot', ['.copilot'], ['copilot-instructions.md']),
    instructions('cursor', ['.cursor'], ['rules', `${SKILL_NAME}.md`]),
    instructions('windsurf', ['.windsurf'], ['rules', `${SKILL_NAME}.md`]),
    instructions('opencode', ['.config', 'opencode'], ['AGENTS.md'])
  ];
}

/** Ids accepted by `only`. */
export const SKILL_CLIENT_IDS: readonly string[] = clients('').map((client) => client.id);

/** The skill text without its YAML front matter, which only skill-directory clients understand. */
export function skillBody(skill: string): string {
  const text = skill.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

export function managedBlock(skill: string): string {
  return `${BLOCK_BEGIN}\n${skillBody(skill)}\n${BLOCK_END}`;
}

interface BlockSpan {
  start: number;
  /** Just past the end marker. */
  end: number;
}

/** Where the block sits, null when there is none, or 'broken' when a begin marker has no end after it. */
function findBlock(text: string): BlockSpan | 'broken' | null {
  const start = text.indexOf(BLOCK_BEGIN);
  if (start < 0) return null;
  const end = text.indexOf(BLOCK_END, start + BLOCK_BEGIN.length);
  if (end < 0) return 'broken';
  return { start, end: end + BLOCK_END.length };
}

/**
 * Appending always leaves exactly one blank line between the person's text and the block. Removing
 * takes that one blank line away again, so install followed by uninstall gives back the original text
 * (plus a final newline, when the original had none).
 */
function withBlock(existing: string, block: string, span: BlockSpan | null): string {
  if (span) return existing.slice(0, span.start) + block + existing.slice(span.end);
  if (existing === '') return `${block}\n`;
  return `${existing}${existing.endsWith('\n') ? '' : '\n'}\n${block}\n`;
}

function withoutBlock(existing: string, span: BlockSpan): string {
  let before = existing.slice(0, span.start);
  let after = existing.slice(span.end).replace(/^\r?\n/, '');
  if (/\r?\n\r?\n$/.test(before)) before = before.replace(/\r?\n$/, '');
  if (before === '') after = after.replace(/^(?:\r?\n)+/, '');
  return before + after;
}

function read(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function installOne(client: Client, skill: string, dryRun: boolean): SkillAction {
  if (client.kind === 'skills') {
    const path = join(client.target, 'SKILL.md');
    const existing = read(path);
    if (existing === skill) return { client: client.id, path, action: 'unchanged' };
    if (!dryRun) write(path, skill);
    return { client: client.id, path, action: existing === null ? 'write' : 'update' };
  }

  const path = client.target;
  const existing = read(path);
  const span = existing === null ? null : findBlock(existing);
  if (span === 'broken') {
    // Guessing where a half-deleted block ends could cut into the person's own text.
    return { client: client.id, path, action: 'skip', note: 'Found a begin marker without its end marker. Remove the leftover marker by hand and run this again.' };
  }
  const next = withBlock(existing ?? '', managedBlock(skill), span);
  if (next === existing) return { client: client.id, path, action: 'unchanged' };
  if (!dryRun) write(path, next);
  return { client: client.id, path, action: existing === null ? 'write' : 'update' };
}

function uninstallOne(client: Client, dryRun: boolean): SkillAction {
  const path = client.target;
  if (client.kind === 'skills') {
    // Only the one file the installer writes is removed. Anything else in that directory was put there
    // by the person, and a directory of theirs that happens to share the name is not touched at all.
    const file = join(path, 'SKILL.md');
    const installed = read(file);
    if (installed === null) return { client: client.id, path, action: 'skip', note: NOTE_NOT_INSTALLED };
    if (!/^name:\s*tokengator\s*$/m.test(installed.slice(0, 400))) {
      return { client: client.id, path, action: 'skip', note: 'The SKILL.md there is not Tokengator\'s, so it was left alone.' };
    }
    let emptied: boolean;
    if (!dryRun) {
      rmSync(file, { force: true });
      try {
        // Succeeds only when nothing else is in it.
        rmdirSync(path);
        emptied = true;
      } catch {
        emptied = false;
      }
    } else {
      emptied = readdirSync(path).length === 1;
    }
    return emptied
      ? { client: client.id, path, action: 'remove' }
      : { client: client.id, path: file, action: 'remove', note: 'Other files in that directory are yours and were kept.' };
  }

  const existing = read(path);
  const span = existing === null ? null : findBlock(existing);
  if (existing === null || span === null) return { client: client.id, path, action: 'skip', note: NOTE_NOT_INSTALLED };
  if (span === 'broken') {
    return { client: client.id, path, action: 'skip', note: 'Found a begin marker without its end marker. Remove it by hand.' };
  }
  const next = withoutBlock(existing, span);
  // A file that is exactly what the installer writes into an empty place was created by the installer,
  // so it goes with the block. Any other file is the person's and stays, however little is left in it:
  // a file that held only blank lines before is given back with its blank lines.
  const ours = next === '';
  if (!dryRun) {
    if (ours) rmSync(path, { force: true });
    else writeFileSync(path, next, 'utf8');
  }
  return { client: client.id, path, action: 'remove', note: ours ? 'The file held nothing else and was deleted.' : 'Block removed; the rest of the file is untouched.' };
}

export function installSkill(options: SkillInstallOptions): { actions: SkillAction[] } {
  const dryRun = options.dryRun === true;
  const only = options.only?.map((id) => id.trim().toLowerCase()).filter(Boolean) ?? [];
  const known = clients(options.home);
  const actions: SkillAction[] = [];

  for (const id of only) {
    if (!known.some((client) => client.id === id)) {
      actions.push({ client: id, path: '', action: 'skip', note: `Unknown client. Known: ${known.map((client) => client.id).join(', ')}.` });
    }
  }
  const selected = known.filter((client) => only.length === 0 || only.includes(client.id));

  // One client's read-only or oddly shaped directory must not stop the others from being handled.
  const guarded = (client: Client, work: () => SkillAction): SkillAction => {
    try {
      return work();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { client: client.id, path: client.target, action: 'skip', note: `Could not be changed${code ? ` (${code})` : ''}.` };
    }
  };

  if (options.uninstall) {
    for (const client of selected) actions.push(guarded(client, () => uninstallOne(client, dryRun)));
    return { actions };
  }

  const source = join(options.packageRoot, 'skill', 'SKILL.md');
  const skill = read(source);
  if (skill === null) throw new Error(`The skill file is missing: ${source}`);

  for (const client of selected) {
    if (!options.all && !existsSync(client.root)) {
      actions.push({ client: client.id, path: client.target, action: 'skip', note: NOTE_NOT_SET_UP });
      continue;
    }
    actions.push(guarded(client, () => installOne(client, skill, dryRun)));
  }
  return { actions };
}
