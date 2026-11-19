#!/usr/bin/env node
// Entry point of the `tokengator` command. Everything it does lives in commands.ts; this file only
// connects that to the real process.

import { run } from './commands.js';
import type { Io } from './io.js';

// A reader that goes away early (`tokengator status | head -1`) should end the command quietly, not
// with a stack trace about a broken pipe.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

const io: Io = {
  stdout: process.stdout,
  stderr: process.stderr,
  // Looked up on first use: merely touching process.stdin can keep some commands from exiting.
  get stdin() {
    return process.stdin;
  },
  env: process.env,
  cwd: process.cwd()
};

/**
 * Ends the process once both output streams have drained. Waiting for the event loop to empty instead
 * would hang on handles a finished command no longer cares about, such as a caller that never closes
 * the pipe to our standard input.
 */
function exitWhenFlushed(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
  setTimeout(() => process.exit(code), 2000).unref();
}

run(process.argv.slice(2), io).then(exitWhenFlushed, (error: unknown) => {
  // run() reports its own failures; this is only reached when reporting itself failed.
  process.stderr.write(`${error instanceof Error ? error.name : 'Error'}: tokengator stopped unexpectedly.\n`);
  exitWhenFlushed(1);
});
