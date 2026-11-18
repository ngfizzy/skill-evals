import { spawn } from 'node:child_process';
import { closeSync, readSync, writeSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { ProcessGuardian } from './guardian.ts';
import type { SupervisedOutcome } from './types.ts';

// Descriptor 3 belongs to the launch handshake in the worker and to the result
// channel in the supervisor. The workload inherits neither channel.
const ENTRY = fileURLToPath(import.meta.url);
const BUN = [process.execPath, '--no-env-file', '--no-install', ENTRY];

export function supervisorCommand(command: string[]): string[] {
  return [...BUN, '--supervisor', String(process.pid), ...command];
}

async function supervise(parent: number, command: string[]): Promise<SupervisedOutcome> {
  const guardian = new ProcessGuardian(parent);
  const cancel = () => guardian.stop();

  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);

  let gate: Writable | undefined;
  try {
    const { exit } = await guardian.run({
      env: process.env,
      spawn: () =>
        spawn(BUN[0]!, [...BUN.slice(1), '--worker', ...command], {
          stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
        }),
      authorize(child) {
        const handshake = child.stdio[3];

        if (!handshake || !('end' in handshake)) throw new Error('Missing launch handshake');

        gate = handshake;
        gate.on('error', cancel);
        gate.end(Buffer.of(1));
      },
    });

    if (exit?.error) return { error: 'spawn' };
    return exit ?? { code: 1, signal: null };
  } finally {
    gate?.destroy();
  }
}

function execute(command: string[]): never {
  const gate = Buffer.alloc(1);
  if (readSync(3, gate) !== 1 || gate[0] !== 1) process.exit(1);

  closeSync(3);

  const executable = Bun.which(command[0]!, {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    cwd: process.cwd(),
  });

  if (!executable) throw new Error('Executable not found');

  process.execve?.(executable, command, process.env);
  throw new Error('Executable could not start');
}

if (import.meta.main) {
  if (process.argv[2] === '--worker') {
    try {
      execute(process.argv.slice(3));
    } catch {
      writeSync(2, 'Agent process error: executable could not start\n');
      process.exit(127);
    }
  }

  if (process.argv[2] === '--supervisor') {
    let outcome: SupervisedOutcome;
    try {
      outcome = await supervise(Number(process.argv[3]), process.argv.slice(4));
    } catch {
      outcome = { error: 'teardown' };
    }

    writeSync(3, JSON.stringify(outcome));
    process.exit(0);
  }
}
