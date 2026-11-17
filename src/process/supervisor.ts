import { spawn } from 'node:child_process';
import { closeSync, readSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OwnedProcessGroup } from './group.ts';
import type { SupervisedOutcome } from './types.ts';

// Descriptor 3 belongs to the launch handshake in the worker and to the result
// channel in the supervisor. The workload inherits neither channel.
const ENTRY = fileURLToPath(import.meta.url);
const BUN = [process.execPath, '--no-env-file', '--no-install', ENTRY];

export function supervisorCommand(command: string[]): string[] {
  return [...BUN, '--supervisor', String(process.pid), ...command];
}

async function supervise(parent: number, command: string[]): Promise<SupervisedOutcome> {
  let cancelled = false;
  let stop: () => void = () => {};
  const cancel = () => {
    cancelled = true;
    stop();
  };
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);

  const group = new OwnedProcessGroup();
  if (OwnedProcessGroup.parentPid() !== parent) return { code: 1, signal: null };

  const { child, exited } = await group.start(
    () =>
      spawn(BUN[0]!, [...BUN.slice(1), '--worker', ...command], {
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      }),
    process.env,
  );

  const gate = child.stdio[3]!;
  if (!('end' in gate)) throw new Error('Missing launch handshake');
  let finishCancel!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    finishCancel = resolve;
  });
  stop = finishCancel;
  gate.on('error', cancel);
  const parentWatch = setInterval(() => {
    if (OwnedProcessGroup.parentPid() !== parent) cancel();
  }, 25);
  try {
    if (cancelled || OwnedProcessGroup.parentPid() !== parent) cancel();
    else gate.end(Buffer.of(1));

    const outcome = await Promise.race([exited, cancellation]);
    await group.stop(exited);
    if (outcome?.error) return { error: 'spawn' };
    return outcome ?? { code: 1, signal: null };
  } finally {
    clearInterval(parentWatch);
    gate.destroy();
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
