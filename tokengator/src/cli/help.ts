// Usage text. One table drives the overview, `tokengator help <command>` and `<command> --help`, so
// a command cannot be listed in one place and forgotten in another.

import { VERSION } from '../server/config.js';
import { columns } from './render.js';

export const PROGRAM = 'tokengator';

interface CommandHelp {
  /** As shown in the overview, with its arguments. */
  synopsis: string;
  summary: string;
  usage: string[];
  options?: [flag: string, meaning: string][];
  notes?: string[];
}

export const COMMAND_HELP: Readonly<Record<string, CommandHelp>> = {
  serve: {
    synopsis: 'serve',
    summary: 'start the dashboard, the API and the MCP endpoint (the default command)',
    usage: [`${PROGRAM} [serve] [--port <n>] [--host <address>] [--demo] [--no-collectors]`],
    options: [
      ['--port <n>', 'port to listen on (default 4777, or TOKENGATOR_PORT)'],
      ['--host <address>', 'address to listen on (default 127.0.0.1, or TOKENGATOR_HOST)'],
      ['--demo', 'serve built-in sample data from memory; nothing is read or saved'],
      ['--no-collectors', 'do not run the automatic sources on a schedule']
    ],
    notes: ['Any address other than loopback needs TOKENGATOR_TOKEN (16 characters or more).']
  },
  status: {
    synopsis: 'status',
    summary: 'the queue in the terminal, most urgent first',
    usage: [`${PROGRAM} status [--json] [--all] [--check] [--no-color]`],
    options: [
      ['--json', 'print the queue as one JSON document (the same as the MCP tool what_to_use)'],
      ['--all', 'also show quiet states, snoozed accounts and rate limits'],
      ['--check', 'exit with 2 when something needs using now, for scripts and prompts'],
      ['--no-color', 'plain text even on a terminal (NO_COLOR does the same)']
    ]
  },
  set: {
    synopsis: 'set <quick entry>',
    summary: 'update a meter in one line',
    usage: [`${PROGRAM} set <account> [meter] <amount> [resets <when>]`],
    notes: [
      'Examples:',
      `  ${PROGRAM} set claude weekly 62% resets thu 09:00`,
      `  ${PROGRAM} set suno 1200 left resets in 9d`,
      `  ${PROGRAM} set copilot 412/1500`,
      'A bare amount means used. The answer spells out both used and left.'
    ]
  },
  add: {
    synopsis: 'add [<provider>]',
    summary: 'add a subscription from the catalog',
    usage: [`${PROGRAM} add <provider> [--plan <plan>] [--label <name>] [--billing-day <1-31>]`, `${PROGRAM} add --list`],
    options: [
      ['--list', 'show the providers and plans the catalog knows (also shown when no provider is given)'],
      ['--plan <plan>', 'plan id or name; the first plan when omitted'],
      ['--label <name>', 'what to call the account'],
      ['--billing-day <1-31>', 'day of the month the plan renews, for quotas that follow your billing cycle']
    ]
  },
  mcp: {
    synopsis: 'mcp',
    summary: 'run the MCP server on stdio',
    usage: [`${PROGRAM} mcp`],
    notes: ['Reads the same state file as the dashboard, and works when the dashboard is not running.']
  },
  statusline: {
    synopsis: 'statusline',
    summary: 'status line command for Claude Code and the Antigravity CLI',
    usage: [`${PROGRAM} statusline   (reads the JSON the tool pipes in, prints one line)`],
    notes: ['Records the rate-limit windows it is handed. Always exits 0 and always prints a line.']
  },
  collectors: {
    synopsis: 'collectors',
    summary: 'list, switch on or off, or run the automatic sources',
    usage: [
      `${PROGRAM} collectors [list]`,
      `${PROGRAM} collectors enable <id>`,
      `${PROGRAM} collectors disable <id>`,
      `${PROGRAM} collectors run [<id>]`
    ],
    notes: ['Keys are read from the environment or from .env in the Tokengator home, and are never stored or printed.']
  },
  notify: {
    synopsis: 'notify',
    summary: 'raise reminders that are due, once, for a scheduler',
    usage: [`${PROGRAM} notify [--dry-run] [--test] [--no-desktop]`],
    options: [
      ['--dry-run', 'print what is due; send and record nothing'],
      ['--test', 'send a test message through every route that is set up'],
      ['--no-desktop', 'post to the address only, for a machine without a desktop']
    ],
    notes: [
      'Raises a notification on this computer, and posts to TOKENGATOR_NOTIFY_URL when it is set.',
      'Each quota is raised once per window. Exits 1 when something was due and could not be delivered.'
    ]
  },
  calendar: {
    synopsis: 'calendar',
    summary: 'the coming resets as an iCalendar document',
    usage: [`${PROGRAM} calendar [--days <n>] > resets.ics`],
    options: [['--days <n>', 'how far ahead to list resets (default 62)']]
  },
  connect: {
    synopsis: 'connect',
    summary: 'connection snippets for MCP clients on this machine',
    usage: [`${PROGRAM} connect [--stdio] [--client <id>]`],
    options: [
      ['--stdio', 'only the stdio variants, which work without the dashboard running'],
      ['--client <id>', 'only snippets whose id matches; a single match prints just its code']
    ]
  },
  skill: {
    synopsis: 'skill install|uninstall',
    summary: 'install or remove the agent skill for the agent clients on this machine',
    usage: [`${PROGRAM} skill install [--dry-run] [--all] [--only=<a,b>]`, `${PROGRAM} skill uninstall [--dry-run] [--only=<a,b>]`],
    options: [
      ['--dry-run', 'show what would change and write nothing'],
      ['--all', 'also install for clients that are not set up on this machine yet'],
      ['--only=<a,b>', 'limit to these clients: claude, kiro, codex, gemini, copilot, cursor, windsurf, opencode']
    ],
    notes: ['Instruction files get one delimited block. Text outside that block is never changed.']
  },
  export: {
    synopsis: 'export',
    summary: 'print the whole state as JSON',
    usage: [`${PROGRAM} export > backup.json`]
  },
  import: {
    synopsis: 'import <file>',
    summary: 'replace the state with an exported document',
    usage: [`${PROGRAM} import <file>`, `${PROGRAM} import -   (read standard input)`],
    notes: ['The document is validated first. Nothing changes when it is not valid.']
  },
  doctor: {
    synopsis: 'doctor',
    summary: 'paths, configuration and sources as this machine sees them',
    usage: [`${PROGRAM} doctor`]
  }
};

export function usage(): string {
  const rows = Object.values(COMMAND_HELP).map((command) => [command.synopsis, command.summary]);
  rows.push(['help [command]', 'this text, or the options of one command']);
  return [
    `Tokengator ${VERSION}: use prepaid AI quota before it resets.`,
    '',
    `Usage: ${PROGRAM} <command> [options]`,
    '',
    ...columns(rows, 3, 2),
    '',
    ...columns(
      [
        ['-h, --help', 'show help'],
        ['-v, --version', 'print the version']
      ],
      3,
      2
    ),
    '',
    'Environment: TOKENGATOR_HOME, TOKENGATOR_HOST, TOKENGATOR_PORT, TOKENGATOR_TOKEN, TOKENGATOR_LOG.',
    ''
  ].join('\n');
}

/** Help for one command, or null when there is no such command. */
export function commandUsage(name: string): string | null {
  // Own entries only: "constructor" and its kind are not commands.
  const command = Object.hasOwn(COMMAND_HELP, name) ? COMMAND_HELP[name] : undefined;
  if (!command) return null;
  const lines = [`${PROGRAM} ${name}: ${command.summary}`, '', 'Usage:', ...command.usage.map((line) => `  ${line}`)];
  if (command.options && command.options.length > 0) lines.push('', 'Options:', ...columns(command.options, 3, 2));
  if (command.notes && command.notes.length > 0) lines.push('', ...command.notes);
  lines.push('');
  return lines.join('\n');
}
