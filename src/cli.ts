#!/usr/bin/env -S bun --no-env-file --no-install
import { EventEmitter } from 'node:events';

import { Run } from './runner/index.ts';

const controller = new AbortController();
const interrupt = (): void => controller.abort();

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

try {
  process.exitCode = await new Run().execute(process.argv.slice(2), controller.signal);
} finally {
  // Bun's process declarations narrow removal overloads; use the base emitter.
  EventEmitter.prototype.removeListener.call(process, 'SIGINT', interrupt);
  EventEmitter.prototype.removeListener.call(process, 'SIGTERM', interrupt);
}
