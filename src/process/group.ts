import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { GroupPlatform } from './group-platform.ts';
import { ProcessTeardownError } from './types.ts';

const ANCHOR_MS = 20_000;
const TEARDOWN_MS = 2_000;
const POLL_MS = 10;

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface PreparedChild<Child extends ChildProcess> {
  child: Child;
  exited: Promise<ChildExit>;
}

// The supervisor stays alive outside the worker group. Since its own PID names the
// group, that numeric identity cannot be reused before the supervisor exits.
export class OwnedProcessGroup {
  private readonly platform = GroupPlatform.load();
  private readonly id = process.pid;
  private separated = false;

  static parentPid(): number {
    return GroupPlatform.load().parentPid();
  }

  async start<Child extends ChildProcess>(
    spawnWorker: () => Child,
    env: NodeJS.ProcessEnv,
  ): Promise<PreparedChild<Child>> {
    if (this.id <= 1 || this.separated)
      throw new ProcessTeardownError('Invalid process-group owner');

    this.platform.children.prepare();
    const controlGroup = this.platform.currentGroup();
    this.platform.moveTo(0);
    const child = spawnWorker();
    const exited = observeExit(child);
    try {
      await this.separateFromWorker(controlGroup, env);
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        throw new ProcessTeardownError('Worker exited during startup');
      return { child, exited };
    } catch (error) {
      // The worker waits for a request before it can run the workload.
      child.kill('SIGKILL');
      await within(exited, TEARDOWN_MS, 'Worker did not exit after startup failure');
      throw error;
    }
  }

  async stop(exited: Promise<ChildExit>): Promise<void> {
    const currentGroup = this.platform.currentGroup();
    if (!this.separated || currentGroup <= 1 || currentGroup === this.id)
      throw new ProcessTeardownError('Process-group ownership could not be verified');

    signalGroup(this.id, 'SIGKILL');
    const started = performance.now();
    // Let Bun collect the worker's status before waitpid can collect adopted children.
    await within(exited, TEARDOWN_MS, 'Worker did not exit after termination');

    let previousZombies: string | undefined;
    while (performance.now() - started < TEARDOWN_MS) {
      this.platform.children.reap(this.id);
      if (!signalGroup(this.id, 0)) return;

      const zombies = this.platform.children.zombies(this.id);
      if (zombies !== undefined && zombies === previousZombies) return;
      previousZombies = zombies;
      // A fork already in progress during the first signal may have joined the group.
      signalGroup(this.id, 'SIGKILL');
      await delay(POLL_MS);
    }
    throw new ProcessTeardownError('Process group remained after termination');
  }

  private async separateFromWorker(controlGroup: number, env: NodeJS.ProcessEnv): Promise<void> {
    // The original group usually still contains the launcher. If it disappeared
    // during startup, an anchor creates a control group in the same session.
    if (controlGroup > 1 && controlGroup !== this.id && this.platform.tryMoveTo(controlGroup)) {
      this.separated = true;
      return;
    }
    const anchor = spawn(
      process.execPath,
      ['--no-env-file', '--no-install', fileURLToPath(import.meta.url), '--anchor'],
      { env, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const exited = observeExit(anchor);
    try {
      await within(anchorReady(anchor, exited), ANCHOR_MS, 'Process-group anchor timed out');
      if (!anchor.pid) throw new ProcessTeardownError('Missing process-group anchor');
      this.platform.moveTo(anchor.pid);
      this.separated = true;
    } finally {
      anchor.kill('SIGKILL');
      anchor.stdout.destroy();
    }
  }
}

function observeExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
}

function anchorReady(child: ChildProcess, exited: Promise<ChildExit>): Promise<void> {
  return new Promise((resolve, reject) => {
    let text = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text === 'ready\n') resolve();
      else if (text.length >= 6) reject(new ProcessTeardownError('Invalid anchor response'));
    });
    void exited.then(() => reject(new ProcessTeardownError('Process-group anchor exited')));
  });
}

function signalGroup(group: number, signal: 'SIGKILL' | 0): boolean {
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // Darwin can transiently return EPERM while a group member exits. Keep checking.
    if (code === 'EPERM') return true;
    throw new ProcessTeardownError('Cannot verify process-group termination');
  }
}

async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProcessTeardownError(message)), ms);
    });
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main && process.argv[2] === '--anchor') {
  GroupPlatform.load().moveTo(0);
  process.stdout.write('ready\n');
  setTimeout(() => process.exit(0), ANCHOR_MS);
}
