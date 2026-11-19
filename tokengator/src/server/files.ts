// Reading and replacing small files in a way that survives what Windows tools do to them.

import { rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Text from a file's bytes, whatever wrote it: UTF-8 with or without a byte-order mark, or UTF-16 with
 * one. Windows PowerShell 5.1 writes UTF-16 when output is redirected with `>`, and Notepad can add a
 * mark to UTF-8; read as plain UTF-8, either makes a good file look corrupt.
 */
export function decodeText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Big-endian has no decoder of its own here: swap each pair of bytes on a copy and read it as little-endian.
    const even = buffer.subarray(2, 2 + ((buffer.length - 2) & ~1));
    return Buffer.from(even).swap16().toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  return buffer.toString('utf8');
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Writes `text` to `file` by way of a temporary file and a rename, so a reader never sees half of it.
 * On Windows a rename can fail for a moment while an indexer, a virus scanner or another process has
 * the target open, so it is tried again a few times before giving up.
 */
export async function replaceFile(file: string, text: string, suffix: string): Promise<void> {
  const temp = `${file}.${suffix}.tmp`;
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 8 || !BUSY.has(code)) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      await sleep(20 * (attempt + 1));
    }
  }
}
