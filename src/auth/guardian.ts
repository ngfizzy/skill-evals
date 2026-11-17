import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { MAX_OUTPUT, ProcessManager } from '../process/index.ts';

import { launcherEnvironment } from './context.ts';
import { AuthCleanup } from './cleanup.ts';
import { AuthError } from './errors.ts';
import { LauncherEventReader } from './events.ts';
import { Libc } from './libc.ts';
import { authRequestSchema, serializeAuthEvent } from './protocol.ts';
import type { AuthEvent, AuthLauncherRequest } from './types.ts';

export class CleanupGuardian {
  static async run(
    request: AuthLauncherRequest,
    lockFd: number,
    emit: (event: AuthEvent) => void,
  ): Promise<void> {
    await AuthCleanup.prepareGuardian(request.store, request.workspace);
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '--no-install',
        fileURLToPath(import.meta.url),
        JSON.stringify(request),
        String(process.pid),
      ],
      {
        detached: false,
        env: launcherEnvironment(request.workspace),
        stdio: ['ignore', 'pipe', 'ignore', lockFd],
      },
    );
    const events = new LauncherEventReader(emit);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => reject(new AuthError('cleanup-required')));
        child.stdout!.on('data', (chunk: Buffer) => {
          try {
            events.consume(chunk);
          } catch (error) {
            reject(error);
          }
        });
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(events.failure ?? new AuthError('operation-failed'));
        });
      });
      events.finalState();
    } finally {
      // On transport failure, let the guardian observe our exit and stop its own worker group.
      // Never kill the keeper and drop its descriptor before its writers are stopped.
      child.stdout!.destroy();
      child.unref();
    }
  }
}

// The guardian's live PID reserves the worker group's ID even after its workers exit. It moves
// into a separate control group before authenticated work begins, so killing its own PID-named
// group cannot kill the guardian or a group that reused a dead launcher's PID.
class GuardianRun {
  private readonly libc = Libc.load();
  private worker: ChildProcess | undefined;
  private anchor: ChildProcess | undefined;
  private separated = false;
  private stopping = false;
  private result: number | undefined;
  private events: LauncherEventReader | undefined;
  private workerClosed: Promise<void> | undefined;
  private parentPoll: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly request: AuthLauncherRequest,
    private readonly launcher: number,
  ) {}

  async start(): Promise<void> {
    try {
      if (this.libc.parentProcessId() !== this.launcher) throw new AuthError('cleanup-required');
      await AuthCleanup.claim(this.request.store, this.request.workspace);
      this.libc.moveToGroup(0);
      this.worker = spawn(
        process.execPath,
        ['--no-env-file', '--no-install', fileURLToPath(new URL('./worker.ts', import.meta.url))],
        {
          env: launcherEnvironment(this.request.workspace),
          stdio: ['pipe', 'pipe', 'ignore', 3],
        },
      );
      const worker = this.worker;
      this.workerClosed = new Promise<void>((resolve) => {
        worker.once('close', () => resolve());
        worker.once('error', () => resolve());
      });
      let startupFailed = false;
      this.worker.once('error', () => {
        startupFailed = true;
      });

      this.anchor = spawn(
        process.execPath,
        ['--no-env-file', '--no-install', fileURLToPath(import.meta.url), '--anchor'],
        { env: launcherEnvironment(this.request.workspace), stdio: ['ignore', 'pipe', 'ignore'] },
      );
      await waitForAnchor(this.anchor);
      if (!this.anchor.pid || startupFailed || this.worker.exitCode !== null)
        throw new AuthError('cleanup-required');
      this.libc.moveToGroup(this.anchor.pid);
      if (this.libc.processGroupId() === process.pid) throw new AuthError('cleanup-required');
      this.separated = true;
      this.anchor.kill('SIGKILL');
      this.anchor.stdout!.destroy();

      let bytes = 0;
      this.events = new LauncherEventReader((event) => {
        process.stdout.write(serializeAuthEvent(event));
        if (event.type === 'state') void this.stop(0);
        if (event.type === 'error') void this.stop(2);
      });
      this.worker.stdout!.on('data', (chunk: Buffer) => {
        try {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT) throw new AuthError('operation-failed');
          this.events!.consume(chunk);
        } catch {
          void this.stop(2);
        }
      });
      this.worker.once('error', () => void this.stop(2));
      this.worker.once('exit', (code) => {
        if (!this.stopping) void this.stop(code ?? 2);
      });
      this.deadline = setTimeout(() => void this.stop(2), this.request.timeoutMs + 25_000);
      this.parentPoll = setInterval(() => {
        if (this.libc.parentProcessId() !== this.launcher) void this.stop(2);
      }, 25);
      this.worker.stdin!.on('error', () => void this.stop(2));
      this.worker.stdin!.end(JSON.stringify(this.request));
    } catch {
      if (this.separated) {
        await this.stop(2);
        return;
      }
      this.worker?.kill('SIGKILL');
      this.anchor?.kill('SIGKILL');
      process.stdout.write(serializeAuthEvent({ type: 'error', code: 'cleanup-required' }));
      // No request was delivered to the worker before group separation. Retain the lease if
      // even startup cleanup cannot be verified.
      while (true) {
        try {
          await AuthCleanup.finishGuardian(this.request.store, this.request.workspace);
          process.exit(2);
        } catch {
          await delay(250);
        }
      }
    }
  }

  private async stop(code: number): Promise<void> {
    if (this.result === undefined) this.result = code;
    else if (code !== 0) this.result = 2;
    if (this.stopping) return;
    this.stopping = true;
    if (this.parentPoll) clearInterval(this.parentPoll);
    if (this.deadline) clearTimeout(this.deadline);
    let reported = false;
    while (true) {
      try {
        if (!this.separated || this.libc.processGroupId() === process.pid)
          throw new AuthError('cleanup-required');
        try {
          process.kill(-process.pid, 'SIGKILL');
        } catch (error) {
          if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
        }
        await ProcessManager.waitForGroupExit(process.pid);
        await this.workerClosed;
        if (this.result === 0) {
          try {
            this.events!.finalState();
          } catch {
            this.result = 2;
          }
        }
        await AuthCleanup.finishGuardian(this.request.store, this.request.workspace);
        process.exit(this.result ?? 2);
      } catch {
        if (!reported) {
          process.stdout.write(serializeAuthEvent({ type: 'error', code: 'cleanup-required' }));
          reported = true;
        }
        await delay(250);
      }
    }
  }
}

async function waitForAnchor(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new AuthError('cleanup-required')), 20_000);
    let text = '';
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.once('error', () => finish(new AuthError('cleanup-required')));
    child.once('exit', () => finish(new AuthError('cleanup-required')));
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text === 'ready\n') finish();
      else if (text.length > 6) finish(new AuthError('cleanup-required'));
    });
  });
}

if (import.meta.main) {
  process.stdout.on('error', () => {});
  if (process.argv[2] === '--anchor') {
    Libc.load().moveToGroup(0);
    process.stdout.write('ready\n');
    setTimeout(() => process.exit(0), 20_000);
  } else {
    const request = authRequestSchema.parse(JSON.parse(process.argv[2]!));
    const launcher = Number(process.argv[3]);
    if (!Number.isSafeInteger(launcher) || launcher <= 1) throw new AuthError('operation-failed');
    await new GuardianRun(request, launcher).start();
  }
}
