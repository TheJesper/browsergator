import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { BrowserGateway } from '../src/gateway.js';
import { MemoryAuditLog } from '../src/core/audit-log.js';
import { GatewayHttpServer } from '../src/http/server.js';
import { MockBrowserDriver, mockTab } from './helpers/mock-browser-driver.js';
import { testConfig } from './helpers/config.js';

describe('stateless stdio adapter', () => {
  const config = testConfig();
  let gateway: BrowserGateway;
  let http: GatewayHttpServer;
  let client: Client | undefined;

  beforeEach(async () => {
    gateway = new BrowserGateway(
      config,
      new MockBrowserDriver([mockTab('p1')]),
      new MemoryAuditLog()
    );
    await gateway.start();
    http = new GatewayHttpServer(gateway, config);
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await http.close();
    await gateway.stop();
  });

  it('forwards stdio tool discovery and calls to the shared HTTP gateway', async () => {
    const address = await http.listen(0);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/stdio-adapter.ts'],
      cwd: process.cwd(),
      env: {
        ...stringEnvironment(),
        BROWSER_GATEWAY_URL: `http://${address.host}:${address.port}/mcp`,
        BROWSER_GATEWAY_TOKEN: config.token
      },
      stderr: 'pipe'
    });
    client = new Client({ name: 'stdio-adapter-test', version: '1.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'navigate')).toBe(true);
    const result = await client.callTool({
      name: 'navigate',
      arguments: {
        pageId: 'p1',
        url: 'https://adapter.example/',
        agentId: 'adapter-agent',
        taskId: 'adapter-task',
        leaseOwnerId: 'adapter-owner'
      }
    });
    expect(result.isError).not.toBe(true);
  }, 15_000);
});

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
