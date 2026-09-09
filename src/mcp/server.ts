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

const locatorShape = {
  uid: z.string().min(1).max(128).optional(),
  selector: z.string().min(1).max(2_000).optional(),
  text: z.string().min(1).max(500).optional(),
  exactText: z.boolean().default(false)
};

const locatorSchema = z
  .object(locatorShape)
  .refine((value) => Boolean(value.uid || value.selector || value.text), 'locator requires uid, selector, or text');

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
        ...locatorShape,
        ...mutationShape
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => {
      if (!args.uid && !args.selector && !args.text) {
        return errorResult(new GatewayError('INVALID_SELECTOR', 'click requires uid, selector, or text'));
      }
      return toolResult(() =>
        gateway.click(
          args.pageId,
          locatorFromArgs(args),
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
        ...locatorShape,
        value: z.string().max(20_000),
        ...mutationShape
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => {
      if (!args.uid && !args.selector) return errorResult(new GatewayError('INVALID_SELECTOR', 'fill requires uid or selector'));
      return toolResult(() => gateway.fill(args.pageId, locatorFromArgs(args), args.value, mutationMetadata(args, session.clientSessionId)));
    }
  );

  server.registerTool(
    'wait_for',
    {
      description: 'Wait for a CSS selector or visible text to appear in an explicit page.',
      inputSchema: {
        pageId: z.string().min(1),
        selector: z.string().min(1).max(2_000).optional(),
        text: z.string().min(1).max(2_000).optional(),
        timeoutMs: z.number().int().min(100).max(60_000).default(15_000)
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      if (!args.selector && !args.text) return errorResult(new GatewayError('INVALID_SELECTOR', 'wait_for requires selector or text'));
      return toolResult(() => gateway.waitFor(args.pageId, { ...(args.selector ? { selector: args.selector } : {}), ...(args.text ? { text: args.text } : {}), timeoutMs: args.timeoutMs }));
    }
  );

  server.registerTool(
    'press_key',
    {
      description: 'Dispatch a key press to the focused element in an explicit page.',
      inputSchema: { pageId: z.string().min(1), key: z.string().min(1).max(100), ...mutationShape },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => toolResult(() => gateway.pressKey(args.pageId, args.key, mutationMetadata(args, session.clientSessionId)))
  );

  server.registerTool(
    'type_text',
    {
      description: 'Insert text into the currently focused element in an explicit page.',
      inputSchema: { pageId: z.string().min(1), text: z.string().max(20_000), ...mutationShape },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => toolResult(() => gateway.typeText(args.pageId, args.text, mutationMetadata(args, session.clientSessionId)))
  );

  server.registerTool(
    'hover',
    {
      description: 'Hover an element using a snapshot uid, CSS selector, or visible text.',
      inputSchema: { pageId: z.string().min(1), ...locatorShape, ...mutationShape },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => toolResult(() => gateway.hover(args.pageId, locatorFromArgs(args), mutationMetadata(args, session.clientSessionId)))
  );

  server.registerTool(
    'click_at',
    {
      description: 'Click at viewport coordinates in an explicit page.',
      inputSchema: { pageId: z.string().min(1), x: z.number().finite(), y: z.number().finite(), ...mutationShape },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => toolResult(() => gateway.clickAt(args.pageId, args.x, args.y, mutationMetadata(args, session.clientSessionId)))
  );

  server.registerTool(
    'drag',
    {
      description: 'Drag from one element to another using snapshot uids, CSS selectors, or visible text.',
      inputSchema: {
        pageId: z.string().min(1),
        from: locatorSchema,
        to: locatorSchema,
        ...mutationShape
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => toolResult(() => gateway.drag(args.pageId, args.from, args.to, mutationMetadata(args, session.clientSessionId)))
  );

  server.registerTool(
    'fill_form',
    {
      description: 'Fill multiple CSS-selected form controls sequentially in one explicit page.',
      inputSchema: {
        pageId: z.string().min(1),
        elements: z.array(z.object({ selector: z.string().min(1).max(2_000), value: z.string().max(20_000) })).min(1).max(100),
        ...mutationShape
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => toolResult(async () => {
      const metadata = mutationMetadata(args, session.clientSessionId);
      const results = [];
      for (const element of args.elements) results.push(await gateway.fill(args.pageId, { selector: element.selector }, element.value, { ...metadata, idempotencyKey: undefined }));
      return { pageId: args.pageId, count: results.length, results };
    })
  );

  server.registerTool(
    'handle_dialog',
    {
      description: 'Accept or dismiss the currently open JavaScript dialog in an explicit page.',
      inputSchema: { pageId: z.string().min(1), accept: z.boolean(), promptText: z.string().max(2_000).optional(), ...mutationShape },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (args) => toolResult(() => gateway.handleDialog(args.pageId, args.accept, args.promptText, mutationMetadata(args, session.clientSessionId)))
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
      description:
        'Capture a PNG or JPEG screenshot of one explicit page. Full page by default; pass `clip` (viewport-relative x/y/width/height) OR an element locator (`selector`/`uid`) to capture only a region.',
      inputSchema: {
        pageId: z.string().min(1),
        format: z.enum(['png', 'jpeg']).default('png'),
        quality: z.number().int().min(0).max(100).optional(),
        clip: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number().positive(),
            height: z.number().positive()
          })
          .optional(),
        selector: z.string().min(1).max(2000).optional(),
        uid: z.string().min(1).max(128).optional()
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ pageId, format, quality, clip, selector, uid }) => {
      try {
        const locator = selector !== undefined || uid !== undefined ? { selector, uid } : undefined;
        const shot = await gateway.screenshot(pageId, { format, quality, clip, locator });
        const summary = { pageId: shot.pageId, mimeType: shot.mimeType, ...(shot.clip ? { clip: shot.clip } : {}) };
        return {
          content: [
            { type: 'image', data: shot.data, mimeType: shot.mimeType },
            { type: 'text', text: JSON.stringify(summary) }
          ],
          structuredContent: summary
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'evaluate',
    {
      description:
        'Run JavaScript in one explicit page and return the (redacted) result. Set write=true for any mutating script (DOM changes, POST, storage writes). A mutating evaluate on a non-local environment (test/ci/qa/staging/prod or any remote host) is BLOCKED unless confirm=true -- ask the user to approve first. Reads are allowed on any environment.',
      inputSchema: {
        pageId: z.string().min(1),
        expression: z.string().min(1).max(20000),
        write: z.boolean().default(false),
        confirm: z.boolean().default(false),
        ...mutationShape
      },
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async (args) =>
      toolResult(() =>
        gateway.evaluate(
          args.pageId,
          args.expression,
          { write: args.write, confirm: args.confirm },
          {
            context: agentContext(args, session.clientSessionId),
            ...(args.leaseId ? { leaseId: args.leaseId } : {}),
            ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {})
          }
        )
      )
  );

  server.registerTool(
    'get_storage',
    {
      description:
        'Read localStorage, sessionStorage and (optionally) cookies for one explicit page. Read-only; output passes through redaction so tokens/secrets are masked. Set includeCookies=true only when cookies are actually needed.',
      inputSchema: {
        pageId: z.string().min(1),
        includeCookies: z.boolean().default(false)
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ pageId, includeCookies }) =>
      toolResult(() => gateway.readStorage(pageId, { cookies: includeCookies }))
  );

  server.registerTool(
    'classify_environment',
    {
      description:
        'Classify one explicit page as local / test / remote / prod for write-safety awareness. Use before a mutating action to decide whether user approval is needed.',
      inputSchema: { pageId: z.string().min(1) },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ pageId }) => toolResult(() => gateway.classifyPage(pageId))
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

function locatorFromArgs(value: {
  uid?: string;
  selector?: string;
  text?: string;
  exactText?: boolean;
}): { uid?: string; selector?: string; text?: string; exactText?: boolean } {
  return {
    ...(value.uid ? { uid: value.uid } : {}),
    ...(value.selector ? { selector: value.selector } : {}),
    ...(value.text ? { text: value.text } : {}),
    ...(value.exactText ? { exactText: true } : {})
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
