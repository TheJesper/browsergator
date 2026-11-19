// What a command may touch. Commands never reach for `process` themselves, so a test can hand them
// buffers and a temporary home and run them in-process.

import { decodeText } from '../server/files.js';

export interface Writer {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
  getColorDepth?: (env?: NodeJS.ProcessEnv) => number;
}

export type Reader = NodeJS.ReadableStream & { isTTY?: boolean; unref?: () => unknown };

export interface Io {
  stdout: Writer;
  stderr: Writer;
  stdin: Reader;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface ReadLimits {
  maxBytes: number;
  /** Give up waiting for the end of input after this long. Omitted means wait for it. */
  timeoutMs?: number;
}

export interface ReadResult {
  text: string;
  /** False when the size limit or the time limit cut the input short. */
  complete: boolean;
}

/**
 * Reads a stream to its end, within limits. Never rejects: a stream that errors, never ends or sends
 * too much resolves with what arrived so far and `complete: false`. A terminal is not read at all,
 * because nobody is going to type the input a pipe was expected to deliver.
 */
export function readAll(stream: Reader, limits: ReadLimits): Promise<ReadResult> {
  return new Promise((resolve) => {
    if (stream.isTTY) {
      resolve({ text: '', complete: true });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (complete: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
      if (!complete) {
        // Whoever is still writing must not keep the process alive after we have stopped listening.
        stream.pause();
        stream.unref?.();
      }
      resolve({ text: decodeText(Buffer.concat(chunks)), complete });
    };
    const onData = (chunk: string | Uint8Array): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      size += buffer.length;
      if (size > limits.maxBytes) {
        finish(false);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => finish(true);
    const onError = (): void => finish(false);

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onError);
    if (limits.timeoutMs !== undefined) timer = setTimeout(() => finish(false), limits.timeoutMs);
  });
}
