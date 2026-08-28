import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { asGatewayError, GatewayError } from '../errors.js';
import type { BrowserGateway, MutationMetadata } from '../gateway.js';
import type { AgentContext, NavigationOptions } from '../types.js';

export interface SessionReference {
  clientSessionId: string;
}

const identityShape = {
  agentId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  leaseOwnerId: z.string().min(1).max(256),
  correlationId: z.string().min(1).max(256).optional()
};

const mutationShape = {
  ...identityShape,
  leaseId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(256).optional()
};

export function createMcpServer(gateway: BrowserGateway, session: SessionReference): McpServer {
  const server = new McpServer(
    { name: 'browser-gateway', version: '0.2.0' },
    {
      instructions:
        'Use an explicit pageId for every page-scoped operation. For every coordinated or audited operation, pass agentId, taskId, and leaseOwnerId; these identify the logical caller independently of the MCP client session. A single MCP client may contain multiple subagents. Never infer a current tab. Prefer run_atomic for short mutations and release explicit leases promptly.'
    }
  );

  server.registerTool(
    'list_tabs',
    {
      description: 'List Chrome page targets. Page-specific operations must use the returned explicit pageId.',
      inputSchema: { agentId: z.string().min(1).max(128).optional() },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ agentId }) => toolResult(() => gateway.listTabs(agentId))
  );

  server.registerTool(
    'open_tab',
    {
      description: 'Open a new Chrome tab without reusing or navigating an existing tab.',
      inputSchema: { url: z.string().url(), ...mutationShape },
      annotations: { destructiveHint: false, idempotentHint: true }
    },
    async (args) =>
      toolResult(() => gateway.openTab(args.url, mutationMetadata(args, session.clientSessionId)))
  );

  server.registerTool(
    'close_tab',
    {
      description: 'Close one explicit page through its per-tab FIFO queue.',
      inputSchema: { pageId: z.string().min(1), ...mutationShape },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) =>
      toolResult(() => gateway.closeTab(args.pageId, mutationMetadata(args, session.clientSessionId)))
  );

  server.registerTool(
    'navigate',
    {
      description: 'Navigate one explicit page. Mutations for the page are FIFO serialized.',
      inputSchema: {
        pageId: z.string().min(1),
        url: z.string().url(),
        waitUntil: z.enum(['none', 'domcontentloaded', 'load', 'networkidle']).default('load'),
        timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
        ...mutationShape
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) =>
      toolResult(() =>
        gateway.navigate(
          args.pageId,
          args.url,
          { waitUntil: args.waitUntil as NavigationOptions['waitUntil'], timeoutMs: args.timeoutMs },
          mutationMetadata(args, session.clientSessionId)
        )
      )
  );

  server.registerTool(
    'click',
    {
      description:
        'Click one element in an explicit page. Locate it with a CSS selector, optionally narrowed by visible text.',
      inputSchema: {
        pageId: z.string().min(1),
        selector: z.string().min(1).max(2_000).optional(),
        text: z.string().min(1).max(500).optional(),
        exactText: z.boolean().default(false),
        ...mutationShape
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => {
      if (!args.selector && !args.text) {
        return errorResult(new GatewayError('INVALID_SELECTOR', 'click requires selector or text'));
      }
      return toolResult(() =>
        gateway.click(
          args.pageId,
          {
            ...(args.selector ? { selector: args.selector } : {}),
            ...(args.text ? { text: args.text } : {}),
            ...(args.exactText ? { exactText: true } : {})
          },
          mutationMetadata(args, session.clientSessionId)
        )
      );
    }
  );

  server.registerTool(
    'fill',
    {
      description: 'Fill an input or contenteditable element in an explicit page using a CSS selector.',
      inputSchema: {
        pageId: z.string().min(1),
        selector: z.string().min(1).max(2_000),
        value: z.string().max(20_000),
        ...mutationShape
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) =>
      toolResult(() =>
        gateway.fill(
          args.pageId,
          { selector: args.selector },
          args.value,
          mutationMetadata(args, session.clientSessionId)
        )
      )
  );

  server.registerTool(
    'snapshot',
    {
      description: 'Read a bounded accessibility snapshot from one explicit page.',
      inputSchema: {
        pageId: z.string().min(1),
        maxNodes: z.number().int().min(1).max(5_000).default(1_000)
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ pageId, maxNodes }) => toolResult(() => gateway.snapshot(pageId, maxNodes))
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Capture a PNG or JPEG screenshot of one explicit page.',
      inputSchema: {
        pageId: z.string().min(1),
        format: z.enum(['png', 'jpeg']).default('png'),
        quality: z.number().int().min(0).max(100).optional()
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ pageId, format, quality }) => {
      try {
        const shot = await gateway.screenshot(pageId, format, quality);
        return {
          content: [
            { type: 'image', data: shot.data, mimeType: shot.mimeType },
            { type: 'text', text: JSON.stringify({ pageId: shot.pageId, mimeType: shot.mimeType }) }
          ],
          structuredContent: { pageId: shot.pageId, mimeType: shot.mimeType }
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'console_list',
    {
      description: 'List bounded observed console, log, and exception events for one explicit page.',
      inputSchema: {
        pageId: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100)
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ pageId, limit }) => toolResult(async () => gateway.consoleList(pageId, limit))
  );

  server.registerTool(
    'network_list',
    {
      description: 'List bounded redacted network and WebSocket metadata for one explicit page.',
      inputSchema: {
        pageId: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100)
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ pageId, limit }) => toolResult(async () => gateway.networkList(pageId, limit))
  );

  server.registerTool(
    'network_get_response_body',
    {
      description: 'Get a retained Chrome response body for a request observed on one explicit page.',
      inputSchema: { pageId: z.string().min(1), requestId: z.string().min(1), ...identityShape },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) =>
      toolResult(() =>
        gateway.getResponseBody(args.pageId, args.requestId, agentContext(args, session.clientSessionId))
      )
  );

  server.registerTool(
    'claim_tab',
    {
      description: 'Claim or renew a short runtime lease for one explicit page.',
      inputSchema: {
        pageId: z.string().min(1),
        ttlMs: z.number().int().min(100).max(gateway.config.maxLeaseTtlMs).optional(),
        ...identityShape
      },
      annotations: { destructiveHint: false, idempotentHint: false }
    },
    async (args) =>
      toolResult(() =>
        gateway.claimTab(args.pageId, agentContext(args, session.clientSessionId), args.ttlMs)
      )
  );

  server.registerTool(
    'release_tab',
    {
      description: 'Release a matching runtime lease for one explicit page.',
      inputSchema: { pageId: z.string().min(1), leaseId: z.string().uuid(), ...identityShape },
      annotations: { destructiveHint: false, idempotentHint: false }
    },
    async (args) =>
      toolResult(() =>
        gateway.releaseTab(
          args.pageId,
          args.leaseId,
          agentContext(args, session.clientSessionId)
        )
      )
  );

  server.registerTool(
    'run_atomic',
    {
      description: 'Atomically claim, policy-check, navigate, verify, and release within one page FIFO slot.',
      inputSchema: {
        pageId: z.string().min(1),
        idempotencyKey: z.string().min(1).max(256),
        leaseTtlMs: z.number().int().min(100).max(gateway.config.maxLeaseTtlMs).optional(),
        action: z.object({
          type: z.literal('navigate'),
          url: z.string().url(),
          waitUntil: z.enum(['none', 'domcontentloaded', 'load', 'networkidle']).default('load'),
          timeoutMs: z.number().int().min(100).max(60_000).default(15_000)
        }),
        verify: z
          .object({
            urlContains: z.string().optional(),
            titleContains: z.string().optional()
          })
          .optional(),
        ...identityShape
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) =>
      toolResult(() =>
        gateway.runAtomic({
          pageId: args.pageId,
          context: agentContext(args, session.clientSessionId),
          idempotencyKey: args.idempotencyKey,
          ...(args.leaseTtlMs === undefined ? {} : { leaseTtlMs: args.leaseTtlMs }),
          action: args.action,
          ...(args.verify === undefined ? {} : { verify: args.verify })
        })
      )
  );

  return server;
}

function agentContext(
  value: { agentId: string; taskId: string; leaseOwnerId: string; correlationId?: string },
  clientSessionId: string
): AgentContext {
  return {
    agentId: value.agentId,
    taskId: value.taskId,
    leaseOwnerId: value.leaseOwnerId,
    clientSessionId,
    ...(value.correlationId ? { correlationId: value.correlationId } : {})
  };
}

function mutationMetadata(
  value: {
    agentId: string;
    taskId: string;
    leaseOwnerId: string;
    correlationId?: string;
    leaseId?: string;
    idempotencyKey?: string;
  },
  clientSessionId: string
): MutationMetadata {
  return {
    context: agentContext(value, clientSessionId),
    ...(value.leaseId ? { leaseId: value.leaseId } : {}),
    ...(value.idempotencyKey ? { idempotencyKey: value.idempotencyKey } : {})
  };
}

async function toolResult(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await operation();
    const structuredContent = normalizeStructured(value);
    return {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      ...(structuredContent ? { structuredContent } : {})
    };
  } catch (error) {
    return errorResult(error);
  }
}

function errorResult(error: unknown): CallToolResult {
  const normalized = asGatewayError(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(normalized.toJSON()) }],
    structuredContent: { error: normalized.toJSON() }
  };
}

function normalizeStructured(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return { items: value };
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return value === undefined ? undefined : { value };
}
