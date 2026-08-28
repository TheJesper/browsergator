import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { redact } from './redaction.js';

export interface AuditEvent {
  action: string;
  outcome: 'success' | 'error';
  agentId?: string;
  taskId?: string;
  leaseOwnerId?: string;
  clientSessionId?: string;
  correlationId?: string;
  pageId?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

export class JsonlAuditLog implements AuditSink {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  write(event: AuditEvent): Promise<void> {
    const line = `${JSON.stringify(redact({ timestamp: new Date().toISOString(), ...event }))}\n`;
    const write = this.tail.then(() => appendFile(this.filePath, line, 'utf8'));
    this.tail = write.catch(() => undefined);
    return write;
  }
}

export class MemoryAuditLog implements AuditSink {
  readonly events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(redact(event));
  }
}
