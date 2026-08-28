import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { WebSocketCdpDriver } from '../src/cdp/websocket-cdp-driver.js';
import type { GatewayConfig } from '../src/config.js';
import { MemoryAuditLog } from '../src/core/audit-log.js';
import { BrowserGateway } from '../src/gateway.js';
import { GatewayHttpServer } from '../src/http/server.js';

await main();

async function main(): Promise<void> {
  const remoteEndpoint = process.env['BROWSER_GATEWAY_SMOKE_ENDPOINT'];
  if (remoteEndpoint) {
    const token = process.env['BROWSER_GATEWAY_TOKEN'];
    if (!token) throw new Error('BROWSER_GATEWAY_TOKEN is required for a remote smoke endpoint');
    await runSmoke(new URL(remoteEndpoint), token);
    return;
  }

  const token = randomBytes(32).toString('base64url');
  const config: GatewayConfig = {
    host: '127.0.0.1',
    port: 8788,
    browserUrl: process.env['BROWSER_GATEWAY_BROWSER_URL'] ?? 'http://127.0.0.1:9222',
    token,
    leaseTtlMs: 15_000,
    maxLeaseTtlMs: 60_000,
    eventBufferSize: 500,
    maxResponseBodyBytes: 1_048_576,
    protectedPatterns: ['*/login*', '*/signin*', '*/auth*', '*/checkout*'],
    protectedAgents: [],
    dataDir: resolve(process.cwd(), '.tmp', 'live-smoke')
  };
  assertLoopback(new URL(config.browserUrl));
  const driver = new WebSocketCdpDriver(config.browserUrl);
  const gateway = new BrowserGateway(config, driver, new MemoryAuditLog());
  const http = new GatewayHttpServer(gateway, config);
  try {
    await gateway.start();
    if (!driver.status().connected) throw new Error('Live CDP driver did not connect');
    const address = await http.listen(0);
    await runSmoke(new URL(`http://${address.host}:${address.port}/mcp`), token);
  } finally {
    await http.close().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
  }
}

async function runSmoke(endpoint: URL, token: string): Promise<void> {
  assertLoopback(endpoint);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  const client = new Client({ name: 'browser-gateway-live-smoke', version: '0.2.0' });
  const agentId = 'browser-gateway-live-smoke';
  const taskId = `smoke-${Date.now()}`;
  const leaseOwnerId = `${agentId}:${taskId}`;
  let createdPageId: string | undefined;

  try {
    await client.connect(transport);
    const before = await call(client, 'list_tabs', { agentId });
    const beforeIds = itemArray(before).map((item) => String(item['pageId']));

    const opened = await call(client, 'open_tab', {
      url: 'https://example.com/',
      agentId,
      taskId,
      leaseOwnerId,
      idempotencyKey: `${taskId}-open`
    });
    createdPageId = String(opened['pageId']);
    if (!createdPageId || beforeIds.includes(createdPageId)) {
      throw new Error('Gateway did not return a distinct newly created pageId');
    }

    await call(client, 'run_atomic', {
      pageId: createdPageId,
      agentId,
      taskId,
      leaseOwnerId,
      idempotencyKey: `${taskId}-atomic`,
      action: {
        type: 'navigate',
        url: `https://example.com/?browser-gateway-smoke=${Date.now()}`,
        waitUntil: 'load',
        timeoutMs: 15_000
      },
      verify: { urlContains: 'example.com', titleContains: 'Example Domain' }
    });
    await call(client, 'snapshot', { pageId: createdPageId, maxNodes: 100 });
    await call(client, 'screenshot', { pageId: createdPageId, format: 'png' });
    await call(client, 'console_list', { pageId: createdPageId, limit: 20 });
    const network = await call(client, 'network_list', { pageId: createdPageId, limit: 50 });
    const networkItems = itemArray(network);
    const observedRequestIds = new Set(
      networkItems
        .filter((event) => event['method'] === 'Network.requestWillBeSent')
        .map((event) => (event['data'] as Record<string, unknown> | undefined)?.['requestId'])
        .filter((requestId): requestId is string => typeof requestId === 'string')
    );
    const documentResponse = networkItems.findLast((event) => {
      const data = event['data'];
      return (
        event['method'] === 'Network.responseReceived' &&
        data !== null &&
        typeof data === 'object' &&
        (data as Record<string, unknown>)['type'] === 'Document' &&
        observedRequestIds.has(String((data as Record<string, unknown>)['requestId']))
      );
    });
    const responseData = documentResponse?.['data'] as Record<string, unknown> | undefined;
    const requestId = responseData?.['requestId'];
    if (typeof requestId !== 'string') throw new Error('Smoke did not observe the document response ID');
    const responseBody = await call(client, 'network_get_response_body', {
      pageId: createdPageId,
      requestId,
      agentId,
      taskId,
      leaseOwnerId
    });
    if (Number(responseBody['originalBytes']) <= 0) throw new Error('Smoke response body was empty');

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        originalTabCount: beforeIds.length,
        createdPageId,
        observedNetworkEvents: networkItems.length,
        responseBodyBytes: responseBody['originalBytes']
      })}\n`
    );
  } finally {
    if (createdPageId) {
      const result = await client.callTool({
        name: 'close_tab',
        arguments: {
          pageId: createdPageId,
          agentId,
          taskId,
          leaseOwnerId,
          idempotencyKey: `${taskId}-close`
        }
      });
      if (result.isError) process.stderr.write(`Smoke cleanup failed for ${createdPageId}\n`);
    }
    await client.close().catch(() => undefined);
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) {
    throw new Error(
      `${name} failed: ${result.content.map((item) => ('text' in item ? item.text : '')).join(' ')}`
    );
  }
  return result.structuredContent ?? {};
}

function itemArray(value: Record<string, unknown>): Array<Record<string, unknown>> {
  const items = value['items'];
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

function assertLoopback(url: URL): void {
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('Live smoke endpoints must use loopback');
  }
}
