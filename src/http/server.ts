import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response, NextFunction, Express } from 'express';

import type { GatewayConfig } from '../config.js';
import type { BrowserGateway } from '../gateway.js';
import { log } from '../core/logger.js';
import { createMcpServer, type SessionReference } from '../mcp/server.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  reference: SessionReference;
}

export class GatewayHttpServer {
  readonly app: Express;
  private readonly sessions = new Map<string, SessionEntry>();
  private server?: Server;

  constructor(
    private readonly gateway: BrowserGateway,
    private readonly config: GatewayConfig
  ) {
    this.app = createMcpExpressApp({ host: config.host });
    this.configureRoutes();
  }

  async listen(port = this.config.port): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('HTTP server is already listening');
    this.server = createServer(this.app);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, this.config.host, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP address');
    return { host: this.config.host, port: address.port };
  }

  async close(): Promise<void> {
    for (const [clientSessionId, entry] of this.sessions) {
      await entry.transport.close().catch(() => undefined);
      await this.gateway.releaseClientSession(clientSessionId);
    }
    this.sessions.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private configureRoutes(): void {
    this.app.use(originValidation);
    this.app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok', service: 'browser-gateway', version: '0.2.0' });
    });
    this.app.get('/readyz', (_req, res) => {
      const connected = this.gateway.driver.status().connected;
      res.status(connected ? 200 : 503).json({ status: connected ? 'ready' : 'not_ready' });
    });
    this.app.get('/status', this.authenticate, (_req, res) => {
      res.json(this.gateway.status());
    });
    this.app.post('/mcp', this.authenticate, (req, res) => void this.handlePost(req, res));
    this.app.get('/mcp', this.authenticate, (req, res) => void this.handleExisting(req, res));
    this.app.delete('/mcp', this.authenticate, (req, res) => void this.handleDelete(req, res));
  }

  private readonly authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const actual = req.header('authorization') ?? '';
    const expected = `Bearer ${this.config.token}`;
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Valid bearer token required' } });
      return;
    }
    next();
  };

  private async handlePost(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = headerValue(req, 'mcp-session-id');
      if (sessionId) {
        const existing = this.sessions.get(sessionId);
        if (!existing) {
          res.status(404).json(jsonRpcError(-32001, 'Session not found'));
          return;
        }
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json(jsonRpcError(-32000, 'Initialization or valid session ID required'));
        return;
      }

      const reference: SessionReference = { clientSessionId: 'initializing' };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          reference.clientSessionId = id;
          this.sessions.set(id, { transport, reference });
        }
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (!id) return;
        this.sessions.delete(id);
        void this.gateway.releaseClientSession(id).catch((error) =>
          log('error', 'Failed to release leases for closed MCP client session', {
            clientSessionId: id,
            error
          })
        );
      };
      const server = createMcpServer(this.gateway, reference);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.handleHttpError(res, error);
    }
  }

  private async handleExisting(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = headerValue(req, 'mcp-session-id');
      const entry = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!sessionId || !entry) {
        res.status(sessionId ? 404 : 400).send('Invalid or missing session ID');
        return;
      }
      await entry.transport.handleRequest(req, res);
    } catch (error) {
      this.handleHttpError(res, error);
    }
  }

  private async handleDelete(req: Request, res: Response): Promise<void> {
    const sessionId = headerValue(req, 'mcp-session-id');
    const entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!sessionId || !entry) {
      res.status(sessionId ? 404 : 400).send('Invalid or missing session ID');
      return;
    }
    try {
      await entry.transport.handleRequest(req, res);
      this.sessions.delete(sessionId);
      await this.gateway.releaseClientSession(sessionId);
    } catch (error) {
      this.handleHttpError(res, error);
    }
  }

  private handleHttpError(res: Response, error: unknown): void {
    log('error', 'MCP HTTP handler failed', { error });
    if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
  }
}

function originValidation(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  if (!origin) {
    next();
    return;
  }
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) throw new Error('not loopback');
    next();
  } catch {
    res.status(403).json({ error: { code: 'AUTH_REQUIRED', message: 'Origin is not allowed' } });
  }
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}
