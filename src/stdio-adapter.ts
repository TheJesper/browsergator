import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ADAPTER_INSTRUCTIONS =
  'Transport-only bridge to the shared Browser Gateway. Pass explicit pageId, agentId, taskId, and leaseOwnerId on every applicable call. MCP client sessions are transport lifecycles, not agent identities. This adapter never starts, owns, or connects directly to Chrome.';

export interface StdioAdapterOptions {
  endpoint: URL;
  token: string;
}

export async function runStdioAdapter(options = optionsFromEnvironment()): Promise<void> {
  assertLoopbackHttp(options.endpoint);
  if (!options.token) throw new Error('BROWSER_GATEWAY_TOKEN is required');

  const upstreamTransport = new StreamableHTTPClientTransport(options.endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } }
  });
  const upstream = new Client({ name: 'browser-gateway-stdio-adapter', version: '0.2.0' });
  await upstream.connect(upstreamTransport);

  const server = new Server(
    { name: 'browser-gateway-stdio-adapter', version: '0.2.0' },
    { capabilities: { tools: {} }, instructions: ADAPTER_INSTRUCTIONS }
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    upstream.listTools(request.params)
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstream.callTool(request.params)
  );
  server.onclose = () => {
    void upstream.close().catch((error) => writeError(error));
  };

  const stdio = new StdioServerTransport();
  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    await upstream.close().catch(() => undefined);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await server.connect(stdio);
}

function optionsFromEnvironment(): StdioAdapterOptions {
  return {
    endpoint: new URL(process.env['BROWSER_GATEWAY_URL'] ?? 'http://127.0.0.1:8788/mcp'),
    token: process.env['BROWSER_GATEWAY_TOKEN'] ?? ''
  };
}

function assertLoopbackHttp(endpoint: URL): void {
  const host = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error('BROWSER_GATEWAY_URL must be a loopback HTTP URL');
  }
  if (endpoint.pathname !== '/mcp') throw new Error('BROWSER_GATEWAY_URL must target the /mcp endpoint');
}

function writeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[browser-gateway-stdio-adapter] ${message}\n`);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  runStdioAdapter().catch((error) => {
    writeError(error);
    process.exitCode = 1;
  });
}
