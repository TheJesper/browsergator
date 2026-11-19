// Ready-to-copy connection snippets. One source for the dashboard's Connect panel, `tokengator connect`
// and the docs, so the three cannot disagree.

export interface ConnectOptions {
  /** Base address of the running service, for example http://127.0.0.1:4777 */
  origin: string;
  /** How to invoke the CLI on this machine: `tokengator`, or `node "/abs/path/dist/cli/main.js"`. */
  cli: string;
  /** True when the service requires TOKENGATOR_TOKEN. Snippets then reference the variable, never its value. */
  tokenRequired: boolean;
}

export interface ConnectSnippet {
  id: string;
  group: 'mcp-http' | 'mcp-stdio' | 'statusline' | 'skill' | 'cli';
  title: string;
  /** One sentence on when to use it. */
  description: string;
  language: 'shell' | 'json' | 'toml';
  code: string;
}

const NAME = 'tokengator';

function splitCli(cli: string): { command: string; args: string[] } {
  const parts = cli.match(/"[^"]*"|\S+/g) ?? [cli];
  const [command, ...args] = parts.map((part) => part.replace(/^"|"$/g, ''));
  return { command: command ?? cli, args };
}

export function connectSnippets(options: ConnectOptions): ConnectSnippet[] {
  const url = `${options.origin.replace(/\/+$/, '')}/mcp`;
  const auth = options.tokenRequired;
  const { command, args } = splitCli(options.cli);
  const stdioArgs = [...args, 'mcp'];
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const header = { Authorization: 'Bearer ${TOKENGATOR_TOKEN}' };

  const snippets: ConnectSnippet[] = [
    {
      id: 'claude-code',
      group: 'mcp-http',
      title: 'Claude Code',
      description: 'Registers this dashboard for every Claude Code session on this machine.',
      language: 'shell',
      code: auth
        ? `claude mcp add-json --scope user ${NAME} '${JSON.stringify({ type: 'http', url, headers: header })}'`
        : `claude mcp add --transport http --scope user ${NAME} ${url}`
    },
    {
      id: 'codex',
      group: 'mcp-http',
      title: 'Codex',
      description: 'Shared by the Codex CLI, desktop app and IDE extension.',
      language: 'shell',
      code: auth
        ? `codex mcp add ${NAME} --url ${url} --bearer-token-env-var TOKENGATOR_TOKEN`
        : `codex mcp add ${NAME} --url ${url}`
    },
    {
      id: 'codex-toml',
      group: 'mcp-http',
      title: 'Codex (config.toml)',
      description: 'The same entry written by hand in ~/.codex/config.toml.',
      language: 'toml',
      code: [`[mcp_servers.${NAME}]`, `url = "${url}"`, ...(auth ? ['bearer_token_env_var = "TOKENGATOR_TOKEN"'] : [])].join('\n')
    },
    {
      id: 'gemini',
      group: 'mcp-http',
      title: 'Gemini CLI',
      description: 'User-scope entry for the Gemini CLI.',
      language: 'shell',
      code: auth
        ? `gemini mcp add --transport http --scope user --header 'Authorization: Bearer \${TOKENGATOR_TOKEN}' ${NAME} ${url}`
        : `gemini mcp add --transport http --scope user ${NAME} ${url}`
    },
    {
      id: 'cursor',
      group: 'mcp-http',
      title: 'Cursor and other mcpServers clients',
      description: 'For ~/.cursor/mcp.json, a project .mcp.json, or any client that reads an mcpServers map.',
      language: 'json',
      code: json({ mcpServers: { [NAME]: auth ? { type: 'http', url, headers: header } : { type: 'http', url } } })
    },
    {
      id: 'vscode',
      group: 'mcp-http',
      title: 'VS Code',
      description: 'For .vscode/mcp.json or the user-level MCP configuration.',
      language: 'json',
      code: json({ servers: { [NAME]: auth ? { type: 'http', url, headers: header } : { type: 'http', url } } })
    },
    {
      id: 'stdio-json',
      group: 'mcp-stdio',
      title: 'Any stdio client',
      description: 'Works without the dashboard running: the stdio server reads the same state file.',
      language: 'json',
      code: json({ mcpServers: { [NAME]: { command, args: stdioArgs } } })
    },
    {
      id: 'copilot-cli',
      group: 'mcp-stdio',
      title: 'GitHub Copilot CLI',
      description: 'Copilot CLI is most reliable over stdio.',
      language: 'shell',
      code: `copilot mcp add ${NAME} -- ${[command, ...stdioArgs].map(quote).join(' ')}`
    },
    {
      id: 'claude-stdio',
      group: 'mcp-stdio',
      title: 'Claude Code (stdio)',
      description: 'Use this instead of HTTP when the dashboard is not always running.',
      language: 'shell',
      code: `claude mcp add --scope user ${NAME} -- ${[command, ...stdioArgs].map(quote).join(' ')}`
    },
    {
      id: 'statusline',
      group: 'statusline',
      title: 'Claude Code status line',
      description:
        'Add to ~/.claude/settings.json. Claude Code then feeds its own rate-limit data to Tokengator on every turn, with no credentials involved.',
      language: 'json',
      code: json({ statusLine: { type: 'command', command: [command, ...args, 'statusline'].map(quote).join(' ') } })
    },
    {
      id: 'statusline-antigravity',
      group: 'statusline',
      title: 'Antigravity status line',
      description: 'Add to ~/.gemini/antigravity-cli/settings.json. The Antigravity CLI hands over its 5-hour and weekly quota the same way.',
      language: 'json',
      code: json({ statusLine: { type: 'command', command: [command, ...args, 'statusline'].map(quote).join(' ') } })
    },
    {
      id: 'skill',
      group: 'skill',
      title: 'Agent skill',
      description: 'Teaches every agent client on this machine when and how to consult Tokengator.',
      language: 'shell',
      code: `${options.cli} skill install`
    },
    {
      id: 'cli-status',
      group: 'cli',
      title: 'Terminal status',
      description: 'The same queue in a terminal, or as JSON for scripts.',
      language: 'shell',
      code: `${options.cli} status\n${options.cli} status --json`
    },
    {
      id: 'cli-set',
      group: 'cli',
      title: 'Update from the terminal',
      description: 'The quick-entry line works on the command line too.',
      language: 'shell',
      code: `${options.cli} set claude weekly 62% resets thu 09:00`
    }
  ];
  return snippets;
}

function quote(part: string): string {
  return /[\s"']/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part;
}

export const CONNECT_GROUP_LABEL: Record<ConnectSnippet['group'], string> = {
  'mcp-http': 'MCP over HTTP',
  'mcp-stdio': 'MCP over stdio',
  statusline: 'Automatic readings',
  skill: 'Skill',
  cli: 'Command line'
};
