import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { BrowserGateway } from '../src/gateway.js';
import { MemoryAuditLog } from '../src/core/audit-log.js';
import { GatewayHttpServer } from '../src/http/server.js';
import { MockBrowserDriver, mockTab } from './helpers/mock-browser-driver.js';
import { testConfig } from './helpers/config.js';

describe('Streamable HTTP MCP singleton', () => {
  const config = testConfig();
  let driver: MockBrowserDriver;
  let gateway: BrowserGateway;
  let http: GatewayHttpServer;
  let endpoint: URL;
  const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];

  beforeEach(async () => {
    driver = new MockBrowserDriver([mockTab('p1'), mockTab('p2')]);
    driver.navigationDelayMs = 50;
    gateway = new BrowserGateway(config, driver, new MemoryAuditLog());
    await gateway.start();
    http = new GatewayHttpServer(gateway, config);
    const address = await http.listen(0);
    endpoint = new URL(`http://${address.host}:${address.port}/mcp`);
  });

  afterEach(async () => {
    for (const { client } of clients.splice(0)) await client.close().catch(() => undefined);
    await http.close();
    await gateway.stop();
  });

  it('rejects missing auth and reports readiness', async () => {
    const ready = await fetch(new URL('/readyz', endpoint));
    expect(ready.status).toBe(200);
    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    expect(unauthorized.status).toBe(401);
  });

  it('lets two independent MCP clients mutate different tabs concurrently', async () => {
    const first = await connectClient('first');
    const second = await connectClient('second');

    const [one, two] = await Promise.all([
      first.client.callTool({
        name: 'navigate',
        arguments: {
          pageId: 'p1',
          url: 'https://one.example/',
          agentId: 'agent-a',
          taskId: 'task-a',
          leaseOwnerId: 'owner-a'
        }
      }),
      second.client.callTool({
        name: 'navigate',
        arguments: {
          pageId: 'p2',
          url: 'https://two.example/',
          agentId: 'agent-b',
          taskId: 'task-b',
          leaseOwnerId: 'owner-b'
        }
      })
    ]);
    expect(one.isError).not.toBe(true);
    expect(two.isError).not.toBe(true);
    expect(driver.maxActiveGlobal).toBe(2);
  });

  it('exposes one-call rendered fetch with a content receipt', async () => {
    const client = await connectClient('fetcher');
    const html = '<html><body><main>Rendered</main></body></html>';
    driver.defaultEvaluateResult = { url: 'https://fetch.example/menu', title: 'Menu', html };
    const result = await client.client.callTool({
      name: 'fetch_rendered_page',
      arguments: {
        url: 'https://fetch.example/menu',
        maxBytes: 2_000,
        agentId: 'agent-fetch',
        taskId: 'task-fetch',
        leaseOwnerId: 'lease-fetch'
      }
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      requestedUrl: 'https://fetch.example/menu',
      finalUrl: 'https://fetch.example/menu',
      html,
      contentBytes: Buffer.byteLength(html)
    });
    expect((await gateway.listTabs()).map((tab) => tab.pageId)).toEqual(['p1', 'p2']);
  });

  it('exposes explicit browser context and new-window lifecycle tools', async () => {
    const client = await connectClient('contexts');
    const created = await client.client.callTool({
      name: 'create_browser_context',
      arguments: { owner: 'agent-context', agentId: 'agent-context', taskId: 'context-task', leaseOwnerId: 'context-owner', ttlMs: 10_000 }
    });
    expect(created.isError).not.toBe(true);
    const context = created.structuredContent as { browserContextId: string };
    const opened = await client.client.callTool({
      name: 'open_tab',
      arguments: {
        url: 'about:blank', browserContextId: context.browserContextId, newWindow: true,
        agentId: 'agent-context', taskId: 'context-task', leaseOwnerId: 'context-owner'
      }
    });
    expect(opened.isError).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({ browserContextId: context.browserContextId, windowId: 1 });
    const disposed = await client.client.callTool({
      name: 'dispose_browser_context',
      arguments: {
        browserContextId: context.browserContextId,
        agentId: 'agent-context', taskId: 'context-task', leaseOwnerId: 'context-owner'
      }
    });
    expect(disposed.isError).not.toBe(true);
    expect(disposed.structuredContent).toMatchObject({ disposed: true });
  });

  it('serializes two MCP clients on the same tab and cleans session leases', async () => {
    const first = await connectClient('first');
    const second = await connectClient('second');

    await Promise.all([
      first.client.callTool({
        name: 'navigate',
        arguments: {
          pageId: 'p1',
          url: 'https://first.example/',
          agentId: 'agent-a',
          taskId: 'task-a',
          leaseOwnerId: 'owner-a'
        }
      }),
      second.client.callTool({
        name: 'navigate',
        arguments: {
          pageId: 'p1',
          url: 'https://second.example/',
          agentId: 'agent-b',
          taskId: 'task-b',
          leaseOwnerId: 'owner-b'
        }
      })
    ]);
    expect(driver.maxActiveByPage.get('p1')).toBe(1);

    const claim = await first.client.callTool({
      name: 'claim_tab',
      arguments: {
        pageId: 'p1',
        agentId: 'agent-a',
        taskId: 'task-a',
        leaseOwnerId: 'owner-a'
      }
    });
    expect(claim.isError).not.toBe(true);
    expect(gateway.leases.get('p1')).toBeDefined();
    await first.transport.terminateSession();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.leases.get('p1')).toBeUndefined();
  });

  it('separates subagent lease ownership from MCP client sessions', async () => {
    const first = await connectClient('shared-client');
    const second = await connectClient('reconnected-client');
    const logicalOwner = {
      pageId: 'p1',
      agentId: 'subagent-a',
      taskId: 'task-a',
      leaseOwnerId: 'owner-a'
    };

    const claim = await first.client.callTool({ name: 'claim_tab', arguments: logicalOwner });
    expect(claim.isError).not.toBe(true);
    const foreignSubagent = await first.client.callTool({
      name: 'navigate',
      arguments: {
        ...logicalOwner,
        agentId: 'subagent-b',
        leaseOwnerId: 'owner-b',
        url: 'https://blocked.example/'
      }
    });
    expect(foreignSubagent.isError).toBe(true);

    const renewed = await second.client.callTool({ name: 'claim_tab', arguments: logicalOwner });
    expect(renewed.isError).not.toBe(true);
    await first.transport.terminateSession();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.leases.get('p1')?.clientSessionId).toBe(second.transport.sessionId);

    await second.transport.terminateSession();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.leases.get('p1')).toBeUndefined();
  });

  async function connectClient(name: string): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
  }> {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } }
    });
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(transport);
    const pair = { client, transport };
    clients.push(pair);
    return pair;
  }
});
